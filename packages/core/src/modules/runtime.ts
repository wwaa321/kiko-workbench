/**
 * ExecutionRuntime（设计文档 6.3：utilityProcess 插件进程管理）
 *
 * 职责：
 *   - 懒启动：插件首次被 invoke 时启动进程（内嵌 plugin-host），load 后下发 invoke
 *   - 空闲回收：idleTimeoutMs（默认 5min）无活动 → shutdown → shutdown-complete
 *     → kill（宽限 shutdownGraceMs 兜底强杀）
 *   - 崩溃检测：进程意外退出 → 该插件全部 running 态 invocation 批量 failed(50001)
 *     → 指数退避自动重启（1s → 2s → 4s … 上限 60s）
 *   - 熔断：连续崩溃 crashLimit（默认 3）次 → 插件置 error（后续 invoke 40005），
 *     UI 重新启用（registry.setPluginStatus + runtime.resetPlugin）后恢复
 *   - 协作取消（5.3.6 先协作后强杀）：cancel 消息 → 宽限 cancelGraceMs（默认 5s）
 *     未退出 → 强杀进程 + 目标 cancelled + 同插件其余 running 批量 failed
 *   - 主动终止（强杀 / idle 回收 / load-error / dispose）：terminateProcess 同步
 *     收尾（句柄立即失效 → 后续 invoke 懒启动新进程；真实 utilityProcess 的
 *     exit 异步送达，旧进程迟到的 exit/上行消息经陈旧守卫忽略——杜绝"命令发给
 *     已死进程被误判崩溃"竞态）。主动终止不计崩溃、不触发退避重启
 *
 * Electron 解耦（core 禁 import electron）：进程操作抽象为 ProcessLauncher
 * 注入——Electron 宿主传 utilityProcess 实现（apps/desktop），单测传 fake。
 *
 * "连续崩溃"语义（文档未定义重置点，见偏差表 2026-08-20）：
 * 成功完成一次 invocation（result 上行）即重置计数——崩溃-重启-成功-崩溃
 * 不熔断；崩溃-重启-崩溃-重启-崩溃（其间无成功执行）熔断。
 */
import { join } from "node:path";
import { ERROR_CODES, EVENT_TYPES, RpcError, type ResultError } from "@kiko-workbench/protocol";
import type { HostCommand, HostEvent } from "@kiko-workbench/plugin-sdk";
import type { CapabilityRegistry, PluginRecord } from "./registry.js";
import type { PluginConfigReader } from "./config-store.js";
import type { EventManager, LogManager, StateManager } from "./state.js";
import type { InvocationManager } from "./invocation.js";
import type { WorkspaceManager } from "./workspace.js";
import { isTerminal, type InvocationRecord } from "../stores/types.js";

// ---------------------------------------------------------------------------
// 进程抽象（宿主注入，core 零 electron 依赖）
// ---------------------------------------------------------------------------

/** 插件子进程句柄（utilityProcess 的最小抽象；测试注入 fake） */
export interface PluginProcess {
  /** 下发下行命令（load / invoke / cancel / shutdown，6.3） */
  send(command: HostCommand): void;
  /** 杀死进程 */
  kill(): void;
  /** 上行消息监听（host → main）；返回退订函数 */
  onMessage(listener: (event: HostEvent) => void): () => void;
  /** 进程退出监听（含崩溃与主动 kill）；返回退订函数 */
  onExit(listener: () => void): () => void;
}

/** 进程启动参数（launcher 实现自行闭包 host 入口脚本等细节） */
export interface PluginSpawnOptions {
  pluginId: string;
}

/** 进程启动器（宿主注入：Electron utilityProcess / 单测 fake） */
export type ProcessLauncher = (options: PluginSpawnOptions) => PluginProcess;

/**
 * 微应用 UI 中继（P-003 v1，草案附录 C）：host 的 ui-send 上行消息 →
 * 该插件的微应用窗口。core 禁 electron，webContents 投递由 shell 装配
 * 注入真实现；headless / 未装配宿主用默认 stub（无表面 → 40010）。
 */
export interface PluginUiRelay {
  /**
   * 向 pluginId 的微应用窗口投递消息。
   * @throws RpcError 40010 窗口未打开（含插件无 ui 声明的情形——
   *   无声明即无窗口，语义自然成立）
   */
  send(pluginId: string, payload: unknown): Promise<void>;
}

/** 构造依赖（全部注入，保持纯 Node 可单测） */
export interface ExecutionRuntimeDeps {
  registry: CapabilityRegistry;
  invocation: InvocationManager;
  state: StateManager;
  events: EventManager;
  logs: LogManager;
  workspace: WorkspaceManager;
  launcher: ProcessLauncher;
  /**
   * 第三方插件根目录（load 命令 → PluginContext.userPluginsRoot 注入，
   * S2 扩展字段）：sdk 分发插件的 install_guide 需向 Agent 声明部署
   * 目标；插件进程无法跨平台可靠推断，必须由装配层注入。
   */
  userPluginsRoot: string;
  /**
   * esbuild CLI 二进制绝对路径（load 命令 → PluginContext.esbuildBinaryPath
   * 注入，S8 扩展字段）：sdk.build 零 shell 构建的执行体。esbuild JS API
   * 无法被 bundle（其源码显式拒绝），故经二进制路径注入由插件进程 spawn。
   */
  esbuildBinaryPath: string;
  /**
   * 插件配置读取（load 命令 → PluginContext.config 注入源，P-002
   * Phase 1 扩展字段）：宿主装配传入 PluginConfigStore（default 合并 +
   * 未知字段透传 + 损坏容错）。可选——缺省空实现（{} 注入，未装配
   * 配置能力的宿主 / 现有单测零影响）。
   */
  pluginConfigs?: PluginConfigReader;
  /**
   * 微应用 UI 中继（P-003 v1 扩展字段）：host ui-send 上行消息的投递
   * 目标。可选——缺省 stub 恒 reject 40010（无表面宿主 / headless /
   * 现有单测零影响：插件调 ctx.ui.send 即得"界面未打开"）。
   */
  uiRelay?: PluginUiRelay;
  /** 空闲回收阈值（6.3：默认 5min） */
  idleTimeoutMs?: number;
  /** 协作取消宽限（5.3.6：默认 5s，宽限内未退出则强杀） */
  cancelGraceMs?: number;
  /** shutdown-complete 等待宽限（默认 5s，超时强杀兜底） */
  shutdownGraceMs?: number;
  /** 插件加载超时（默认 10s：超时杀进程并按崩溃计） */
  loadTimeoutMs?: number;
  /** 指数退避基数（6.3：默认 1s → 2s → 4s …） */
  backoffBaseMs?: number;
  /** 退避上限（6.3：默认 60s） */
  backoffMaxMs?: number;
  /** 连续崩溃熔断阈值（6.3：默认 3 次） */
  crashLimit?: number;
}

/** 单插件运行时状态（进程 + 生命周期簿记） */
interface PluginRuntimeState {
  pluginId: string;
  process: PluginProcess | null;
  /** load 已完成（进程就绪可下发 invoke） */
  ready: boolean;
  /** 加载中 promise（并线 execute 复用；null = 无在途加载） */
  loading: Promise<void> | null;
  /** 加载 promise 的 settle 回调（loaded / load-error / exit / 超时消费） */
  loadSettle: ((error?: RpcError) => void) | null;
  loadTimer: ReturnType<typeof setTimeout> | null;
  /** 退避重启等待 promise（崩溃退避期内新 execute 顺延至此；防即时重崩循环） */
  restartDelay: Promise<void> | null;
  restartDelayResolve: (() => void) | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  shutdownTimer: ReturnType<typeof setTimeout> | null;
  /** 连续崩溃计数（成功执行 result 时清零） */
  crashCount: number;
  /** 已下发 invoke 的 invocation（崩溃时批量 failed；终态时移除） */
  readonly running: Set<string>;
  /** cancel 宽限强杀定时器（invocationId → timer） */
  readonly cancelGuards: Map<string, ReturnType<typeof setTimeout>>;
}

/** sync 等待者的延迟对象（waitForSettled 注册，终态事件统一唤醒） */
interface SettleDeferred {
  promise: Promise<void>;
  resolve: () => void;
}

/** 消息中携带 invocationId 的类型集合（错误归因用） */
function hasInvocationId(event: HostEvent): event is HostEvent & { invocationId: string } {
  return "invocationId" in event;
}

export class ExecutionRuntime {
  /** 构造依赖（可选项已在构造期填默认值） */
  private readonly deps: Required<ExecutionRuntimeDeps>;
  /** pluginId → 运行时状态 */
  private readonly runtimes = new Map<string, PluginRuntimeState>();
  /** invocationId → pluginId（cancel 路由 + settle 清理） */
  private readonly invocationPlugin = new Map<string, string>();
  /** sync 等待者（waitForSettled 注册；终态事件唤醒） */
  private readonly settlers = new Map<string, SettleDeferred>();
  /**
   * UI 租约（P-003 v1）：持有租约的插件进程不被 idle 回收（表面开着，
   * 后端随时可能 ctx.ui.send）。v1 单实例窗口 → 布尔集合即可；多表面
   * 需求出现时改计数（草案 C.4 预留）。
   */
  private readonly uiLeases = new Set<string>();
  private disposed = false;

  constructor(deps: ExecutionRuntimeDeps) {
    this.deps = {
      registry: deps.registry,
      invocation: deps.invocation,
      state: deps.state,
      events: deps.events,
      logs: deps.logs,
      workspace: deps.workspace,
      launcher: deps.launcher,
      userPluginsRoot: deps.userPluginsRoot,
      esbuildBinaryPath: deps.esbuildBinaryPath,
      // P-002：未装配配置能力的宿主 / 现有单测缺省空实现——所有插件
      // 一律注入 {}（与"未声明配置的插件"同语义，load 命令字段恒存在）
      pluginConfigs: deps.pluginConfigs ?? { read: () => ({}) },
      // P-003：未装配 UI 的宿主（headless）缺省 stub——恒 reject 40010，
      // 与"窗口未打开"同语义（无表面可投递）
      uiRelay:
        deps.uiRelay ??
        {
          send: () =>
            Promise.reject(new RpcError(ERROR_CODES.PLUGIN_UI_NOT_OPEN, "插件界面未打开")),
        },
      idleTimeoutMs: deps.idleTimeoutMs ?? 5 * 60_000,
      cancelGraceMs: deps.cancelGraceMs ?? 5_000,
      shutdownGraceMs: deps.shutdownGraceMs ?? 5_000,
      loadTimeoutMs: deps.loadTimeoutMs ?? 10_000,
      backoffBaseMs: deps.backoffBaseMs ?? 1_000,
      backoffMaxMs: deps.backoffMaxMs ?? 60_000,
      crashLimit: deps.crashLimit ?? 3,
    };
    // 终态事件 → 唤醒 sync 等待者。经事件而非直调 settle：超时守卫等
    // InvocationManager 内部路径的终态（runtime 不知情）同样能唤醒。
    this.deps.events.subscribe((event) => {
      if (
        event.event === EVENT_TYPES.EXECUTION_COMPLETED ||
        event.event === EVENT_TYPES.EXECUTION_FAILED ||
        event.event === EVENT_TYPES.EXECUTION_CANCELLED
      ) {
        this.settle(event.invocation_id);
      }
    });
  }

  // ---------------- 对外入口 ----------------

  /**
   * 执行 invocation（懒启动入口）：确保进程就绪 → markRunning → 下发 invoke。
   * 加载失败 / 熔断 → resolved → failed(40005)（执行未开始路径）。
   * 返回时机 = 下发完成（非执行完成）；sync 响应等待用 waitForSettled。
   */
  async execute(record: InvocationRecord): Promise<void> {
    const { plugin } = this.deps.registry.resolveCapability(record.capability_id);
    const rt = this.getOrCreateRuntime(plugin.id);
    try {
      await this.ensureReady(rt);
    } catch (e) {
      // "执行未开始"失败：invocation 落 failed（行6 扩展，偏差表 2026-08-20）
      const error: ResultError =
        e instanceof RpcError
          ? { code: e.code, message: e.message }
          : { code: ERROR_CODES.INTERNAL_ERROR, message: String(e) };
      this.safeFailFromResolved(record.invocation_id, error);
      return;
    }
    this.invocationPlugin.set(record.invocation_id, plugin.id);
    rt.running.add(record.invocation_id);
    // 行4：resolved → running（发 execution.started + 启动超时守卫）
    try {
      this.deps.invocation.markRunning(record.invocation_id);
    } catch (e) {
      // 加载等待期间已被取消等终态竞态：让位，交由事件链收尾
      rt.running.delete(record.invocation_id);
      this.swallowRpc(e);
      return;
    }
    if (rt.process === null) {
      // 就绪与下发之间的竞态：进程已亡（exit 批处理未覆盖本次登记）
      rt.running.delete(record.invocation_id);
      this.safeFail(record.invocation_id, {
        code: ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        message: "插件进程在下发前退出",
      });
      return;
    }
    rt.process.send({
      type: "invoke",
      invocationId: record.invocation_id,
      capabilityId: record.capability_id,
      input: record.input,
    });
    this.touchIdle(rt);
  }

  /**
   * 等待 invocation 终态（sync invoke 响应组装用，M1-11 WS 接线）。
   * 已终态立即返回；未知 invocation → 40003。
   */
  waitForSettled(invocationId: string): Promise<void> {
    const existing = this.settlers.get(invocationId);
    if (existing !== undefined) return existing.promise;
    const record = this.deps.state.get(invocationId);
    if (record === undefined) {
      throw new RpcError(ERROR_CODES.INVOCATION_NOT_FOUND, `invocation 不存在：${invocationId}`);
    }
    if (isTerminal(record.internalStatus)) return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.settlers.set(invocationId, { promise, resolve });
    return promise;
  }

  /**
   * 协作取消挂接点（InvocationManager.onCancelRequested → 此处）：
   * 下发 cancel 消息 + 宽限强杀守卫（5.3.6）。
   */
  onCancelRequested(invocationId: string): void {
    const pluginId = this.invocationPlugin.get(invocationId);
    const rt = pluginId !== undefined ? this.runtimes.get(pluginId) : undefined;
    if (rt === undefined || rt.process === null) {
      // 进程不在（崩溃 / 回收竞态）：直接终态
      this.safeConfirmCancelled(invocationId);
      return;
    }
    rt.process.send({ type: "cancel", invocationId });
    rt.cancelGuards.set(
      invocationId,
      setTimeout(() => {
        // 宽限耗尽：目标先移出 running（不被批量 failed 覆盖）→ cancelled
        // → 同步终止进程（intentional：不计崩溃不退避；残余 running 批量 failed）
        rt.cancelGuards.delete(invocationId);
        rt.running.delete(invocationId);
        this.safeConfirmCancelled(invocationId);
        this.terminateProcess(rt);
      }, this.deps.cancelGraceMs),
    );
  }

  /** 熔断后重新启用（registry.setPluginStatus(id, "enabled") 后调用）：清崩溃计数 */
  resetPlugin(pluginId: string): void {
    const rt = this.runtimes.get(pluginId);
    if (rt !== undefined) rt.crashCount = 0;
  }

  /**
   * UI 租约获取（P-003 v1）：微应用窗口打开时由 shell 调用——持有租约
   * 的插件进程不被 idle 回收（后端随时可能 ctx.ui.send）。幂等。
   */
  acquireUiLease(pluginId: string): void {
    this.uiLeases.add(pluginId);
  }

  /**
   * UI 租约释放（P-003 v1）：窗口关闭时由 shell 调用，恢复 idle 回收
   * 资格（下次空闲到期自然回收，无需主动触发）。幂等。
   */
  releaseUiLease(pluginId: string): void {
    this.uiLeases.delete(pluginId);
  }

  /** 进程回收前清理（headless 退出 / Electron quit）：running 批量 failed + 全部杀灭 */
  dispose(): void {
    this.disposed = true;
    for (const rt of this.runtimes.values()) {
      this.clearTimers(rt);
      this.clearCancelGuards(rt);
      for (const id of rt.running) {
        this.safeFail(id, {
          code: ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          message: "runtime 已关闭（dispose）",
        });
      }
      rt.running.clear();
      this.terminateProcess(rt);
    }
    this.runtimes.clear();
    this.uiLeases.clear(); // P-003：租约随 runtime 一并废弃（防泄漏）
  }

  /**
   * 卸载单插件运行时（S11：plugins.rescan 移除路径，零 Shell 自举方案 3.3）。
   * 复用 terminateProcess 全套收尾（残余 invocation 批量 failed(50001) /
   * 计时器清理 / 退避重启取消），随后删除 runtimes 条目——后续对该插件
   * 的能力解析在 registry 层即 40001（能力已 unregister）。
   * 幂等：未运行 / 已终止的插件为 no-op。
   */
  disposePlugin(pluginId: string): void {
    const rt = this.runtimes.get(pluginId);
    if (rt === undefined) return;
    this.clearTimers(rt);
    this.clearCancelGuards(rt);
    this.terminateProcess(rt);
    this.runtimes.delete(pluginId);
    this.uiLeases.delete(pluginId); // P-003：插件卸载 → 表面必已关闭，防御性清租约
  }

  // ---------------- 进程就绪保障（懒启动 / 退避顺延 / 并线复用） ----------------

  private getOrCreateRuntime(pluginId: string): PluginRuntimeState {
    let rt = this.runtimes.get(pluginId);
    if (rt === undefined) {
      rt = {
        pluginId,
        process: null,
        ready: false,
        loading: null,
        loadSettle: null,
        loadTimer: null,
        restartDelay: null,
        restartDelayResolve: null,
        restartTimer: null,
        idleTimer: null,
        shutdownTimer: null,
        crashCount: 0,
        running: new Set<string>(),
        cancelGuards: new Map<string, ReturnType<typeof setTimeout>>(),
      };
      this.runtimes.set(pluginId, rt);
    }
    return rt;
  }

  /** 确保进程就绪：已就绪直通 / 加载中并线 / 退避期顺延 / 全新启动 */
  private async ensureReady(rt: PluginRuntimeState): Promise<void> {
    // 熔断 / 禁用即时拒绝（execute 期间的 registry 状态以最新为准）
    const plugin = this.deps.registry.getPlugin(rt.pluginId);
    if (plugin === undefined || plugin.status !== "enabled") {
      throw new RpcError(
        ERROR_CODES.PLUGIN_UNAVAILABLE,
        `插件 ${rt.pluginId} 不可用（${plugin?.status ?? "未注册"}）`,
      );
    }
    if (rt.process !== null && rt.ready) return;
    if (rt.loading !== null) return rt.loading;
    if (rt.restartDelay !== null) {
      // 崩溃退避期内：顺延至重启加载结束（防即时重崩循环），再重查
      await rt.restartDelay;
      return this.ensureReady(rt);
    }
    return this.startProcess(rt, plugin);
  }

  /** 启动进程 + 下发 load；返回加载 promise（loaded / load-error / exit / 超时 settle） */
  private startProcess(rt: PluginRuntimeState, plugin: PluginRecord): Promise<void> {
    if (this.disposed) {
      throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "runtime 已关闭，拒绝启动插件进程");
    }
    const child = this.deps.launcher({ pluginId: rt.pluginId });
    rt.process = child;
    rt.ready = false;
    // 监听闭包捕获进程句柄：terminateProcess 同步失效句柄后，旧进程迟到的
    // exit / 上行消息经陈旧守卫忽略（防误清新进程状态或重复批处理）
    child.onMessage((event) => this.handleUpstream(rt, child, event));
    child.onExit(() => this.handleExit(rt, child));
    const loading = new Promise<void>((resolve, reject) => {
      rt.loadSettle = (error?: RpcError) => {
        if (error !== undefined) reject(error);
        else resolve();
      };
    });
    rt.loading = loading;
    // 加载超时守卫：超时 → 通知等待者 + 裸杀进程（不走 terminateProcess——
    // 设计约定加载超时按崩溃计：exit 事件驱动崩溃簿记 + 退避，见 handleExit）
    rt.loadTimer = setTimeout(() => {
      if (rt.ready) return;
      rt.loadTimer = null;
      rt.loadSettle?.(
        new RpcError(
          ERROR_CODES.PLUGIN_UNAVAILABLE,
          `插件加载超时（${this.deps.loadTimeoutMs}ms）`,
        ),
      );
      this.killProcess(rt);
    }, this.deps.loadTimeoutMs);
    child.send({
      type: "load",
      manifestPath: join(plugin.rootDir, "manifest.json"),
      pluginId: plugin.id,
      workspaceRoot: this.deps.workspace.workspaceRoot,
      documentsDir: this.deps.workspace.documentsDir,
      // S2 扩展字段：PluginContext.userPluginsRoot 的注入通道（sdk 插件消费）
      userPluginsRoot: this.deps.userPluginsRoot,
      // S8 扩展字段：PluginContext.esbuildBinaryPath 的注入通道（sdk.build 消费）
      esbuildBinaryPath: this.deps.esbuildBinaryPath,
      // P-002：PluginContext.config 的注入通道——读侧（config-store.read）
      // 已做 default 合并 + 未知字段透传 + 损坏容错，此处零加工透传。
      // 未声明配置（configSchema undefined）→ read 返回 {}（§3.4）
      config: this.deps.pluginConfigs.read(plugin.id, plugin.configSchema),
    });
    return loading;
  }

  // ---------------- 上行消息分发（host → main，6.3） ----------------

  /** 单条消息异常不击穿 runtime（8.5 同款原则）；RpcError 归为该 invocation 执行错误 */
  private handleUpstream(rt: PluginRuntimeState, child: PluginProcess, event: HostEvent): void {
    // 陈旧进程的迟到消息（已终止 / 已被新实例替换）：忽略，防污染新进程状态
    if (rt.process !== child) return;
    try {
      this.dispatchUpstream(rt, event);
    } catch (e) {
      if (hasInvocationId(event) && e instanceof RpcError) {
        this.safeFail(event.invocationId, { code: e.code, message: e.message });
      }
    }
  }

  private dispatchUpstream(rt: PluginRuntimeState, event: HostEvent): void {
    switch (event.type) {
      case "loaded": {
        rt.ready = true;
        this.clearLoadTimer(rt);
        rt.loadSettle?.();
        rt.loadSettle = null;
        rt.loading = null;
        this.touchIdle(rt);
        return;
      }
      case "load-error": {
        // 确定性加载失败（插件实现损坏）：失败等待者 + 熔断 error 态 + 主动杀灭（不重试）
        this.clearLoadTimer(rt);
        const error = new RpcError(
          ERROR_CODES.PLUGIN_UNAVAILABLE,
          `插件加载失败：${event.message}`,
        );
        rt.loadSettle?.(error);
        rt.loadSettle = null;
        rt.loading = null;
        this.deps.registry.setPluginStatus(rt.pluginId, "error", `加载失败：${event.message}`);
        this.terminateProcess(rt);
        return;
      }
      case "log": {
        this.deps.logs.append(event.invocationId, event.message);
        this.touchIdle(rt);
        return;
      }
      case "progress": {
        // 事件 data：{ percent, message? }（5.4 事件推送格式）
        const data: Record<string, unknown> = { percent: event.percent };
        if (event.message !== undefined) data.message = event.message;
        this.deps.events.emit(EVENT_TYPES.EXECUTION_PROGRESS, event.invocationId, data);
        this.touchIdle(rt);
        return;
      }
      case "artifact": {
        // M1-08 防御纵深：host 已过 resolveSafe，core 登记前单点复查（越界 50001）
        const normalized = this.deps.workspace.validateArtifactPath(event.file);
        this.deps.invocation.attachArtifact(event.invocationId, {
          file: normalized.file,
          relative_path: normalized.relative_path,
          filename: event.filename,
          mime_type: event.mimeType,
          size: event.size,
        });
        this.touchIdle(rt);
        return;
      }
      case "result": {
        this.safeComplete(event.invocationId, event.result);
        this.finishInvocation(rt, event.invocationId);
        // 成功执行 → 重置连续崩溃计数（"连续"以成功执行为断点，偏差表 2026-08-20）
        rt.crashCount = 0;
        this.touchIdle(rt);
        return;
      }
      case "error": {
        this.safeFail(event.invocationId, event.error);
        this.finishInvocation(rt, event.invocationId);
        this.touchIdle(rt);
        return;
      }
      case "cancelled": {
        this.safeConfirmCancelled(event.invocationId);
        this.finishInvocation(rt, event.invocationId);
        this.touchIdle(rt);
        return;
      }
      case "shutdown-complete": {
        // 优雅回收完成 → 同步终止收尾（exit 迟到事件按陈旧忽略）
        this.terminateProcess(rt);
        return;
      }
      case "ui-send": {
        // P-003 v1：ctx.ui.send 上行 → uiRelay 投递到微应用窗口，
        // 结果经 ui-send-result 下行回执（Promise 语义闭环在 host 侧）
        this.relayUiSend(rt, event.requestId, event.payload);
        return;
      }
    }
  }

  /**
   * ui-send 路由（P-003 v1）：uiRelay 投递 → 成败回执 host。
   * 投递期间进程被终止（回收 / 崩溃）→ 不再回执（host 已亡或超时兜底）。
   * ui 活动同样刷新 idle 计时（后端活跃信号）。
   */
  private relayUiSend(rt: PluginRuntimeState, requestId: number, payload: unknown): void {
    const child = rt.process;
    if (child === null) return; // 进程已亡：无回执通道，host 侧超时兜底
    this.touchIdle(rt);
    void this.deps.uiRelay
      .send(rt.pluginId, payload)
      .then(() => {
        if (rt.process !== child) return; // 陈旧守卫：投递期间进程已换/亡
        child.send({ type: "ui-send-result", requestId, ok: true });
      })
      .catch((e: unknown) => {
        if (rt.process !== child) return;
        // RpcError 透传（40010 界面未打开等）；宿主异常统一 INTERNAL_ERROR
        const error =
          e instanceof RpcError
            ? e
            : new RpcError(ERROR_CODES.INTERNAL_ERROR, `ui 投递失败：${String(e)}`);
        child.send({
          type: "ui-send-result",
          requestId,
          ok: false,
          error: { code: error.code, message: error.message },
        });
      });
  }

  /** invocation 终态后的运行时簿记清理（running 移除 + cancel 守卫撤销） */
  private finishInvocation(rt: PluginRuntimeState, invocationId: string): void {
    rt.running.delete(invocationId);
    const guard = rt.cancelGuards.get(invocationId);
    if (guard !== undefined) {
      clearTimeout(guard);
      rt.cancelGuards.delete(invocationId);
    }
  }

  // ---------------- 进程退出（崩溃检测 / 熔断 / 退避重启，6.3） ----------------

  private handleExit(rt: PluginRuntimeState, child: PluginProcess): void {
    // 陈旧退出守卫：主动终止经 terminateProcess 同步收尾（句柄已失效）、或进程
    // 已被新实例替换 → 迟到的 exit 直接忽略（真实 utilityProcess 的 kill/exit
    // 异步送达；防误清新进程状态、防同批 running 被重复批处理）
    if (rt.process !== child) return;
    rt.process = null;
    rt.ready = false;
    this.clearTimers(rt);
    // cancel 宽限守卫全部撤销：进程已亡，强杀失去对象（防陈旧守卫误杀重启后的新进程）
    this.clearCancelGuards(rt);

    // 1) 加载等待者：进程已亡，加载不可能完成（崩溃于加载期）
    rt.loadSettle?.(new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "插件进程在加载完成前退出"));
    rt.loadSettle = null;
    rt.loading = null;

    // 2) 运行中 invocation 批量 failed(50001)。崩溃与取消竞态时崩溃胜出
    //    （进程非因取消而死，如实上报崩溃）
    for (const id of rt.running) {
      this.safeFail(id, {
        code: ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        message: "插件进程崩溃（plugin crashed）",
      });
    }
    rt.running.clear();

    // 3) 崩溃簿记：计数 / 熔断 / 指数退避自动重启。
    //    能通过陈旧守卫到达此处的退出均为意外（主动终止已在上游同步收尾）；
    //    加载超时的裸杀（killProcess）亦在此按崩溃计（设计约定）
    if (this.disposed) return;
    rt.crashCount += 1;
    if (rt.crashCount >= this.deps.crashLimit) {
      this.deps.registry.setPluginStatus(
        rt.pluginId,
        "error",
        `连续崩溃 ${rt.crashCount} 次（熔断）`,
      );
      return;
    }
    const delay = Math.min(
      this.deps.backoffBaseMs * 2 ** (rt.crashCount - 1),
      this.deps.backoffMaxMs,
    );
    // 退避等待 promise：期内新 execute 顺延；重启加载结束后唤醒。
    // resolve 局部化（definite assignment）：闭包内非空调用，避免可空类型逃逸
    let delayResolve!: () => void;
    rt.restartDelay = new Promise<void>((resolve) => {
      delayResolve = resolve;
      rt.restartDelayResolve = resolve;
    });
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      rt.restartDelay = null;
      rt.restartDelayResolve = null;
      const plugin = this.deps.registry.getPlugin(rt.pluginId);
      if (plugin === undefined || plugin.status !== "enabled" || this.disposed) {
        // 期间被禁用 / 熔断 / runtime 关闭：唤醒等待者（ensureReady 重查后拒绝）
        delayResolve();
        return;
      }
      try {
        const loading = this.startProcess(rt, plugin);
        // 重启加载结束（成败皆可）→ 唤醒退避等待者
        void loading.then(delayResolve, delayResolve);
      } catch {
        // fork 同步失败（如宿主资源不足）：唤醒等待者（ensureReady 重查后
        // 由下一次 startProcess 路径正常上报），不让异常逃进 timer 回调
        delayResolve();
      }
    }, delay);
  }

  // ---------------- 空闲回收（6.3：idleTimeoutMs 无活动 → 回收） ----------------

  /** 活动刷新（invoke 下发 / 任意上行消息）：重置空闲计时 */
  private touchIdle(rt: PluginRuntimeState): void {
    if (rt.idleTimer !== null) clearTimeout(rt.idleTimer);
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = null;
      this.recycleIdle(rt);
    }, this.deps.idleTimeoutMs);
  }

  private recycleIdle(rt: PluginRuntimeState): void {
    if (rt.running.size > 0 || rt.loading !== null || rt.process === null) {
      // 防御：仍有活动（touch 漏网）或无进程可回收 → 顺延
      this.touchIdle(rt);
      return;
    }
    if (this.uiLeases.has(rt.pluginId)) {
      // P-003：UI 租约持有中（微应用窗口开着）→ 不回收，顺延下一周期。
      // 窗口关闭（releaseUiLease）后恢复回收资格
      this.touchIdle(rt);
      return;
    }
    // 优雅回收：shutdown → 宽限等 shutdown-complete → 强杀兜底
    rt.process.send({ type: "shutdown" });
    rt.shutdownTimer = setTimeout(() => {
      rt.shutdownTimer = null;
      this.terminateProcess(rt);
    }, this.deps.shutdownGraceMs);
  }

  // ---------------- 内部工具 ----------------

  /**
   * 裸杀进程（仅加载超时守卫使用）：不做任何状态收尾——exit 事件（同步或异步
   * 送达）驱动 handleExit 走崩溃簿记路径（设计约定：加载超时按崩溃计）。
   */
  private killProcess(rt: PluginRuntimeState): void {
    rt.process?.kill();
  }

  /**
   * 主动终止（cancel 强杀 / idle 回收兜底 / load-error / shutdown-complete /
   * dispose）：同步完成全部运行时收尾再 kill——
   *   - 句柄立即失效：后续 execute 不再经 ensureReady 快速路径把命令发给
   *     已死进程（真实 utilityProcess kill 后 exit 异步送达，若等 exit 收尾，
   *     窗口期内的恢复 invoke 会被 exit 批处理误判为崩溃 50001）
   *   - 残余 running 批量 failed(50001)（5.3.6 强杀语义；目标 invocation 已
   *     由调用方先行 cancelled 并移出 running）
   *   - 不计崩溃、不触发退避重启（与意外崩溃的本质区别，6.3）；
   *     kill 后迟到的 exit / 上行消息经陈旧守卫忽略
   */
  private terminateProcess(rt: PluginRuntimeState): void {
    const proc = rt.process;
    if (proc === null) return; // 已终止 / 未启动（幂等）
    rt.process = null;
    rt.ready = false;
    this.clearTimers(rt);
    this.clearCancelGuards(rt);
    // 加载等待者唤醒（进程已亡，加载不可能完成）
    rt.loadSettle?.(new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "插件进程被主动终止"));
    rt.loadSettle = null;
    rt.loading = null;
    for (const id of rt.running) {
      this.safeFail(id, {
        code: ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        message: "插件进程被强制终止（force-killed）",
      });
    }
    rt.running.clear();
    try {
      proc.kill();
    } catch {
      // 进程已死时的兜底（kill 理应幂等）
    }
  }

  private clearLoadTimer(rt: PluginRuntimeState): void {
    if (rt.loadTimer !== null) {
      clearTimeout(rt.loadTimer);
      rt.loadTimer = null;
    }
  }

  /** 撤销全部 cancel 宽限守卫（进程退出 / dispose） */
  private clearCancelGuards(rt: PluginRuntimeState): void {
    for (const guard of rt.cancelGuards.values()) clearTimeout(guard);
    rt.cancelGuards.clear();
  }

  private clearTimers(rt: PluginRuntimeState): void {
    this.clearLoadTimer(rt);
    if (rt.restartTimer !== null) {
      clearTimeout(rt.restartTimer);
      rt.restartTimer = null;
    }
    // 退避等待者唤醒（防止悬挂：清理前 resolve）
    const resolve = rt.restartDelayResolve;
    rt.restartDelay = null;
    rt.restartDelayResolve = null;
    resolve?.();
    if (rt.idleTimer !== null) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = null;
    }
    if (rt.shutdownTimer !== null) {
      clearTimeout(rt.shutdownTimer);
      rt.shutdownTimer = null;
    }
  }

  /** 终态事件统一唤醒 sync 等待者 + 清理路由 */
  private settle(invocationId: string): void {
    this.invocationPlugin.delete(invocationId);
    const deferred = this.settlers.get(invocationId);
    if (deferred !== undefined) {
      this.settlers.delete(invocationId);
      deferred.resolve();
    }
  }

  // ---- 安全终态包装：竞态败者（超时守卫 / 崩溃批处理先置终态）静默让位 ----

  private safeComplete(invocationId: string, result: unknown): void {
    try {
      this.deps.invocation.complete(invocationId, result);
    } catch (e) {
      this.swallowRpc(e);
    }
  }

  private safeFail(invocationId: string, error: ResultError): void {
    try {
      this.deps.invocation.fail(invocationId, error);
    } catch (e) {
      this.swallowRpc(e);
    }
  }

  private safeFailFromResolved(invocationId: string, error: ResultError): void {
    try {
      this.deps.invocation.failFromResolved(invocationId, error);
    } catch (e) {
      this.swallowRpc(e);
    }
  }

  private safeConfirmCancelled(invocationId: string): void {
    try {
      this.deps.invocation.confirmCancelled(invocationId);
    } catch (e) {
      this.swallowRpc(e);
    }
  }

  /** RpcError（40004 终态竞态 / 40003 未知 id 等 host 上报异常）吞掉；其余上抛 */
  private swallowRpc(e: unknown): void {
    if (!(e instanceof RpcError)) throw e;
  }
}
