/**
 * CapabilityRegistry（设计文档 6.1）
 *
 * 职责：
 *   - 启动时扫描多个插件根目录（构造注入，core 不碰 Electron 路径），
 *     读取每个子目录的 manifest.json + capabilities.json 完成注册
 *   - 维护插件状态（enabled / disabled / error）与能力索引（id → { plugin, definition }）
 *   - 对外提供 discover(query) / describe(capabilityId) / 插件启停（供 IPC 调用）
 *
 * 多根目录设计（内置 + 第三方分离）：
 *   - 第一个根为内置插件目录（随安装包分发，升级覆盖）；后续根为第三方
 *     插件目录（userData 下，安装器不触碰——覆盖安装不丢用户插件）
 *   - 扫描按根顺序注册，先注册者优先：第三方插件与内置插件 id 冲突时
 *     置 error 状态（防止第三方静默替换内置产品能力，安全考量）
 *
 * 设计要点：
 *   - Registry 只读 JSON（manifest + capabilities），不加载插件 JS 实现——
 *     插件进程加载是 ExecutionRuntime 的职责（6.3），保持 Registry 纯数据可单测
 *   - manifest / capabilities 解析失败或 capability id 冲突 → 插件置 error 状态
 *     （40005 触发场景之一："加载失败"），不阻断其他插件注册
 *   - discover 仅返回 enabled 插件的能力（协议细化，见偏差表 2026-08-19）；
 *     describe / resolve 对 disabled 插件的能力返回 40001（5.5：未注册或已禁用）；
 *     对 error 插件（扫描失败 / 崩溃熔断）返回 40005（5.5：插件不可用，
 *     见偏差表 2026-08-20——M1-05 曾折叠为 40001，M1-09 熔断依赖此区分而拆分）
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, sep } from "node:path";
import {
  ERROR_CODES,
  RpcError,
  type CapabilityDefinition,
  type CapabilitySummary,
  type RescanResult,
} from "@kiko-workbench/protocol";
import {
  assertConfigurationSchema,
  type ConfigurationSchema,
} from "./config-store.js";

/** 插件状态（设计文档 6.1） */
export type PluginStatus = "enabled" | "disabled" | "error";

/** 插件注册记录（Registry 的单一数据源） */
export interface PluginRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  /** 插件实现入口（相对插件目录），供 ExecutionRuntime load 消息使用 */
  entry: string;
  permissions: string[];
  status: PluginStatus;
  /** status === 'error' 时的原因（UI 展示 / 调试） */
  errorReason?: string;
  /** 插件目录绝对路径 */
  rootDir: string;
  /**
   * manifest.contributes.configuration 声明的配置 schema（P-002 Phase 1）。
   * undefined = 插件未声明配置（设置入口不显示、ctx.config 注入 {}）；
   * UI 与 IPC 的唯一 schema 来源（值对象来自 manifest 解析，注册后只读）。
   */
  configSchema?: ConfigurationSchema;
  /**
   * manifest.contributes.ui.entry 声明的前端入口（P-003 v1，相对插件
   * 目录，如 "web/index.html"）。undefined = 非微应用插件（卡片无
   * "打开界面"入口、kiko-plugin:// 协议不为其服务）。注册期已校验
   * 存在性与路径安全（防穿越），宿主可信任该路径落在插件目录内。
   */
  uiEntry?: string;
}

/** manifest.json 形状（设计文档 8.2） */
interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  entry?: string;
  permissions?: string[];
  /**
   * 声明式贡献点（P-002 Phase 1）：configuration 为配置声明（P-002）、
   * ui 为微应用前端入口声明（P-003 v1）。可选——未声明的现有插件零影响。
   */
  contributes?: {
    configuration?: ConfigurationSchema;
    /** 微应用前端声明：entry 为相对插件目录的 HTML 入口路径 */
    ui?: { entry?: unknown };
  };
}

/**
 * contributes.ui.entry 注册期校验（P-003 v1）：
 * 非空字符串 + 相对路径分段安全（拒绝空段 / `.` / `..` / 含 `:` 段——
 * 与 plugin-package 的 zip slip 防护同一策略）+ 文件存在且为常规文件。
 * 校验失败抛普通 Error（registerPlugin 的 catch 统一转插件 error 态）。
 * @returns 校验通过的 entry（回填 PluginRecord.uiEntry）
 */
async function assertUiEntry(rootDir: string, entry: unknown): Promise<string> {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("contributes.ui 声明存在但 entry 缺失或非字符串（须为相对插件目录的 HTML 入口，如 \"web/index.html\"）");
  }
  // 反斜杠统一按分隔符处理（跨平台写入的 manifest 兼容 + 防混用绕过）
  const segments = entry.replace(/\\/g, "/").split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes(":"))) {
    throw new Error(`contributes.ui.entry 非法相对路径（禁止绝对路径 / 穿越段 / 盘符）：${entry}`);
  }
  const target = join(rootDir, ...segments);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`contributes.ui.entry 文件不存在：${entry}（前端资产须随插件目录分发）`);
  }
  if (!info.isFile()) {
    throw new Error(`contributes.ui.entry 不是常规文件：${entry}`);
  }
  return entry;
}

/** 能力索引条目 */
interface CapabilityIndexEntry {
  pluginId: string;
  definition: CapabilityDefinition;
}

/** 能力索引（capability id → 条目） */
type CapabilityIndex = Map<string, CapabilityIndexEntry>;

export class CapabilityRegistry {
  /** 插件记录（id → record） */
  private readonly plugins = new Map<string, PluginRecord>();
  /** 能力索引（capability id → { pluginId, definition }） */
  private readonly capabilities: CapabilityIndex = new Map();

  /** 插件根目录列表（第一个为内置目录——优先级最高，见类注释） */
  private readonly roots: readonly string[];

  /** 进行中的 rescan（重入幂等：并发调用返回同一 promise 的结果） */
  private rescanInFlight: Promise<RescanResult> | null = null;

  /**
   * @param root 第一个插件根目录（内置插件目录，注册优先级最高）
   * @param moreRoots 后续插件根目录（第三方插件目录，按序注册）
   */
  constructor(root: string, ...moreRoots: string[]) {
    this.roots = [root, ...moreRoots];
  }

  /**
   * 扫描全部插件根目录：每个子目录视为一个插件候选，读取 manifest.json +
   * capabilities.json 注册。单个插件解析失败 → 该插件 error 状态，不影响其余。
   * 根目录按构造顺序扫描（内置在前）；某个根不存在则静默跳过
   * （第三方目录首次使用时不存在属正常态）。
   */
  async scan(): Promise<void> {
    for (const pluginsRoot of this.roots) {
      // 目录不存在视为"该根无插件"，不算错误——headless 测试场景 /
      // 第三方目录首次使用前均无此目录
      let entries: Dirent[];
      try {
        entries = await readdir(pluginsRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await this.registerPlugin(join(pluginsRoot, entry.name), entry.name);
      }
    }
  }

  /**
   * 注册单个插件目录：解析 manifest + capabilities，失败置 error。
   * 返回注册进 map 的插件 id（含 error 态）；id 冲突被跳过时返回
   * undefined（rescan 据此区分 added / skipped）。
   */
  private async registerPlugin(rootDir: string, dirName: string): Promise<string | undefined> {
    let pluginId = dirName; // manifest 解析失败时以目录名兜底标识
    try {
      // --- manifest.json 解析（8.2 规范） ---
      const manifest = JSON.parse(
        await readFile(join(rootDir, "manifest.json"), "utf-8"),
      ) as PluginManifest;
      this.assertManifest(manifest);
      pluginId = manifest.id;

      // --- id 冲突检查（多根目录：内置优先，见类注释）---
      // 先注册的插件占用 id；后扫描目录的同 id 插件置 error 而非静默覆盖
      // （第三方不得替换内置产品能力；同目录内重复 id 同样暴露为 error）
      if (this.plugins.has(pluginId)) {
        throw new Error(`插件 id 冲突：${pluginId} 已注册（先注册者优先）`);
      }

      // --- capabilities.json 解析（8.3：CapabilityDefinition[]） ---
      const capabilities = JSON.parse(
        await readFile(join(rootDir, "capabilities.json"), "utf-8"),
      ) as CapabilityDefinition[];
      if (!Array.isArray(capabilities)) {
        throw new Error("capabilities.json 必须为数组");
      }

      // --- contributes.configuration 注册期校验（P-002 Phase 1） ---
      // v1 渲染器能力边界（结构子集检查）：非法 schema → 插件 error 态，
      // 与 manifest 损坏同路径（不影响其余插件）；合法 → 随 record 暴露
      const configSchema = manifest.contributes?.configuration;
      if (configSchema !== undefined) {
        assertConfigurationSchema(configSchema, pluginId);
      }

      // --- contributes.ui 注册期校验（P-003 v1） ---
      // 声明了 ui 但 entry 非法 / 文件缺失 → 插件 error 态（防「声明了
      // 界面却打不开」）；未声明 ui → uiEntry 保持 undefined（非微应用）
      const ui = manifest.contributes?.ui;
      const uiEntry = ui !== undefined ? await assertUiEntry(rootDir, ui.entry) : undefined;

      // --- 逐条校验能力定义并建索引 ---
      for (const definition of capabilities) {
        this.assertCapability(definition);
        // capability id 全局唯一：冲突说明插件间越界注册，拒绝整个插件
        if (this.capabilities.has(definition.id)) {
          throw new Error(`capability id 冲突：${definition.id}`);
        }
      }

      // 全部校验通过才落盘状态（部分注册的中间态不可见）
      this.plugins.set(pluginId, {
        id: pluginId,
        name: manifest.name,
        description: manifest.description ?? "",
        version: manifest.version,
        entry: manifest.entry ?? "index.js",
        permissions: manifest.permissions ?? [],
        status: "enabled",
        rootDir,
        ...(configSchema !== undefined ? { configSchema } : {}),
        ...(uiEntry !== undefined ? { uiEntry } : {}),
      });
      for (const definition of capabilities) {
        this.capabilities.set(definition.id, { pluginId, definition });
      }
      return pluginId;
    } catch (err) {
      // 加载失败：插件置 error（40005 场景），能力不注册，其他插件不受影响。
      // 已占用保护：id 冲突（先注册者优先）时 catch 到达此处，set 会覆盖
      // 已注册的同 id 插件（违背内置优先）——已占用时仅告警不落 error 条目
      const reason = err instanceof Error ? err.message : String(err);
      if (this.plugins.has(pluginId)) {
        console.warn(`[registry] 插件 id 冲突，跳过注册：${rootDir}（${reason}）`);
        return undefined;
      }
      this.plugins.set(pluginId, {
        id: pluginId,
        name: pluginId,
        description: "",
        version: "0.0.0",
        entry: "index.js",
        permissions: [],
        status: "error",
        errorReason: reason,
        rootDir,
      });
      return pluginId;
    }
  }

  /** manifest 必填字段校验（8.2：id / name / version 必填） */
  private assertManifest(manifest: PluginManifest): void {
    if (typeof manifest.id !== "string" || manifest.id.length === 0) {
      throw new Error("manifest.id 必须为非空字符串");
    }
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error("manifest.name 必须为非空字符串");
    }
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
      throw new Error("manifest.version 必须为非空字符串");
    }
  }

  /** 能力定义必填字段校验（7.1 CapabilityDefinition） */
  private assertCapability(definition: CapabilityDefinition): void {
    if (typeof definition.id !== "string" || definition.id.length === 0) {
      throw new Error("capability.id 必须为非空字符串");
    }
    if (typeof definition.name !== "string" || typeof definition.description !== "string") {
      throw new Error(`capability ${definition.id}：name / description 必填`);
    }
    if (
      typeof definition.input_schema !== "object" ||
      definition.input_schema === null ||
      typeof definition.output_schema !== "object" ||
      definition.output_schema === null
    ) {
      throw new Error(`capability ${definition.id}：input_schema / output_schema 必填`);
    }
  }

  // ---------------- discover（5.3.1：分词匹配 + 评分排序） ----------------

  /**
   * 按关键词查询能力摘要。**响应不含 schema**（R4 契约锁定）。
   * query 省略 → 返回全部 enabled 插件的能力摘要；
   * 评分：id 命中 +3 / name 命中 +2 / description 命中 +1，
   * 按 token 累加，得分降序（同分按 id 字典序保证稳定）。
   */
  discover(query?: string): CapabilitySummary[] {
    // 无 query：全量摘要（仅 enabled 插件）
    const candidates = [...this.capabilities.values()]
      .map((entry) => ({
        entry,
        plugin: this.plugins.get(entry.pluginId),
      }))
      .filter(
        (c): c is { entry: CapabilityIndexEntry; plugin: PluginRecord } =>
          c.plugin !== undefined && c.plugin.status === "enabled",
      );
    if (query === undefined || query.trim() === "") {
      return candidates
        .map((c) => this.toSummary(c.entry))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    // 分词：按空白切分 + 小写化（中文无空格，整串即一个 token 走包含匹配）
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const scored = candidates
      .map((c) => ({ summary: this.toSummary(c.entry), definition: c.entry.definition }))
      .map(({ summary, definition }) => ({
        summary,
        score: tokens.reduce((sum, token) => {
          const id = definition.id.toLowerCase();
          const name = definition.name.toLowerCase();
          const desc = definition.description.toLowerCase();
          return (
            sum +
            (id.includes(token) ? 3 : 0) +
            (name.includes(token) ? 2 : 0) +
            (desc.includes(token) ? 1 : 0)
          );
        }, 0),
      }))
      .filter((c) => c.score > 0);

    return scored
      .sort((a, b) => b.score - a.score || a.summary.id.localeCompare(b.summary.id))
      .map((c) => c.summary);
  }

  /** 能力索引条目 → 摘要（只取四字段，schema 绝不外泄） */
  private toSummary(entry: CapabilityIndexEntry): CapabilitySummary {
    return {
      id: entry.definition.id,
      name: entry.definition.name,
      description: entry.definition.description,
      plugin: entry.pluginId,
    };
  }

  // ---------------- describe / resolve ----------------

  /** describe（5.3.2）：返回完整能力定义；未注册或插件禁用 → 40001 */
  describe(capabilityId: string): CapabilityDefinition {
    return this.resolveCapability(capabilityId).definition;
  }

  /**
   * 能力解析（InvocationManager 的 resolve 步骤消费）：
   * 返回 { plugin, definition }。
   * 错误码按 5.5 拆分：未注册 / disabled → 40001；error（熔断 / 加载失败）→ 40005
   */
  resolveCapability(capabilityId: string): {
    plugin: PluginRecord;
    definition: CapabilityDefinition;
  } {
    const entry = this.capabilities.get(capabilityId);
    if (entry === undefined) {
      throw new RpcError(ERROR_CODES.CAPABILITY_NOT_FOUND, `能力不存在：${capabilityId}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    if (plugin === undefined || plugin.status === "disabled") {
      throw new RpcError(
        ERROR_CODES.CAPABILITY_NOT_FOUND,
        `能力不可用（插件 ${entry.pluginId} 处于 ${plugin?.status ?? "未知"} 状态）：${capabilityId}`,
      );
    }
    if (plugin.status === "error") {
      throw new RpcError(
        ERROR_CODES.PLUGIN_UNAVAILABLE,
        `插件 ${entry.pluginId} 处于 error 状态${plugin.errorReason !== undefined ? `（${plugin.errorReason}）` : ""}`,
      );
    }
    return { plugin, definition: entry.definition };
  }

  // ---------------- 插件启停（供 IPC 调用，M2 UI 消费） ----------------

  /**
   * 设置插件状态；error → enabled 即 UI"重新启用"（M2-07）。
   * reason：置 error 时的原因（崩溃熔断 / 加载失败，UI 展示与调试用）；
   * 重新启用时清除（ExecutionRuntime 崩溃计数同理由 runtime.resetPlugin 重置）
   */
  setPluginStatus(pluginId: string, status: PluginStatus, reason?: string): void {
    const plugin = this.plugins.get(pluginId);
    if (plugin === undefined) {
      throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
    }
    plugin.status = status;
    if (status === "enabled") {
      delete plugin.errorReason;
    } else if (reason !== undefined) {
      plugin.errorReason = reason;
    }
  }

  /** 插件列表（UI 插件卡片数据源；含 error 原因） */
  listPlugins(): PluginRecord[] {
    return [...this.plugins.values()].map((p) => ({ ...p }));
  }

  /** 单插件查询（ExecutionRuntime 定位插件目录用） */
  getPlugin(pluginId: string): PluginRecord | undefined {
    const plugin = this.plugins.get(pluginId);
    return plugin ? { ...plugin } : undefined;
  }

  /**
   * 各插件能力数统计（M2-06 IPC workbench:plugin:list 卡片字段）。
   * 与 discover 不同：**不按启停过滤**——能力注册与插件运行态无关，
   * disabled / error 插件的卡片也应展示真实能力数（discover 仅 enabled
   * 是对外协议语义，UI 统计是内部视图语义）。
   */
  capabilityCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.capabilities.values()) {
      counts.set(entry.pluginId, (counts.get(entry.pluginId) ?? 0) + 1);
    }
    return counts;
  }

  // ---------------- rescan（S11：第三方根重扫，零 Shell 自举方案 3.3） ----------------

  /**
   * 重扫第三方插件根（roots[1..]——内置根随安装包不可变，重扫无意义）：
   *   - 新目录 → 注册（复用 registerPlugin 全套校验；error 态也算 added，
   *     失败原因可查插件列表——Agent 能拿到排障线索）
   *   - 磁盘消失的第三方插件 → 卸载（unregister：plugins + capabilities
   *     条目移除；运行中进程由调用方（rpc-router）驱动 runtime dispose）
   *   - 已存在的目录 → skipped（首版不做重载：进程加载的旧代码 vs 磁盘
   *     新代码的竞态留 M3 评估——"已加载插件文件变更，重启生效"）
   *
   * 并发防护：进行中的 rescan 重入返回同一结果（互斥的最简形态）。
   */
  async rescan(): Promise<RescanResult> {
    if (this.rescanInFlight !== null) return this.rescanInFlight;
    const run = this.doRescan();
    this.rescanInFlight = run;
    try {
      return await run;
    } finally {
      this.rescanInFlight = null;
    }
  }

  private async doRescan(): Promise<RescanResult> {
    const added: string[] = [];
    const removed: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    // --- 1. 重扫第三方根：新目录注册，已存在目录跳过 ---
    for (const pluginsRoot of this.roots.slice(1)) {
      let entries: Dirent[];
      try {
        entries = await readdir(pluginsRoot, { withFileTypes: true });
      } catch {
        continue; // 根不存在 = 无第三方插件（与 scan 同语义）
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rootDir = join(pluginsRoot, entry.name);
        // 已注册（无论 enabled / error——error 态 id 即目录名，registerPlugin
        // 约定）→ 跳过不重载（首版诚实最小语义，方案 3.3）
        if (this.plugins.has(entry.name)) {
          skipped.push({
            id: entry.name,
            reason: "已注册插件的文件变更不重载，重启生效",
          });
          continue;
        }
        const registeredId = await this.registerPlugin(rootDir, entry.name);
        if (registeredId !== undefined) {
          // 新注册（含 error 态——manifest 校验失败也进 map，原因可查插件列表）
          added.push(registeredId);
        } else {
          // id 冲突被跳过（registerPlugin 的已占用告警路径）
          skipped.push({ id: entry.name, reason: "id 与已注册插件冲突，先注册者优先" });
        }
      }
    }

    // --- 2. 卸载磁盘消失的第三方插件 ---
    for (const [pluginId, record] of [...this.plugins]) {
      if (!this.isThirdParty(record)) continue; // 内置插件不在 rescan 管辖
      if (existsSync(record.rootDir)) continue; // 磁盘仍在 → 不动
      this.unregisterPlugin(pluginId);
      removed.push(pluginId);
    }
    return { added, removed, skipped };
  }

  /** record 的 rootDir 是否严格落在任一第三方根下（路径分隔符感知，防兄弟目录误判） */
  private isThirdParty(record: PluginRecord): boolean {
    return this.roots
      .slice(1)
      .some((r) => record.rootDir === r || record.rootDir.startsWith(r + sep));
  }

  /**
   * 插件来源（UI 卡片 / 卸载保护用）：
   *   - "builtin"：内置插件（roots[0]，随安装包分发，禁止删除）
   *   - "third_party"：第三方插件（roots[1..]，可导入 / 导出 / 删除）
   *   - undefined：插件不存在
   */
  getPluginSource(pluginId: string): "builtin" | "third_party" | undefined {
    const record = this.plugins.get(pluginId);
    if (record === undefined) return undefined;
    return this.isThirdParty(record) ? "third_party" : "builtin";
  }

  /**
   * 卸载插件（rescan 移除路径）：plugins + capabilities 条目移除。
   * 注意：调用方（rpc-router）负责先驱动 runtime 终止运行中进程——
   * registry 是纯数据层，不触碰进程生命周期（职责分离，6.1）。
   */
  unregisterPlugin(pluginId: string): void {
    const record = this.plugins.get(pluginId);
    if (record === undefined) return; // 幂等
    this.plugins.delete(pluginId);
    for (const [capabilityId, entry] of [...this.capabilities]) {
      if (entry.pluginId === pluginId) this.capabilities.delete(capabilityId);
    }
  }
}
