/**
 * 本地 RPC Server（设计文档 5.1 传输层 / 5.3 / 5.4 / R3；M1-11 + M2-02）
 *
 * 职责：
 *   - 单端口承载 5.1 定义的双通道（仅绑定 127.0.0.1，第 3 节要点 2）：
 *       * WebSocket（主）：全部方法 + 事件推送（subscribe_event 仅 WS）
 *       * HTTP POST /rpc：同步方法（无法接收推送）
 *     实现为 http.createServer + WebSocketServer({ noServer }) 同端口挂载
 *     （47830 是文档唯一定义的对外端口；客户端只需发现一个端口）
 *   - M2-02 鉴权（5.1）：
 *       * WS：连接后首条消息必须为 auth；失败 / 未鉴权先发他法 →
 *         回 -32001 错误响应后关闭连接
 *       * HTTP：Authorization: Bearer <token>；缺失 / 错误 → 401（body
 *         同时携带 -32001 JSON-RPC error，双信息载体）
 *       * authToken 未配置（undefined）→ 无鉴权模式（M1 兼容 / 内部注入
 *         场景；生产装配必须传入 token）
 *   - 端口策略（R3）：从默认 47830 起逐个尝试，EADDRINUSE → 端口 +1
 *     重试（上限 10 次），全部占用才失败
 *   - 方法路由委托 RpcRouter（WS / HTTP 共享，M2-02 抽出）
 *
 * 设计要点：
 *   - 依赖全部注入（registry / invocation / runtime / events / state），
 *     本类只做传输层适配、鉴权状态机与方法路由委托，不含业务逻辑
 *   - 事件推送经 EventManager 全量监听 → 按连接订阅 filter 分发
 *     （5.4：无 id 的 notification，method = "event"；仅已鉴权 WS 会话）
 *   - RpcError（含 code/message/data）透传为 JSON-RPC error 响应；
 *     其他异常统一包装 -32603（与 8.5 错误透传语义一致的传输层版）
 *   - sync invoke 阻塞至终态（router 内 runtime.waitForSettled）
 */
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ERROR_CODES,
  EVENT_NOTIFICATION_METHOD,
  RPC_METHODS,
  RpcError,
  decodeRpcMessageText,
  encodeError,
  encodeNotification,
  encodeSuccess,
  type ExecutionEvent,
  type RpcId,
  type RpcResponse,
} from "@kiko-workbench/protocol";
import type { CapabilityRegistry } from "./registry.js";
import type { InvocationManager } from "./invocation.js";
import type { ExecutionRuntime } from "./runtime.js";
import type { EventManager, StateManager } from "./state.js";
import { RpcRouter, type WsSessionContext } from "./rpc-router.js";

/** 组装依赖（全部注入，传输层零业务逻辑；events 用于事件推送接线） */
export interface WsRpcServerDeps {
  registry: CapabilityRegistry;
  invocation: InvocationManager;
  runtime: ExecutionRuntime;
  events: EventManager;
  state: StateManager;
}

export interface WsRpcServerOptions {
  /** 起始端口（缺省 47830，设计文档第 3 节要点 2） */
  port?: number;
  /** 绑定地址（缺省 127.0.0.1：仅本地回环，不暴露局域网） */
  host?: string;
  /** 端口占用 +1 重试上限（R3：缺省 10） */
  maxPortRetries?: number;
  /**
   * WS auth / HTTP Bearer 校验的 access_token（M2-02，5.1）。
   * 缺省 undefined → 无鉴权模式（M1 兼容 / 单测内部注入）。
   */
  authToken?: string;
}

/** 默认端口（设计文档第 3 节要点 2：对外服务默认端口 47830） */
const DEFAULT_PORT = 47830;
/** 默认绑定地址（设计文档第 3 节要点 2：只绑定 127.0.0.1） */
const DEFAULT_HOST = "127.0.0.1";
/** R3：端口占用重试上限 10 次 */
const DEFAULT_MAX_PORT_RETRIES = 10;
/** HTTP 通道路径（设计文档 5.1：POST /rpc） */
const HTTP_RPC_PATH = "/rpc";

/** 单连接会话：鉴权状态 + 订阅状态（authToken 启用时 authenticated 才可 true） */
interface ClientSession {
  ws: WebSocket;
  /** 已通过 auth（无鉴权模式恒 true） */
  authenticated: boolean;
  /** 事件过滤（invocationId 缺省 = 全量；subscription 缺省 = 未订阅） */
  subscription?: { invocationId?: string };
}

export class WsRpcServer {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private listeningPort = 0;
  private readonly sessions = new Set<ClientSession>();
  private readonly options: Required<Omit<WsRpcServerOptions, "authToken">> & {
    authToken: string | undefined;
  };
  private readonly router: RpcRouter;

  constructor(
    private readonly deps: WsRpcServerDeps,
    options: WsRpcServerOptions = {},
  ) {
    this.options = {
      port: options.port ?? DEFAULT_PORT,
      host: options.host ?? DEFAULT_HOST,
      maxPortRetries: options.maxPortRetries ?? DEFAULT_MAX_PORT_RETRIES,
      authToken: options.authToken,
    };
    // 双通道共享的方法路由（业务依赖经 router 注入，传输层只管协议适配）
    this.router = new RpcRouter({
      registry: deps.registry,
      invocation: deps.invocation,
      runtime: deps.runtime,
      state: deps.state,
    });
    // 事件推送接线：EventManager 全量监听 → 按 session filter 分发（5.4）。
    // 单一 server 级监听器，连接增减不影响订阅关系（连接态由 session 表维护）
    this.deps.events.subscribe((event) => this.broadcastEvent(event));
  }

  // ---------------- 生命周期（R3 端口探测） ----------------

  /**
   * 启动：从 options.port 起逐个尝试绑定（http server 承载 WS upgrade），
   * EADDRINUSE → +1 重试，上限 maxPortRetries 次；全部占用抛 INTERNAL_ERROR。
   */
  async start(): Promise<void> {
    if (this.httpServer !== null)
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, "RPC Server 已启动");
    for (let attempt = 0; attempt <= this.options.maxPortRetries; attempt++) {
      const port = this.options.port + attempt;
      // 端口探测必须串行（前一端口释放前不可试下一个）
      if (await this.tryListen(port)) return;
    }
    throw new RpcError(
      ERROR_CODES.INTERNAL_ERROR,
      `RPC 端口 ${this.options.port}~${this.options.port + this.options.maxPortRetries} 均被占用（R3 重试上限耗尽）`,
    );
  }

  /** 尝试绑定单端口：成功 true；EADDRINUSE false（换下一个）；其他错误抛出（不重试） */
  private tryListen(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // noServer：WS 不自行监听，挂载到 http server 的 upgrade 事件（同端口双通道）
      const wss = new WebSocketServer({ noServer: true });
      const httpServer = createServer((req, res) => {
        this.handleHttpRequest(req, res).catch(() => {
          // HTTP 处理链兜底（理论不可达：handleHttpRequest 全量捕获）
        });
      });
      httpServer.on("upgrade", (req, socket, head) => {
        // 全部 upgrade 请求按 WS 对待（单端口单协议语义；路径不校验）
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });
      httpServer.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") {
          // R3：端口被占 → 关闭本次尝试，外层 +1 重试
          wss.close();
          httpServer.close();
          resolve(false);
          return;
        }
        // 权限 / 地址不可用等确定性失败：重试无意义
        wss.close();
        reject(e);
      });
      httpServer.listen(port, this.options.host, () => {
        // listening 回调：绑定成功
        this.httpServer = httpServer;
        this.wss = wss;
        this.listeningPort = port;
        this.attachServer(wss);
        resolve(true);
      });
    });
  }

  /** 停止：关闭全部连接与监听（headless 退出 / 测试清理用） */
  async stop(): Promise<void> {
    const wss = this.wss;
    const httpServer = this.httpServer;
    if (wss === null || httpServer === null) return;
    this.httpServer = null;
    this.wss = null;
    // 先主动断开全部会话再关监听：wss.close() 会等待客户端完成 close
    // 握手，客户端失联 / 不响应时 stop 长时间悬挂（实测 4s+，依赖 Node
    // 空闲连接超时兜底）；terminate 立即断 TCP，服务端退出不依赖客户端配合
    for (const session of this.sessions) {
      try {
        session.ws.terminate();
      } catch {
        // 连接已死：无需处理
      }
    }
    this.sessions.clear();
    // 再关 WS 实例与 http 监听；await 汇聚两路完成
    await Promise.all([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    ]);
  }

  /** 实际监听端口（start 后可用；R3 +1 重试后可能与请求端口不同） */
  get port(): number {
    return this.listeningPort;
  }

  // ---------------- WS 连接与会话管理 ----------------

  private attachServer(wss: WebSocketServer): void {
    wss.on("connection", (ws) => {
      // 无鉴权模式直接放行；鉴权模式等待首条 auth（5.1）
      const session: ClientSession = {
        ws,
        authenticated: this.options.authToken === undefined,
      };
      this.sessions.add(session);
      ws.on("message", (data: unknown) => {
        // 异步分发：响应按原路回写（notification 无响应；
        // 鉴权失败场景 handleWsMessage 内部已自行回写并关闭）
        void this.handleWsMessage(session, String(data))
          .then((response) => {
            if (response !== null) ws.send(JSON.stringify(response));
          })
          .catch(() => {
            // 分发链兜底（理论不可达：handleWsMessage 全量捕获，防御未处理拒绝）
          });
      });
      // 断连 / 传输异常：移除会话（订阅随连接消亡）
      ws.on("close", () => this.sessions.delete(session));
      ws.on("error", () => this.sessions.delete(session));
    });
  }

  /**
   * 处理单条 WS 消息：鉴权状态机 → 解析 → 路由 → 响应。
   * notification（无 id）返回 null（JSON-RPC 规范：不回响应）；
   * malformed 消息返回 id=null 的错误响应（无法辨识请求 id）。
   * 鉴权失败：内部直接回写 -32001 响应并关闭连接（返回 null，外层
   * 不再重复回写——见 rejectAndClose 的顺序说明）。
   */
  async handleWsMessage(session: ClientSession, raw: string): Promise<RpcResponse | null> {
    let id: RpcId | null = null;
    try {
      const message = decodeRpcMessageText(raw);
      // notification（无 id）不回响应（JSON-RPC 规范；直判收窄类型，
      // 等价 isNotification）
      if (message.id === undefined) return null;
      id = message.id;

      // ---- 鉴权状态机（M2-02，5.1：首条消息必须为 auth） ----
      if (!session.authenticated) {
        if (message.method !== RPC_METHODS.AUTH) {
          // 未鉴权先发他法：-32001 + 关闭（"失败关闭连接"）
          this.rejectAndClose(session, message.id, "未鉴权：连接后首条消息必须为 auth");
          return null;
        }
        const token = message.params?.["token"];
        if (typeof token !== "string" || !tokenEquals(token, this.options.authToken)) {
          this.rejectAndClose(session, message.id, "token 错误");
          return null;
        }
        session.authenticated = true;
        return encodeSuccess(message.id, { authenticated: true });
      }
      // 已鉴权后再发 auth：幂等成功（重复握手无害，客户端重连逻辑简单）
      if (message.method === RPC_METHODS.AUTH) {
        return encodeSuccess(message.id, { authenticated: true });
      }

      const context: WsSessionContext = { kind: "ws", subscription: session.subscription };
      const result = await this.router.dispatch(context, message.method, message.params);
      // 订阅状态回写：subscribe_event 在 context 上更新 filter（传输层拥有
      // session，路由层不感知连接——经 context 传递、回写落盘）
      session.subscription = context.subscription;
      return encodeSuccess(message.id, result);
    } catch (e) {
      // RpcError 透传 code/message/data；其他异常统一 -32603（内部错误）
      const error = e instanceof RpcError ? e : new RpcError(ERROR_CODES.INTERNAL_ERROR, String(e));
      return encodeError(id, error);
    }
  }

  /**
   * 鉴权失败收尾：回 -32001 错误响应后关闭连接（5.1）。
   *
   * 顺序关键：必须先 send 再 close——ws 库的 close() 会立即把 readyState
   * 置为 CLOSING，此后 send() 直接报错（响应丢失，客户端只能超时）；
   * 而先 send 时数据帧已入发送队列，close() 的握手帧排在队列尾部，
   * TCP 有序保证错误响应一定先于连接关闭送达客户端。
   */
  private rejectAndClose(session: ClientSession, id: RpcId, message: string): void {
    try {
      session.ws.send(
        JSON.stringify(encodeError(id, new RpcError(ERROR_CODES.AUTH_FAILED, message))),
      );
    } catch {
      // 连接已死（send 抛错）：响应发不出，直接关闭
    }
    this.closeSession(session);
  }

  /** 关闭连接并移除会话（鉴权失败 / 服务端主动断连用） */
  private closeSession(session: ClientSession): void {
    this.sessions.delete(session);
    // close 有握手过程（close frame），已 send 的响应帧先行送达
    session.ws.close();
  }

  // ---------------- HTTP 通道（POST /rpc + Bearer，5.1） ----------------

  /**
   * HTTP 请求处理：
   *   - POST /rpc + 合法 Bearer → JSON-RPC 响应（200）
   *   - 鉴权缺失 / 错误 → 401（body 携带 -32001 JSON-RPC error）
   *   - 非 POST → 405；非 /rpc 路径 → 404
   *   - JSON-RPC 层错误（-32xxx / 4xxxxx / 5xxxxx）→ 200 + error body
   */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST") {
        res
          .writeHead(405, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }
      if (req.url !== HTTP_RPC_PATH && req.url !== `${HTTP_RPC_PATH}/`) {
        res
          .writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      // Bearer 校验（5.1：Authorization: Bearer <token>；M2 验收门：401）
      if (this.options.authToken !== undefined) {
        const bearer = extractBearer(req.headers["authorization"]);
        if (bearer === undefined || !tokenEquals(bearer, this.options.authToken)) {
          // 401 + JSON-RPC -32001 双载体（HTTP 状态码语义 + 协议错误码）
          const body = encodeError(null, new RpcError(ERROR_CODES.AUTH_FAILED));
          res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify(body));
          return;
        }
      }

      const raw = await readRequestBody(req);
      const response = await this.handleHttpRpc(raw);
      // notification（无 id）无响应可回：200 空体（HTTP 无推送语义）
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(response === null ? "" : JSON.stringify(response));
    } catch (e) {
      // 传输层意外异常（读 body 失败等）：500（HTTP 层错误，非 JSON-RPC 层）
      const error = e instanceof RpcError ? e : new RpcError(ERROR_CODES.INTERNAL_ERROR, String(e));
      res
        .writeHead(error.code === ERROR_CODES.AUTH_FAILED ? 401 : 500, {
          "Content-Type": "application/json",
        })
        .end(JSON.stringify(encodeError(null, error)));
    }
  }

  /** 单条 HTTP JSON-RPC 消息处理（与 WS 同构：解析 → 路由 → 响应） */
  private async handleHttpRpc(raw: string): Promise<RpcResponse | null> {
    let id: RpcId | null = null;
    try {
      const message = decodeRpcMessageText(raw);
      if (message.id === undefined) {
        // notification 无响应可回（HTTP 无推送语义）；返回 200 空体
        return null;
      }
      id = message.id;
      const result = await this.router.dispatch({ kind: "http" }, message.method, message.params);
      return encodeSuccess(message.id, result);
    } catch (e) {
      const error = e instanceof RpcError ? e : new RpcError(ERROR_CODES.INTERNAL_ERROR, String(e));
      return encodeError(id, error);
    }
  }

  // ---------------- 事件推送（5.4，仅 WS） ----------------

  /** 按会话订阅过滤广播：未鉴权 / 未订阅跳过；filter.invocation_id 不匹配跳过 */
  private broadcastEvent(event: ExecutionEvent): void {
    for (const session of this.sessions) {
      if (!session.authenticated) continue;
      const sub = session.subscription;
      if (sub === undefined) continue;
      if (sub.invocationId !== undefined && sub.invocationId !== event.invocation_id) continue;
      try {
        // ExecutionEvent 的字段形状即 5.4 params（event/invocation_id/timestamp/data）
        session.ws.send(
          JSON.stringify(encodeNotification(EVENT_NOTIFICATION_METHOD, { ...event })),
        );
      } catch {
        // 连接已死（send 抛错）：忽略；close 事件会清理 session
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 传输层工具
// ---------------------------------------------------------------------------

/** 读取请求 body（上限保护：超出 1MB 截断为解析失败） */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        // 超限中断：本地单机通道正常请求远小于 1MB，恶意超大体直接拒收
        req.destroy();
        reject(new RpcError(ERROR_CODES.INVALID_REQUEST, "请求体超过 1MB 上限"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 提取 Authorization: Bearer <token>（其他 scheme / 格式错 → undefined） */
function extractBearer(header: string | string[] | undefined): string | undefined {
  if (header === undefined || Array.isArray(header)) return undefined;
  const match = /^Bearer\s+(.+)$/.exec(header);
  // 正则含必选捕获组 (.+)，exec 命中时组必有值；?. 仅为满足 noUncheckedIndexedAccess
  return match?.[1]?.trim();
}

/** token 定长比较（constant-time 习惯：逐字符异或，不短路泄露长度/前缀信息） */
function tokenEquals(actual: string, expected: string | undefined): boolean {
  if (expected === undefined || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
