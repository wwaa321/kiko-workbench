/**
 * WsKikoRpcClient —— KikoRpcClient 的生产实现（WS 通道）
 *
 * 形态说明（第 9 节"MCP Server（stdio / HTTP 可选）"的 stdio 落地）：
 * stdio MCP Server 必须是独立纯 Node 进程，而插件宿主（utilityProcess）
 * 只能存活于 Electron 主进程——因此本适配器不进程内组装 core，而是
 * 作为 WS 客户端连接"运行中的 Kiko"（headless / desktop 主进程的
 * WsRpcServer，127.0.0.1:47830），复用其鉴权、插件运行时与事件推送。
 * 纯翻译层：MCP 消息 ⇄ 自定义协议 JSON-RPC，零业务逻辑。
 *
 * 连接生命周期（对齐 5.1 / M2-02 鉴权）：
 *   open → [auth（配置 token 时首条消息）] → subscribe_event（全量）
 *   → 请求配对（id 匹配）/ 事件 notification 分发
 *
 * 稳定性设计：
 *   - 请求超时（普通方法 30s；invoke 等终态受 capability timeout 兜底，
 *     本层再加 10min 硬上限防僵尸）
 *   - 断连：全部 pending 请求 reject + 终态等待者 reject（上层据此退出）
 *   - 终态事件先于 invoke 响应到达的竞态：terminal 缓存兜底（先到先存，
 *     waitForTerminal 后到先查缓存）
 */
import WebSocket from "ws";
import {
  EVENT_NOTIFICATION_METHOD,
  EVENT_TYPES,
  RPC_METHODS,
  type CapabilityDefinition,
  type CapabilitySummary,
  type ExecutionDetail,
  type ExecutionEvent,
} from "@kiko-workbench/protocol";
import type { KikoProgressEvent, KikoRpcError, KikoRpcClient } from "./kiko-rpc.js";

/** 终态事件缓存上限（防泄漏：正常路径 waitForTerminal 消费即删） */
const TERMINAL_CACHE_LIMIT = 256;
/** 普通请求超时（discover/describe/auth/subscribe：秒级方法） */
const REQUEST_TIMEOUT_MS = 30_000;
/** invoke 等终态硬上限（capability timeout_ms 之外的最后防线） */
const INVOKE_TIMEOUT_MS = 10 * 60_000;

export interface WsKikoRpcOptions {
  /** ws://127.0.0.1:47830（WsRpcServer 端点；缺省同值） */
  url?: string;
  /** WS 鉴权 token（Kiko 启用了鉴权时必传；KIKO_NO_AUTH 服务端可不传） */
  token?: string;
  /** 连接建立超时（缺省 10s） */
  connectTimeoutMs?: number;
}

/** JSON-RPC 请求的 pending 记录（id → resolve/reject） */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: KikoRpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 终态等待者（invocationId → resolve） */
interface TerminalWaiter {
  resolve: (detail: "event") => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsKikoRpcClient implements KikoRpcClient {
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly connectTimeoutMs: number;
  private ws: WebSocket | null = null;
  /** 请求 id 序号 */
  private seq = 0;
  /** 在途请求（id → pending） */
  private readonly pending = new Map<number, PendingRequest>();
  /** 终态事件缓存（invocationId → ExecutionEvent；竞态兜底，见类注释） */
  private readonly terminalEvents = new Map<string, ExecutionEvent>();
  /** 终态等待者（invocationId → waiter） */
  private readonly terminalWaiters = new Map<string, TerminalWaiter>();
  /** progress 监听者集合 */
  private readonly progressListeners = new Set<(event: KikoProgressEvent) => void>();
  /** 连接是否已关闭（防重入） */
  private closed = false;

  constructor(options: WsKikoRpcOptions = {}) {
    this.url = options.url ?? "ws://127.0.0.1:47830";
    this.token = options.token;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  /**
   * 建立连接：open → auth（可选）→ subscribe_event（全量）。
   * 任何一步失败抛 KikoRpcError（连接不可用即退出，不静默降级）。
   */
  async connect(): Promise<void> {
    if (this.closed) throw this.rpcError(-1, "客户端已关闭");
    await new Promise<void>((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(this.url);
      const guard = setTimeout(() => {
        // 连接超时：废弃本连接（触发 error/close 回调清理）
        ws.terminate();
      }, this.connectTimeoutMs);
      ws.once("open", () => {
        clearTimeout(guard);
        this.ws = ws;
        this.wire(ws);
        resolveConnect();
      });
      ws.once("error", (err) => {
        clearTimeout(guard);
        rejectConnect(this.rpcError(-1, `WS 连接失败（${this.url}）：${String(err)}`));
      });
    });

    // auth：首条消息（5.1；token 配置时强制走完整握手）
    if (this.token !== undefined) {
      await this.request(RPC_METHODS.AUTH, { token: this.token });
    }
    // 全量事件订阅：progress 转发 + 终态等待的数据源
    await this.request(RPC_METHODS.SUBSCRIBE_EVENT, {});
  }

  // ---------------- KikoRpcClient 实现 ----------------

  async discover(): Promise<CapabilitySummary[]> {
    const result = (await this.request(RPC_METHODS.DISCOVER, {})) as {
      capabilities: CapabilitySummary[];
    };
    return result.capabilities;
  }

  async describe(capabilityId: string): Promise<CapabilityDefinition> {
    return (await this.request(RPC_METHODS.DESCRIBE, {
      capability_id: capabilityId,
    })) as CapabilityDefinition;
  }

  async invoke(
    capabilityId: string,
    input: Record<string, unknown>,
    onAccepted?: (invocationId: string) => void,
  ): Promise<ExecutionDetail> {
    // async 受理（立即拿 invocation_id → 事件可按 invocation 匹配）
    const accepted = (await this.request(RPC_METHODS.INVOKE, {
      capability_id: capabilityId,
      input,
      mode: "async",
    })) as { invocation_id: string };
    // progress 路由钩子（受理成功即触发，早于终态等待）
    onAccepted?.(accepted.invocation_id);
    // 等终态事件 → get_execution 取完整详情（result/error/artifacts）
    await this.waitForTerminal(accepted.invocation_id);
    return this.getExecution(accepted.invocation_id);
  }

  subscribeProgress(listener: (event: KikoProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    // 断连清理会统一 reject 全部 pending / waiter（onClose 钩子）
    this.ws?.close();
  }

  // ---------------- 内部：WS 消息接线 ----------------

  /** 挂接消息分发与断连清理（连接建立后一次性调用） */
  private wire(ws: WebSocket): void {
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return; // 非 JSON 帧：忽略（对端违约不影响本端存活）
      }
      const msg = message as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
        method?: string;
        params?: ExecutionEvent;
      };
      // 响应（id 配对）与事件 notification（method = "event"）双分发
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        this.settleRequest(msg.id, msg.result, msg.error);
      } else if (msg.method === EVENT_NOTIFICATION_METHOD && msg.params !== undefined) {
        this.dispatchEvent(msg.params);
      }
    });
    ws.once("close", () => this.handleDisconnect("连接关闭"));
    ws.once("error", (err) => this.handleDisconnect(`连接异常：${String(err)}`));
  }

  /** JSON-RPC 请求（id 配对 + 超时） */
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.rpcError(-1, "WS 未连接"));
    }
    const id = ++this.seq;
    return new Promise((resolveReq, rejectReq) => {
      // invoke 等终态（受 capability timeout 兜底）放宽硬上限
      const budget = method === RPC_METHODS.INVOKE ? INVOKE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(this.rpcError(-1, `请求超时（${budget}ms）：${method}`));
      }, budget);
      this.pending.set(id, {
        resolve: resolveReq,
        reject: rejectReq,
        timer,
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** 响应到达：resolve / reject（JSON-RPC error → KikoRpcError 透传 code/data） */
  private settleRequest(
    id: number,
    result: unknown,
    error: { code: number; message: string; data?: unknown } | undefined,
  ): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      pending.reject(this.rpcError(error.code, error.message, error.data));
    } else {
      pending.resolve(result);
    }
  }

  /** 事件 notification 分发：终态缓存 / 等待者唤醒 / progress 监听 */
  private dispatchEvent(event: ExecutionEvent): void {
    if (
      event.event === EVENT_TYPES.EXECUTION_COMPLETED ||
      event.event === EVENT_TYPES.EXECUTION_FAILED ||
      event.event === EVENT_TYPES.EXECUTION_CANCELLED
    ) {
      const waiter = this.terminalWaiters.get(event.invocation_id);
      if (waiter !== undefined) {
        this.terminalWaiters.delete(event.invocation_id);
        clearTimeout(waiter.timer);
        waiter.resolve("event");
      } else {
        // 等待者未注册（invoke 响应尚未到达的竞态）：缓存待查
        if (this.terminalEvents.size >= TERMINAL_CACHE_LIMIT) {
          const oldest = this.terminalEvents.keys().next().value;
          if (oldest !== undefined) this.terminalEvents.delete(oldest);
        }
        this.terminalEvents.set(event.invocation_id, event);
      }
      return;
    }
    if (event.event === EVENT_TYPES.EXECUTION_PROGRESS) {
      // data 形状由 runtime 桥接自 host progress 消息（percent + 可选 message）
      const percent = event.data["percent"];
      if (typeof percent !== "number") return;
      const progressEvent: KikoProgressEvent = {
        invocationId: event.invocation_id,
        percent,
        message: typeof event.data["message"] === "string" ? event.data["message"] : undefined,
      };
      for (const listener of this.progressListeners) {
        try {
          listener(progressEvent);
        } catch {
          // 单个监听者异常不阻断事件链（与 EventManager 同策略）
        }
      }
    }
  }

  /** 等待 invocation 终态（缓存命中即返；否则注册 waiter） */
  private waitForTerminal(invocationId: string): Promise<void> {
    // 竞态兜底：终态事件先于 invoke 响应到达（缓存命中）
    if (this.terminalEvents.delete(invocationId)) return Promise.resolve();
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.terminalWaiters.delete(invocationId);
        rejectWait(this.rpcError(-1, `等待终态超时：${invocationId}`));
      }, INVOKE_TIMEOUT_MS);
      this.terminalWaiters.set(invocationId, {
        resolve: () => resolveWait(),
        reject: rejectWait,
        timer,
      });
    });
  }

  /** get_execution（ExecutionDetail 全量：result / error / artifacts） */
  private async getExecution(invocationId: string): Promise<ExecutionDetail> {
    return (await this.request(RPC_METHODS.GET_EXECUTION, {
      invocation_id: invocationId,
    })) as ExecutionDetail;
  }

  /** 断连统一清理：pending / 终态等待者全部失败（上层据此退出进程） */
  private handleDisconnect(reason: string): void {
    const err = this.rpcError(-1, `Kiko 服务连接不可用：${reason}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    for (const waiter of this.terminalWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.terminalWaiters.clear();
  }

  /** 构造带协议 code/data 的 KikoRpcError */
  private rpcError(code: number, message: string, data?: unknown): KikoRpcError {
    const error = new Error(message) as KikoRpcError;
    error.code = code;
    error.data = data;
    return error;
  }
}
