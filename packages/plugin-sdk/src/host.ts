/**
 * plugin-host 运行时（设计文档 6.3 消息协议 / 8.5 运行时职责 / 7.4 产物管理）
 *
 * 运行位置：Electron utilityProcess 子进程内（M1 阶段同时可在纯 Node 进程内
 * 运行，host 类本身与传输通道解耦——通道抽象为 send 回调 + handleCommand
 * 入口，utilityProcess 接线见 startUtilityProcessHost）。
 *
 * 职责（8.5）：
 *   - 接收 load / invoke / cancel 下行消息 → 动态加载插件 entry →
 *     桥接 InvocationContext 回调为上行消息上报
 *   - ctx.artifacts.save：safeFilename → resolveSafe → nextConflictName
 *     同名改名 → 落盘 → artifact 消息上报（7.4.2）
 *   - 插件内未捕获异常包装为 error 消息（RpcError 透传 code，其余统一
 *     50001），**不允许**导致 host 进程退出
 *
 * 消息协议（6.3，内部协议非对外）：
 *   main → host：load / invoke / cancel（+ shutdown，见偏差表 2026-08-20）
 *   host → main：loaded / load-error / log / progress / artifact / result /
 *                error / cancelled（+ shutdown-complete）
 */
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as nodeFs from "node:fs";
import { ERROR_CODES, RpcError, type ArtifactInfo, type ErrorCode } from "@kiko-workbench/protocol";
import type { InvocationContext, KikoPlugin, PluginContext } from "./types.js";
import { nextConflictName, resolveSafe, safeFilename } from "./paths.js";

// ---------------------------------------------------------------------------
// 消息类型（6.3）
// ---------------------------------------------------------------------------

/** 下行命令（main → host） */
export type HostCommand =
  | {
      /**
       * 加载插件（workspaceRoot 用于产物落盘与路径校验）。
       * documentsDir 为读取沙箱基座（7.4.3 file.read/list 限系统文档目录；
       * M1-09 扩展字段，见偏差表 2026-08-20）。
       * userPluginsRoot 为第三方插件根（S2 扩展字段，见偏差表 2026-09-01：
       * sdk 分发插件 install_guide 需声明部署目标）。
       * esbuildBinaryPath 为 esbuild CLI 二进制（S8 扩展字段，见偏差表
       * 2026-09-01：sdk.build 能力零 shell 构建的执行体）。
       * config 为插件配置值（P-002 Phase 1 扩展字段，见方案草案 §3.4：
       * 已保存值合并 default、未知字段透传；未声明配置的插件为 {}——
       * 主进程读侧容错保证字段始终存在，host 不做二次校验）。
       */
      type: "load";
      manifestPath: string;
      pluginId: string;
      workspaceRoot: string;
      documentsDir: string;
      userPluginsRoot: string;
      esbuildBinaryPath: string;
      config: Record<string, unknown>;
    }
  | { type: "invoke"; invocationId: string; capabilityId: string; input: unknown }
  /** 请求协作取消：置位检查点标志，插件经 ctx.isCancelled() 轮询感知 */
  | { type: "cancel"; invocationId: string }
  /**
   * 进程回收前清理（KikoPlugin.teardown 钩子的触发通道）。
   * 文档 6.3 消息清单未列出，属实现期补充（登记偏差表 2026-08-20）。
   */
  | { type: "shutdown" }
  /**
   * ctx.ui.send 投递回执（P-003 v1）：主进程 runtime 将 ui-send 路由到
   * 微应用窗口（或判定 40010 未打开）后回执。ok=false 时 error 为
   * RpcError 的 code/message（40010 = PLUGIN_UI_NOT_OPEN）。
   */
  | { type: "ui-send-result"; requestId: number; ok: true }
  | { type: "ui-send-result"; requestId: number; ok: false; error: { code: ErrorCode; message: string } };

/** 上行事件（host → main） */
export type HostEvent =
  | { type: "loaded"; capabilities: string[] }
  | { type: "load-error"; message: string }
  | { type: "log"; invocationId: string; message: string }
  | { type: "progress"; invocationId: string; percent: number; message?: string }
  /** 产物登记（ctx.artifacts.save / register 统一走此消息，7.4） */
  | {
      type: "artifact";
      invocationId: string;
      file: string;
      relativePath: string;
      filename: string;
      mimeType: string;
      size: number;
    }
  | { type: "result"; invocationId: string; result: unknown }
  | { type: "error"; invocationId: string; error: { code: number; message: string } }
  /** 协作取消确认：插件在取消检查点后停止 */
  | { type: "cancelled"; invocationId: string }
  /** teardown 钩子执行完毕（尽力而为，失败不阻塞回收；偏差表 2026-08-20） */
  | { type: "shutdown-complete" }
  /**
   * ctx.ui.send 下发请求（P-003 v1）：主进程据 host 进程与插件的绑定
   * 关系路由到对应微应用窗口（host 不重复携带 pluginId），回执见
   * ui-send-result 下行命令。
   */
  | { type: "ui-send"; requestId: number; payload: unknown };

// ---------------------------------------------------------------------------
// 宿主抽象（可注入，供单测替换文件系统与模块加载器）
// ---------------------------------------------------------------------------

/** host 所需的最小文件系统能力（默认 node:fs） */
export interface HostFileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: string | Buffer): void;
  readFileSync(path: string, encoding: "utf8"): string;
}

/** 插件模块加载器（默认按文件 URL 动态 import；单测可注入内存对象） */
export type ModuleLoader = (entryPath: string) => Promise<unknown>;

export interface PluginHostOptions {
  /** 上行消息发送通道（utilityProcess：parentPort.postMessage；测试：数组收集） */
  send: (event: HostEvent) => void;
  /** 文件系统（默认 node:fs；测试注入内存实现） */
  fs?: HostFileSystem;
  /** 模块加载器（默认动态 import；测试注入插件对象） */
  loadModule?: ModuleLoader;
  /**
   * ui.send 投递回执超时（毫秒，P-003 v1）：主进程未在时限内回执时
   * 兜底 reject，防插件 await 永久挂起（默认 10s；测试可注入短值）。
   */
  uiSendTimeoutMs?: number;
}

/** host 消费的 manifest 字段子集（完整规范见 8.2，解析校验归 core Registry） */
interface ManifestLike {
  id: string;
  entry: string;
}

/** capabilities.json 条目子集（host 仅需 id 列表回传 loaded 消息） */
interface CapabilityLike {
  id: string;
}

/** 每个 invocation 的运行时状态（协作取消标志位） */
interface InvocationState {
  cancelled: boolean;
}

/**
 * 从动态 import 的模块对象中提取 KikoPlugin。
 * 兼容 ESM default 导出与 CJS module.exports（import 包装后落 default）。
 * 无 handle 函数 → 抛错（load-error 路径）。
 */
function extractPlugin(mod: unknown): KikoPlugin {
  const candidate = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as Partial<KikoPlugin>).handle !== "function"
  ) {
    throw new Error("插件 entry 未导出符合 KikoPlugin 接口的对象（缺少 handle 函数）");
  }
  return candidate as KikoPlugin;
}

/** 插件异常 → error 消息的 code/message：RpcError 透传，其余统一 50001（8.5） */
function toEventError(e: unknown): { code: number; message: string } {
  if (e instanceof RpcError) {
    return { code: e.code, message: e.message };
  }
  return {
    code: ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    message: e instanceof Error ? e.message : String(e),
  };
}

// ---------------------------------------------------------------------------
// PluginHost
// ---------------------------------------------------------------------------

export class PluginHost {
  private readonly sendChannel: (event: HostEvent) => void;
  private readonly fs: HostFileSystem;
  private readonly loadModule: ModuleLoader;

  /** 已加载插件（load 成功后非空） */
  private plugin: KikoPlugin | undefined;
  private pluginId = "";
  private workspaceRoot = "";

  /** 运行中 invocation 的取消标志（settle 后清除） */
  private readonly invocations = new Map<string, InvocationState>();
  /** 在途执行 Promise（idle 等待与 shutdown 排空用） */
  private readonly pending = new Set<Promise<void>>();

  /** 在途 ui.send 投递（requestId → settle 回调 + 超时定时器；P-003 v1） */
  private readonly pendingUiSends = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** ui.send 请求序号（进程内单调递增，回执配对用） */
  private uiSendSeq = 0;
  /** ui.send 投递回执超时（构造注入，默认 10s） */
  private readonly uiSendTimeoutMs: number;

  constructor(options: PluginHostOptions) {
    this.sendChannel = options.send;
    this.fs = options.fs ?? nodeFs;
    this.loadModule = options.loadModule ?? defaultLoadModule;
    this.uiSendTimeoutMs = options.uiSendTimeoutMs ?? 10_000;
  }

  /**
   * 下行命令统一入口。invoke 为发射后不管（执行经 pending 追踪），
   * load / shutdown 等待完成。任何命令处理异常都在内部消化，
   * 绝不冒泡（8.5：插件异常不致 host 退出）。
   */
  async handleCommand(command: HostCommand): Promise<void> {
    try {
      switch (command.type) {
        case "load":
          await this.load(command);
          return;
        case "invoke":
          this.dispatchInvoke(command);
          return;
        case "cancel":
          this.cancel(command.invocationId);
          return;
        case "shutdown":
          await this.shutdown();
          return;
        case "ui-send-result":
          this.settleUiSend(command);
          return;
      }
    } catch (e) {
      // 兜底：各分支自身已处理业务异常，此处仅防 Promise 组合层意外
      this.send({
        type: "load-error",
        message: `host 命令处理异常（${command.type}）：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /** 等待全部在途 invocation 结束（测试与 shutdown 排空用） */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  // ---------------- load / shutdown ----------------

  /** load：manifest 一致性 → capabilities 读取 → entry 动态加载 → setup → loaded */
  private async load(command: Extract<HostCommand, { type: "load" }>): Promise<void> {
    try {
      // pluginId 必须是单段目录名（产物目录 workspace/<plugin_id>/ 的安全前提）
      if (
        command.pluginId.includes("/") ||
        command.pluginId.includes("\\") ||
        command.pluginId.includes("..")
      ) {
        throw new Error(`非法 pluginId（禁止路径分隔符与 ..）：${command.pluginId}`);
      }

      // manifest 读取 + 与 load 命令的一致性校验
      const manifest = JSON.parse(
        this.fs.readFileSync(command.manifestPath, "utf8"),
      ) as ManifestLike;
      if (manifest.id !== command.pluginId) {
        throw new Error(
          `manifest.id（${manifest.id}）与 load.pluginId（${command.pluginId}）不一致`,
        );
      }

      // capabilities.json 读取（loaded 消息携带能力 id 列表供主进程核对）
      const pluginDir = dirname(command.manifestPath);
      const capabilities = JSON.parse(
        this.fs.readFileSync(join(pluginDir, "capabilities.json"), "utf8"),
      ) as CapabilityLike[];

      // entry 动态加载 + 接口形状校验
      const entryPath = resolve(pluginDir, manifest.entry);
      const plugin = extractPlugin(await this.loadModule(entryPath));

      // setup 钩子（可选）：失败走 load-error，不装载
      const pluginCtx: PluginContext = {
        pluginId: command.pluginId,
        workspaceRoot: command.workspaceRoot,
        documentsDir: command.documentsDir,
        userPluginsRoot: command.userPluginsRoot,
        esbuildBinaryPath: command.esbuildBinaryPath,
        // P-002：配置值直接透传主进程注入的快照（主进程读侧已做
        // default 合并 + 未知字段透传 + 损坏容错，host 零加工）
        config: command.config,
        // P-003：微应用通道始终注入（无 ui 声明的插件调用 → 主进程
        // 40010 回执，接口形状稳定；与 config 注入 {} 同策略）
        ui: {
          send: (payload) => this.uiSend(payload),
        },
      };
      await plugin.setup?.(pluginCtx);

      this.plugin = plugin;
      this.pluginId = command.pluginId;
      this.workspaceRoot = command.workspaceRoot;
      this.send({ type: "loaded", capabilities: capabilities.map((c) => c.id) });
    } catch (e) {
      // 加载失败上报后 host 存活：可接收下一次 load（如修复后的重新加载）
      this.send({
        type: "load-error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** shutdown：排空在途执行 → teardown 钩子（尽力而为）→ shutdown-complete */
  private async shutdown(): Promise<void> {
    await this.idle();
    try {
      await this.plugin?.teardown?.();
    } catch {
      // teardown 失败不阻塞回收：进程即将销毁，钩子仅为清理机会
    }
    this.send({ type: "shutdown-complete" });
  }

  // ---------------- invoke / cancel ----------------

  /** invoke：登记取消标志 → 异步执行（不阻塞命令通道） */
  private dispatchInvoke(command: Extract<HostCommand, { type: "invoke" }>): void {
    const state: InvocationState = { cancelled: false };
    this.invocations.set(command.invocationId, state);
    const tracked = this.runInvocation(command, state).catch(() => undefined);
    this.pending.add(tracked);
    void tracked.finally(() => {
      this.invocations.delete(command.invocationId);
      this.pending.delete(tracked);
    });
  }

  /** 单次能力执行：桥接 ctx → handle → result / error / cancelled 上报 */
  private async runInvocation(
    command: Extract<HostCommand, { type: "invoke" }>,
    state: InvocationState,
  ): Promise<void> {
    const { invocationId, capabilityId, input } = command;
    try {
      const plugin = this.plugin;
      if (plugin === undefined) {
        // 未加载即 invoke 属主进程侧协议违例：40005 插件不可用
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "插件未加载，无法执行能力");
      }
      const ctx = this.createContext(invocationId, state);
      const result = await plugin.handle(capabilityId, input, ctx);
      // 取消竞态：已请求取消但插件正常返回 → 仍上报 result（主进程状态机裁决终态）
      this.send({ type: "result", invocationId, result });
    } catch (e) {
      if (state.cancelled) {
        // 协作取消生效：插件在检查点后停止（无论停止方式是 throw 还是 reject）
        this.send({ type: "cancelled", invocationId });
        return;
      }
      this.send({ type: "error", invocationId, error: toEventError(e) });
    }
  }

  /** cancel：置位标志（未知 / 已 settle 的 invocationId 直接忽略，合法性归主进程） */
  private cancel(invocationId: string): void {
    const state = this.invocations.get(invocationId);
    if (state !== undefined) {
      state.cancelled = true;
    }
  }

  // ---------------- ctx 桥接（8.4 InvocationContext） ----------------

  private createContext(invocationId: string, state: InvocationState): InvocationContext {
    return {
      progress: (percent, message) => {
        // progress 桥接为上行消息；message 可选，未给时不输出字段
        if (message === undefined) {
          this.send({ type: "progress", invocationId, percent });
        } else {
          this.send({ type: "progress", invocationId, percent, message });
        }
      },
      log: (message) => {
        this.send({ type: "log", invocationId, message });
      },
      isCancelled: () => state.cancelled,
      artifacts: {
        save: (filename, data, mime_type) =>
          this.saveArtifact(invocationId, filename, data, mime_type),
        register: (file, filename, mime_type, size) =>
          this.registerArtifact(invocationId, file, filename, mime_type, size),
      },
      // P-003：与 PluginContext.ui 同一插件级通道（handle 内免保存引用直接用）
      ui: {
        send: (payload) => this.uiSend(payload),
      },
    };
  }

  // ---------------- ui.send 桥接（P-003 v1） ----------------

  /**
   * ctx.ui.send 实现：发 ui-send 上行消息，等待主进程 ui-send-result
   * 回执 settle。超时兜底 reject（普通 Error：宿主通道异常属系统问题，
   * 在 invocation 中被包装为 50001 上报；40010 保留给"界面未打开"的
   * 主进程判定回执，语义不混用）。
   */
  private uiSend(payload: unknown): Promise<void> {
    const requestId = ++this.uiSendSeq;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 主进程未回执（通道断裂 / runtime 缺失）：清理后兜底 reject，
        // 防插件 await 永久挂起
        this.pendingUiSends.delete(requestId);
        reject(new Error(`ui.send 投递超时（requestId=${requestId}，主进程未回执）`));
      }, this.uiSendTimeoutMs);
      this.pendingUiSends.set(requestId, { resolve, reject, timer });
      this.send({ type: "ui-send", requestId, payload });
    });
  }

  /** ui-send-result 回执：配对在途请求 settle（未知 requestId 忽略——已超时清理） */
  private settleUiSend(
    command: Extract<HostCommand, { type: "ui-send-result" }>,
  ): void {
    const pending = this.pendingUiSends.get(command.requestId);
    if (pending === undefined) return;
    this.pendingUiSends.delete(command.requestId);
    clearTimeout(pending.timer);
    if (command.ok) {
      pending.resolve();
    } else {
      pending.reject(new RpcError(command.error.code, command.error.message));
    }
  }

  // ---------------- 产物落盘与登记（7.4） ----------------

  /**
   * ctx.artifacts.save：插件生成产物的唯一合法落盘入口（7.4.2）。
   * safeFilename → resolveSafe(workspace/<plugin_id>/) → 同名自动追加序号
   * → 落盘 → artifact 消息上报 → 返回最终产物信息。
   */
  private async saveArtifact(
    invocationId: string,
    filename: string,
    data: Buffer | string,
    mime_type?: string,
  ): Promise<ArtifactInfo> {
    // 1. 纯文件名校验（禁路径分隔符与 ..）
    const safe = safeFilename(filename);
    // 2. 插件产物目录（resolveSafe 单点校验，7.4.3）
    const pluginDir = resolveSafe(this.workspaceRoot, this.pluginId);
    // 3. 同名冲突改名：永不静默覆盖（7.4.2）
    const finalName = nextConflictName(safe, (name) => this.fs.existsSync(join(pluginDir, name)));
    const target = resolveSafe(pluginDir, finalName);
    // 4. 落盘（目录懒创建：首次产物时建立 workspace/<plugin_id>/）
    this.fs.mkdirSync(pluginDir, { recursive: true });
    this.fs.writeFileSync(target, data);
    const info: ArtifactInfo = {
      file: target,
      relative_path: `${this.pluginId}/${finalName}`,
      filename: finalName,
      mime_type: mime_type ?? "application/octet-stream",
      size: typeof data === "string" ? Buffer.byteLength(data) : data.length,
    };
    this.sendArtifact(invocationId, info);
    return info;
  }

  /**
   * ctx.artifacts.register：插件自行写盘后登记（file.write 覆盖语义用）。
   * 登记路径必须落在工作空间内（路径校验单点原则，7.4.3）。
   */
  private registerArtifact(
    invocationId: string,
    file: string,
    filename: string,
    mime_type: string,
    size: number,
  ): void {
    const resolved = resolveSafe(this.workspaceRoot, file);
    // 相对路径统一正斜杠输出（跨平台一致的协议字段）
    const rel = relative(this.workspaceRoot, resolved).split(sep).join("/");
    this.sendArtifact(invocationId, {
      file: resolved,
      relative_path: rel,
      filename,
      mime_type,
      size,
    });
  }

  /** ArtifactInfo → artifact 上行消息（字段名按 6.3 消息协议 camelCase） */
  private sendArtifact(invocationId: string, info: ArtifactInfo): void {
    this.send({
      type: "artifact",
      invocationId,
      file: info.file,
      relativePath: info.relative_path,
      filename: info.filename,
      mimeType: info.mime_type,
      size: info.size,
    });
  }

  // ---------------- 内部工具 ----------------

  /** 发送上行消息；通道自身异常不击穿 host（8.5） */
  private send(event: HostEvent): void {
    try {
      this.sendChannel(event);
    } catch {
      // 通道断裂（如父进程已销毁）：吞掉，保住 host 进程自身
    }
  }
}

/** 默认模块加载器：文件路径 → file URL 动态 import（Windows 路径兼容） */
async function defaultLoadModule(entryPath: string): Promise<unknown> {
  return import(pathToFileURL(entryPath).href);
}

// ---------------------------------------------------------------------------
// utilityProcess 接线（M1-09 ExecutionRuntime 消费）
// ---------------------------------------------------------------------------

/** Electron utilityProcess 父端口的最小结构（Node 类型中不存在） */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
}

/**
 * utilityProcess 入口接线：把 parentPort 消息流入 PluginHost，
 * 上行事件经 parentPort.postMessage 送回主进程；并安装进程级
 * uncaughtException / unhandledRejection 守卫（8.5：插件任何异常
 * 不允许击穿 host 进程）。
 */
export function startUtilityProcessHost(options: Omit<PluginHostOptions, "send"> = {}): PluginHost {
  const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;
  if (parentPort === undefined) {
    throw new Error("startUtilityProcessHost 仅可在 Electron utilityProcess 内调用");
  }
  const host = new PluginHost({
    ...options,
    send: (event) => parentPort.postMessage(event),
  });
  parentPort.on("message", (event) => {
    void host.handleCommand(event.data as HostCommand);
  });
  // 进程级兜底：host 类内部已消化执行异常，此处防御类外逃逸
  //（如插件自建定时器抛错），保活并留痕于 stderr（主进程日志可见）
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[kiko-plugin-host] uncaughtException: ${String(err)}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[kiko-plugin-host] unhandledRejection: ${String(reason)}\n`);
  });
  return host;
}
