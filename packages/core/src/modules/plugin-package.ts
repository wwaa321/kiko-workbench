/**
 * 插件包导入 / 导出（第三方插件管理，纯 Node 无 Electron——对话框等
 * 宿主交互由调用方（desktop ipc.ts）负责，本模块只做可单测的核心逻辑）
 *
 * 职责：
 *   - importPluginFromZip：zip 校验（manifest / 路径穿越 / ID 冲突）→
 *     部署到第三方根 → registry.rescan 生效
 *   - exportPluginToZip：插件目录全量打包为 zip（目录内容置于 zip 根，
 *     manifest.json 在根——与导入解析格式对称）
 *   - rmWithRetry：卸载目录删除（Windows 句柄异步释放的短重试）
 *
 * 安全要点（zip slip 防护）：
 *   - 逐 entry 分段校验相对路径（拒绝空段 / `.` / `..` / 含 `:` 段）
 *   - manifest.id 即部署目录名，按"单段目录名"策略校验（拒绝 `.`/`..`/
 *     路径分隔符/盘符——与 registry 多根扫描"目录名即 id"约定一致）
 *   - ID 冲突在部署前拦截（rescan 对已注册插件是 skipped 语义，冲突
 *     插件无法经 rescan 兜底生效，静默跳过会造成用户困惑）
 */
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { ERROR_CODES, RpcError, type RescanResult } from "@kiko-workbench/protocol";
import type { CapabilityRegistry } from "./registry.js";

/** manifest.json 必填字段的形状（导入侧预检；深度校验由 registry.assertManifest 兜底） */
interface ImportManifest {
  id: string;
  name: string;
  version: string;
}

/** 导入结果（desktop ipc 透传给渲染进程） */
export interface PluginImportOutcome {
  /** 新注册的插件 id（manifest.id） */
  plugin_id: string;
  /** rescan 结果（added 含目标 id 即成功；校验失败直接抛错不会走到这） */
  rescan: RescanResult;
}

/** importPluginFromZip 依赖（registry + 第三方根路径，宿主装配注入） */
export interface PluginPackageDeps {
  registry: CapabilityRegistry;
  /** 第三方插件根目录（部署目标；registry 构造时的 roots[1..] 之一） */
  userPluginsRoot: string;
}

/**
 * zip entry 相对路径单段安全校验（zip slip 防护）：
 * 拒绝空段（绝对路径 / 尾斜杠规整后）、`.` / `..`（目录穿越）、含 `:` 段
 * （Windows 盘符 / NTFS 交替数据流）。与项目"插件目录名单段校验"同一策略。
 */
function isSafeZipSegment(seg: string): boolean {
  return seg !== "" && seg !== "." && seg !== ".." && !seg.includes(":");
}

/**
 * 在 root 下安全拼接 zip entry 相对路径：先分段校验（防穿越），再 resolve。
 * 任一段非法 → -32602（导入包内容非法，属用户可见的参数错误）。
 */
function safeJoinUnder(root: string, rel: string): string {
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => !isSafeZipSegment(s))) {
    throw new RpcError(-32602, `插件包内含非法路径：${rel}`);
  }
  return resolvePath(root, ...segments);
}

/**
 * 定位并解析插件包 manifest.json：
 *   - 优先 zip 根（导出格式：目录内容打包在根，对称）
 *   - 兜底唯一顶层目录（用户手工 zip 插件文件夹的常见形态）
 * 返回 manifest 必填字段 + 顶层前缀（部署时剥离）。
 */
function parseZipManifest(zip: AdmZip): { manifest: ImportManifest; prefix: string } {
  const entries = zip.getEntries();
  const norm = (name: string): string => name.replace(/\\/g, "/");
  let prefix = "";
  let manifestEntry = entries.find((e) => norm(e.entryName) === "manifest.json");

  if (manifestEntry === undefined) {
    // 兜底：全部 entry 共享唯一顶层目录 → manifest 可能在其下
    const topLevel = new Set(
      entries.map((e) => norm(e.entryName).split("/")[0]).filter((s) => s !== ""),
    );
    if (topLevel.size === 1) {
      const only = [...topLevel][0]!;
      prefix = `${only}/`;
      manifestEntry = entries.find((e) => norm(e.entryName) === `${prefix}manifest.json`);
    }
  }
  if (manifestEntry === undefined) {
    throw new RpcError(
      -32602,
      "插件包中未找到 manifest.json（须位于 zip 根或唯一顶层目录下）",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestEntry.getData().toString("utf-8"));
  } catch {
    throw new RpcError(-32602, "manifest.json 解析失败（非法 JSON）");
  }
  const m = parsed as Partial<ImportManifest>;
  if (
    typeof m.id !== "string" ||
    typeof m.name !== "string" ||
    typeof m.version !== "string" ||
    m.id === "" ||
    m.name === "" ||
    m.version === ""
  ) {
    throw new RpcError(-32602, "manifest.json 缺少必填字段：id / name / version（非空字符串）");
  }
  // id 即部署目录名：单段校验（拒绝 `.`/`..`/路径分隔符/盘符，与注册表
  // 扫描约定一致——目录名即 id，越界 id 无法被多根扫描注册）
  if (
    m.id === "." ||
    m.id === ".." ||
    m.id.includes("/") ||
    m.id.includes("\\") ||
    m.id.includes(":")
  ) {
    throw new RpcError(-32602, `manifest.id 不是合法目录名：${m.id}`);
  }
  return { manifest: { id: m.id, name: m.name, version: m.version }, prefix };
}

/**
 * 从 zip 包导入插件：校验（manifest / 路径安全 / ID 冲突）→ 部署到
 * 第三方根 → rescan 生效。失败回滚半部署目录（残留目录会阻塞后续导入）。
 */
export async function importPluginFromZip(
  deps: PluginPackageDeps,
  zipPath: string,
): Promise<PluginImportOutcome> {
  const { registry, userPluginsRoot } = deps;
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    throw new RpcError(
      -32602,
      `插件包读取失败（损坏或非 zip 文件）：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const { manifest, prefix } = parseZipManifest(zip);
  const id = manifest.id;

  // ID 冲突预检：已注册（内置或第三方）即拒绝——rescan 对已注册插件是
  // skipped 语义，冲突必须在部署前拦住（评审确认的"直接拒绝"策略）
  if (registry.getPlugin(id) !== undefined) {
    const origin = registry.getPluginSource(id) === "builtin" ? "内置插件" : "第三方插件";
    throw new RpcError(
      ERROR_CODES.PLUGIN_ID_CONFLICT,
      `插件 ID 冲突：${id} 已作为${origin}注册，请修改插件 id 或先卸载现有插件`,
    );
  }
  const targetDir = join(userPluginsRoot, id);
  // 未注册的同名残留目录（上次部署中断等）会让 rescan 抢注旧内容——拒绝
  if (existsSync(targetDir)) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_ID_CONFLICT,
      `插件目录已存在但未注册：${id}（残留数据），请手动清理后重试`,
    );
  }

  // 逐 entry 部署（路径校验先于写盘；getData 同步取内容，行为可控）
  mkdirSync(targetDir, { recursive: true });
  try {
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, "/");
      if (!name.startsWith(prefix)) continue; // 混入顶层前缀外的 entry（兜底模式下）跳过
      // 剥前缀 + 去尾分隔符（目录 entry 以 / 结尾，规整后为空 = 前缀目录本身）
      const rel = name.slice(prefix.length).replace(/[\\/]+$/, "");
      if (rel === "") continue;
      if (entry.isDirectory) {
        mkdirSync(safeJoinUnder(targetDir, rel), { recursive: true });
        continue;
      }
      const dest = safeJoinUnder(targetDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.getData());
    }
  } catch (e) {
    // 回滚：半部署目录留着会以"未注册残留目录"阻塞同 id 重试
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    if (e instanceof RpcError) throw e;
    throw new RpcError(
      -32603,
      `插件包解压失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // rescan 生效（新增目录 → registerPlugin 全套校验；manifest/capabilities
  // 问题会以 error 态注册——卡片可见失败原因，属可接受的导入结果）
  const rescan = await registry.rescan();
  if (registry.getPlugin(id) === undefined) {
    // 极端竞态（如同名目录并发写入）——不留残留
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    throw new RpcError(-32603, `插件部署完成但注册未生效：${id}`);
  }
  return { plugin_id: id, rescan };
}

/**
 * 导出插件目录为 zip（分享分发用）：目录内容打包到 zip 根
 * （manifest.json 在根——与 importPluginFromZip 解析格式对称）。
 * 写盘失败抛 -32603（调用方转用户可见提示）。
 */
export function exportPluginToZip(sourceDir: string, destPath: string): void {
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(sourceDir);
    zip.writeZip(destPath);
  } catch (e) {
    throw new RpcError(
      -32603,
      `插件导出失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * 递归删除并短重试（卸载插件目录）：
 * Windows 下 utilityProcess kill 后句柄异步释放、杀毒软件扫描锁文件
 * 都会造成瞬时 EPERM——300ms × 3 次重试足够跨过窗口。全部失败返回
 * 最后一个错误（调用方转用户可见提示），成功返回 null。
 */
export async function rmWithRetry(
  dir: string,
  attempts = 3,
  delayMs = 300,
): Promise<Error | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return null;
    } catch (e) {
      if (i === attempts - 1) {
        return e instanceof Error ? e : new Error(String(e));
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null; // 不可达（循环内必 return）
}
