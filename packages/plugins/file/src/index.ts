/**
 * @kiko-workbench/plugin-file —— File 内置插件（设计文档 8.6 / 7.4.3）
 *
 * 能力清单：
 *   - file.read  —— 读文件（沙箱：系统文档目录内）
 *                   输入 { path } → 输出 { content, size }
 *   - file.write —— 写文件（沙箱：工作空间内任意子目录；显式路径 =
 *                   覆盖语义，不自动改名，经 ctx.artifacts.register 登记）
 *                   输入 { path, content } → 输出 { path, size }
 *   - file.list  —— 列目录（沙箱：系统文档目录内，支持 recursive）
 *                   输入 { path?, recursive? } → 输出 { entries: [{ name, is_dir, size }] }
 *
 * 沙箱规则（7.4.3）：路径校验统一走 plugin-sdk 的 resolveSafe
 * （越界抛 50001，经 host 透传），插件自身不拼接路径。
 * 插件只依赖 plugin-sdk（第 4 节依赖约束），零 electron / core。
 */
import { basename, dirname, relative, sep } from "node:path";
import * as nodeFs from "node:fs/promises";
import type { Dirent } from "node:fs";
import {
  ERROR_CODES,
  RpcError,
  resolveSafe,
  type InvocationContext,
  type KikoPlugin,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/** file.read / file.list 输入形状 */
interface ReadInput {
  path: string;
}

/** file.write 输入形状 */
interface WriteInput {
  path: string;
  content: string;
}

/** file.list 输入形状（path 缺省列文档目录根） */
interface ListInput {
  path?: string;
  recursive?: boolean;
}

/** IO 异常 → RpcError(50001)（文件不存在 / 目录不存在 / 权限等） */
function toIoError(e: unknown, action: string): RpcError {
  // Node IO 异常带 code（ENOENT / ENOTDIR / EACCES…）；其余保底字符串化
  const detail = e instanceof Error ? `${e.message}` : String(e);
  return new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `${action}失败：${detail}`);
}

/** 扩展名 → MIME 类型映射（M1 简化；未命中回落 octet-stream） */
const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** 按扩展名推断 MIME（file.write 登记产物用） */
function mimeTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream"; // 无扩展名或点开头文件
  return MIME_BY_EXT[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/** 相对路径统一正斜杠输出（跨平台一致的协议字段，与 ArtifactInfo 对齐） */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * File 插件工厂：返回全新 KikoPlugin 实例（内部状态闭包隔离）。
 * host 经 manifest.entry 动态加载 default 导出（单例，每进程一次 setup）；
 * 单测可调工厂取干净实例（免受模块级状态污染）。
 */
export function createFilePlugin(): KikoPlugin {
  /** 宿主注入的初始化上下文（setup 后可用） */
  let pluginCtx: PluginContext | undefined;
  return {
    /** load 后调用一次：保存沙箱基座（7.4.3 读=文档目录、写=工作空间） */
    async setup(ctx: PluginContext): Promise<void> {
      pluginCtx = ctx;
    },

    /** 能力执行入口：按 capabilityId 分发三能力 */
    async handle(capabilityId: string, input: unknown, ctx: InvocationContext): Promise<unknown> {
      if (pluginCtx === undefined) {
        // 防御：未经 setup 即 invoke 属 host 协议违例（正常链路不可达）
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "file 插件未初始化（setup 未调用）");
      }
      switch (capabilityId) {
        case "file.read":
          return readFile(pluginCtx, input as ReadInput);
        case "file.write":
          return writeFile(pluginCtx, input as WriteInput, ctx);
        case "file.list":
          return listDir(pluginCtx, input as ListInput);
        default:
          throw new RpcError(
            ERROR_CODES.PLUGIN_EXECUTION_ERROR,
            `file 插件不支持能力：${capabilityId}`,
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// file.read：读文档目录内文件
// ---------------------------------------------------------------------------

async function readFile(ctx: PluginContext, input: ReadInput): Promise<unknown> {
  // 沙箱校验（7.4.3）：越界由 resolveSafe 抛 50001
  const file = resolveSafe(ctx.documentsDir, input.path);
  let stat;
  let content: string;
  try {
    stat = await nodeFs.stat(file);
    // 读目录无意义：明确报错而非抛底层 EISDIR
    if (!stat.isFile()) {
      throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `不是文件：${input.path}`);
    }
    content = await nodeFs.readFile(file, "utf-8");
  } catch (e) {
    // RpcError（目录拒绝 / resolveSafe 语义）直接透传，IO 异常包装 50001
    if (e instanceof RpcError) throw e;
    throw toIoError(e, `读取文件 ${input.path}`);
  }
  return { content, size: stat.size };
}

// ---------------------------------------------------------------------------
// file.write：写工作空间内文件（覆盖语义 + artifacts 登记）
// ---------------------------------------------------------------------------

async function writeFile(
  ctx: PluginContext,
  input: WriteInput,
  invocation: InvocationContext,
): Promise<unknown> {
  // 沙箱校验（7.4.3）：工作空间内任意子目录，越界抛 50001
  const file = resolveSafe(ctx.workspaceRoot, input.path);
  try {
    // 父目录懒创建（写子目录路径如 "file/sub/notes.txt" 时建立目录链）
    await nodeFs.mkdir(dirname(file), { recursive: true });
    await nodeFs.writeFile(file, input.content, "utf-8");
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw toIoError(e, `写入文件 ${input.path}`);
  }
  const size = Buffer.byteLength(input.content, "utf-8");
  const filename = basename(file);
  // 覆盖语义（7.4.2 例外）：显式路径 = 覆盖意图，不自动改名，
  // 但同样登记 artifacts（M1 内存态，经 host artifact 消息上主进程）
  invocation.artifacts.register(file, filename, mimeTypeFor(filename), size);
  return { path: toPosix(relative(ctx.workspaceRoot, file)), size };
}

// ---------------------------------------------------------------------------
// file.list：列文档目录内容
// ---------------------------------------------------------------------------

async function listDir(ctx: PluginContext, input: ListInput): Promise<unknown> {
  // path 缺省列文档目录根（"." resolve 后即基座本身）
  const dir = resolveSafe(ctx.documentsDir, input.path ?? ".");
  try {
    const stat = await nodeFs.stat(dir);
    if (!stat.isDirectory()) {
      throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `不是目录：${input.path ?? "."}`);
    }
    // recursive（Node 20+ / Electron 35 内嵌 Node 22 支持）
    const dirents = await nodeFs.readdir(dir, {
      withFileTypes: true,
      recursive: input.recursive === true,
    });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        // name 统一为相对列出根的正斜杠路径：非递归时即条目名（relative
        // 退化为单段），递归时含目录前缀（Agent 可直接定位深层文件）
        const name = toPosix(relative(dir, joinDirent(d)));
        // size：目录固定 0（语义一致性，避免额外 stat 开销按需扩展）
        if (d.isDirectory()) {
          return { name, is_dir: true, size: 0 };
        }
        try {
          const s = await nodeFs.stat(joinDirent(d));
          return { name, is_dir: false, size: s.size };
        } catch {
          // 条目在枚举与 stat 之间消失（并发删改）：按 0 兜底不阻断整列
          return { name, is_dir: false, size: 0 };
        }
      }),
    );
    // 稳定排序：目录在前、同名按字典序（输出确定性，便于 Agent 消费与测试断言）
    entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { entries };
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw toIoError(e, `列出目录 ${input.path ?? "."}`);
  }
}

/** Dirent → 完整路径（Node 20.12+ 提供 parentPath，旧版用 path 字段） */
function joinDirent(d: Dirent & { parentPath?: string }): string {
  const parent = d.parentPath ?? (d as unknown as { path: string }).path;
  return `${parent}${sep}${d.name}`;
}

// host 经 manifest.entry 动态加载：default 导出插件单例
//（CJS 互兼容由 host 的 extractPlugin 处理，ESM 侧直接 default）
export default createFilePlugin();
