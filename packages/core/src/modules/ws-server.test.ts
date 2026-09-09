/**
 * WsRpcServer 单测（M1-11 验收锚点）
 *
 * 验收锚点（5.1 / 5.3 / 5.4 / R3）：
 *   - WS 全链路 discover → describe → invoke(sync) → get_execution 跑通
 *   - R3：端口占用 +1 重试（上限 10）与耗尽报错
 *   - R4：discover 响应不含 schema 字段（契约锁定，双保险）
 *   - 错误映射：40001 / 40002（含 ajv 明细）/ 40003 / 40004 /
 *     -32600（malformed）/ -32601（未知方法）/ -32602（缺必填参数）
 *   - subscribe_event：全量 / filter 按 invocation_id；事件以 5.4
 *     notification 形式推送
 *   - invoke sync 失败 → result 带 error（非 JSON-RPC error 响应）
 *
 * 测试用真实 ws 客户端连接真实 server（127.0.0.1），插件进程经
 * ProcessLauncher 注入 TestProcess（自动应答：load → loaded、
 * invoke → result，与生产 utilityProcess 同构）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import WebSocket from "ws";
import { ExecutionRuntime, type ProcessLauncher } from "./runtime.js";
import { WsRpcServer } from "./ws-server.js";
import { InvocationManager } from "./invocation.js";
import { EventManager, LogManager, StateManager } from "./state.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryEventStore, MemoryLogStore, MemoryStateStore } from "../stores/memory-stores.js";
import type { CapabilityRegistry, PluginRecord } from "./registry.js";
import type { HostCommand, HostEvent } from "@kiko-workbench/plugin-sdk";
import { ERROR_CODES, RpcError, type CapabilityDefinition } from "@kiko-workbench/protocol";

// ---------------------------------------------------------------------------
// TestProcess：自动应答假进程（load → loaded；invoke → 可配置回复）
// ---------------------------------------------------------------------------

/** invoke 自动回复：缺省成功 result，可按用例替换为 error；null = 不自动应答（长任务模式） */
type InvokeReply = (
  cmd: Extract<HostCommand, { type: "invoke" }>,
) => Extract<HostEvent, { type: "result" | "error" }> | null;

class TestProcess {
  readonly sent: HostCommand[] = [];
  private readonly msgListeners = new Set<(event: HostEvent) => void>();
  private readonly exitListeners = new Set<() => void>();
  exited = false;

  /** 默认成功应答（恢复基准：挂起模式不得跨用例泄漏——否则后续 warmup
   * invoke 无应答，只能靠能力 timeout 兜底，用例集体撞超时线） */
  readonly defaultReply: InvokeReply = (cmd) => ({
    type: "result",
    invocationId: cmd.invocationId,
    result: { ok: true },
  });

  /** invoke 命令的自动回复（缺省成功 { ok: true }；返回 null = 挂起等测试手动驱动） */
  invokeReply: InvokeReply = this.defaultReply;

  /** cancel 命令行为（M2-03）：cooperative 检查点退出（自动回 cancelled）；
   * ignore 模拟不协作插件（不响应 → 主进程宽限强杀路径） */
  cancelBehavior: "cooperative" | "ignore" = "cooperative";

  send(command: HostCommand): void {
    this.sent.push(command);
    // 自动应答经宏任务延迟（模拟真实进程异步；此刻监听器已挂好）
    if (command.type === "load") {
      setTimeout(() => this.emit({ type: "loaded", capabilities: ["file.write"] }), 0);
    } else if (command.type === "invoke") {
      // 回调返回 null = 长任务模式：不自动应答，由测试手动 emit（progress/
      // result/cancelled）驱动——避免把 undefined 喂进消息监听链
      const reply = this.invokeReply(command);
      if (reply !== null) setTimeout(() => this.emit(reply), 0);
    } else if (command.type === "cancel" && this.cancelBehavior === "cooperative") {
      // 协作取消：检查点立即退出并上报（模拟 ctx.isCancelled 轮询命中的插件）
      setTimeout(() => this.emit({ type: "cancelled", invocationId: command.invocationId }), 0);
    }
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener();
  }

  onMessage(listener: (event: HostEvent) => void): () => void {
    this.msgListeners.add(listener);
    return () => this.msgListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** 上行事件（host → main） */
  emit(event: HostEvent): void {
    if (this.exited) return;
    for (const listener of this.msgListeners) listener(event);
  }
}

// ---------------------------------------------------------------------------
// 测试组装（registry stub + 真实 Manager + 自动应答 launcher）
// ---------------------------------------------------------------------------

/** 测试能力：input_schema 带 required（40002 用例需要严格校验） */
const CAPABILITY: CapabilityDefinition = {
  id: "file.write",
  name: "Write File",
  description: "Write file to workspace",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  output_schema: { type: "object" },
  timeout_ms: 5_000,
};

/** Registry stub：单 file 插件 + file.write 能力（discover/describe/resolve） */
function makeRegistry(): CapabilityRegistry & {
  discover: CapabilityRegistry["discover"];
  describe: CapabilityRegistry["describe"];
} {
  const plugin: PluginRecord = {
    id: "file",
    name: "File",
    description: "File access plugin",
    version: "1.0.0",
    entry: "index.js",
    permissions: ["filesystem.write"],
    status: "enabled",
    rootDir: "/plugins/file",
  };
  return {
    resolveCapability: (capabilityId: string) => {
      if (capabilityId !== "file.write") {
        throw new RpcError(ERROR_CODES.CAPABILITY_NOT_FOUND, `能力不存在：${capabilityId}`);
      }
      return { plugin, definition: CAPABILITY };
    },
    getPlugin: () => plugin,
    setPluginStatus: () => undefined,
    discover: (query?: string) => {
      // 摘要键集精确（R4：id/name/description/plugin，无 schema 字段）
      if (query !== undefined && !CAPABILITY.name.toLowerCase().includes(query.toLowerCase())) {
        return [];
      }
      return [
        {
          id: CAPABILITY.id,
          name: CAPABILITY.name,
          description: CAPABILITY.description,
          plugin: "file",
        },
      ];
    },
    describe: (capabilityId: string) => {
      if (capabilityId !== "file.write") {
        throw new RpcError(ERROR_CODES.CAPABILITY_NOT_FOUND, `能力不存在：${capabilityId}`);
      }
      return CAPABILITY;
    },
  } as unknown as CapabilityRegistry;
}

/** 全套真实 Manager + WsRpcServer + 收集的假进程（options 透传 server / runtime 构造） */
async function setupServer(options?: {
  port?: number;
  authToken?: string;
  /** 协作取消宽限（默认 5s；强杀用例注入短值避免长等） */
  cancelGraceMs?: number;
}) {
  const registry = makeRegistry();
  const state = new StateManager(new MemoryStateStore());
  const events = new EventManager(new MemoryEventStore());
  const logs = new LogManager(new MemoryLogStore());
  const workspace = new WorkspaceManager({ documentsDir: root });

  const cancelBridge: { hook?: (invocationId: string) => void } = {};
  let seq = 0;
  const invocation = new InvocationManager({
    registry,
    state,
    events,
    logs,
    generateId: () => `t${String(++seq).padStart(11, "0")}`,
    onCancelRequested: (id) => cancelBridge.hook?.(id),
  });

  const procs: TestProcess[] = [];
  const launcher: ProcessLauncher = () => {
    const proc = new TestProcess();
    procs.push(proc);
    return proc;
  };
  const runtime = new ExecutionRuntime({
    registry,
    invocation,
    state,
    events,
    logs,
    workspace,
    // S8 扩展字段（PluginContext.esbuildBinaryPath 注入源）：单测占位
    esbuildBinaryPath: "/fake/esbuild.exe",
    launcher,
    cancelGraceMs: options?.cancelGraceMs,
  });
  cancelBridge.hook = (id) => runtime.onCancelRequested(id);

  const server = new WsRpcServer({ registry, invocation, runtime, events, state }, options);
  await server.start();
  return { server, invocation, state, procs };
}

// ---------------------------------------------------------------------------
// WS 客户端辅助（按 id 分流响应 / 无 id 即 notification）
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  params?: Record<string, unknown>;
}

/** 测试客户端：request 按 id 配对；notification 进队列 */
class TestClient {
  private static nextId = 0;
  readonly ws: WebSocket;
  private readonly pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private readonly notifications: JsonRpcMessage[] = [];
  private readonly notificationWaiters: Array<(msg: JsonRpcMessage) => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data: unknown) => {
      const msg = JSON.parse(String(data)) as JsonRpcMessage;
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
        return;
      }
      // notification（5.4 事件推送）：优先喂等待者，否则入队
      const waiter = this.notificationWaiters.shift();
      if (waiter !== undefined) waiter(msg);
      else this.notifications.push(msg);
    });
  }

  /** 等待连接建立 */
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e: Error) => reject(e));
    });
  }

  /** 发送请求并等待对应 id 的响应 */
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = ++TestClient.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** 发送原始文本（malformed 用例）并等待任意响应（按到达序） */
  sendRawAndWait(text: string): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      const onMessage = (data: unknown) => {
        this.ws.off("message", onMessage);
        resolve(JSON.parse(String(data)) as JsonRpcMessage);
      };
      this.ws.on("message", onMessage);
      this.ws.send(text);
    });
  }

  /** 等待下一条 notification（先消费队列） */
  nextNotification(): Promise<JsonRpcMessage> {
    const queued = this.notifications.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.notificationWaiters.push(resolve));
  }

  /** 队列中不再有 notification（让事件链路稳定后断言空） */
  async drainNotifications(ms = 100): Promise<JsonRpcMessage[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const drained = [...this.notifications];
    this.notifications.length = 0;
    return drained;
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// 组装与清理
// ---------------------------------------------------------------------------

let root: string;
let server: WsRpcServer;
let invocation: InvocationManager;
let state: StateManager;
let procs: TestProcess[];
let main: TestClient;
const clients: TestClient[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kiko-ws-"));
  const assembled = await setupServer({ port: 24783 });
  server = assembled.server;
  invocation = assembled.invocation;
  state = assembled.state;
  procs = assembled.procs;
  main = new TestClient(`ws://127.0.0.1:${server.port}`);
  clients.push(main);
  await main.opened();
});

afterAll(async () => {
  for (const client of clients) client.close();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discover / describe（5.3.1 / 5.3.2）
// ---------------------------------------------------------------------------

describe("discover（5.3.1）", () => {
  it("全量：返回能力摘要；R4 契约——键集精确且序列化产物无 schema 字样", async () => {
    const res = await main.request("discover", {});
    const capabilities = (res.result as { capabilities: unknown[] }).capabilities;
    expect(capabilities).toEqual([
      {
        id: "file.write",
        name: "Write File",
        description: "Write file to workspace",
        plugin: "file",
      },
    ]);
    // 双保险：序列化产物不得含 schema 字段（防 Context 膨胀回归）
    expect(JSON.stringify(res.result)).not.toContain("schema");
  });

  it("query 无匹配 → 空列表", async () => {
    const res = await main.request("discover", { query: "nonexistent" });
    expect((res.result as { capabilities: unknown[] }).capabilities).toEqual([]);
  });
});

describe("describe（5.3.2）", () => {
  it("返回完整定义（含 input_schema / output_schema）", async () => {
    const res = await main.request("describe", { capability_id: "file.write" });
    const definition = res.result as CapabilityDefinition;
    expect(definition.id).toBe("file.write");
    expect(definition.input_schema).toBeDefined();
    expect(definition.output_schema).toBeDefined();
  });

  it("未知能力 → 40001", async () => {
    const res = await main.request("describe", { capability_id: "ghost.capability" });
    expect(res.error?.code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
  });

  it("缺 capability_id → -32602", async () => {
    const res = await main.request("describe", {});
    expect(res.error?.code).toBe(ERROR_CODES.INVALID_PARAMS);
  });
});

// ---------------------------------------------------------------------------
// invoke（5.3.3）
// ---------------------------------------------------------------------------

describe("invoke sync（5.3.3）", () => {
  it("正常路径：阻塞至完成 → { invocation_id, status: completed, result }", async () => {
    const res = await main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
    });
    const result = res.result as {
      invocation_id: string;
      status: string;
      result: unknown;
    };
    expect(result.status).toBe("completed");
    expect(result.invocation_id).toMatch(/^inv_t\d+$/);
    expect(result.result).toEqual({ ok: true });
  });

  it("插件执行失败 → status failed + error 字段（非 JSON-RPC error 响应）", async () => {
    // 替换下一个进程的自动回复为 error（50001）
    const originalReply = currentProc(procs).invokeReply;
    procs[procs.length - 1].invokeReply = (cmd) => ({
      type: "error",
      invocationId: cmd.invocationId,
      error: { code: ERROR_CODES.PLUGIN_EXECUTION_ERROR, message: "写入失败" },
    });
    const res = await main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
    });
    procs[procs.length - 1].invokeReply = originalReply;

    const result = res.result as {
      status: string;
      error: { code: number; message: string };
    };
    expect(res.error).toBeUndefined();
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe(ERROR_CODES.PLUGIN_EXECUTION_ERROR);
    expect(result.error.message).toBe("写入失败");
  });

  it("未知能力 → JSON-RPC error 40001", async () => {
    const res = await main.request("invoke", {
      capability_id: "ghost.capability",
      input: {},
    });
    expect(res.error?.code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
  });

  it("input 缺 required 字段 → JSON-RPC error 40002 + data.errors 含 ajv 明细；invocation 落 failed 可查询", async () => {
    const failedBefore = state.listByStatus("failed").length;
    const res = await main.request("invoke", {
      capability_id: "file.write",
      input: {},
    });
    expect(res.error?.code).toBe(ERROR_CODES.INPUT_VALIDATION_FAILED);
    // 5.5：data.errors 携带 ajv 明细（契约形状锁定）
    const data = res.error?.data as { errors: Array<{ message: string }> };
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors[0]?.message).toContain("path");

    // 行2：校验失败路径的 invocation 落 failed 态（经 state 差值定位新记录）
    const failedRecords = state.listByStatus("failed");
    expect(failedRecords).toHaveLength(failedBefore + 1);
    const record = failedRecords.at(-1);
    expect(record?.error?.code).toBe(ERROR_CODES.INPUT_VALIDATION_FAILED);

    // 该记录经 get_execution 可查询（含事件时间线）
    const detail = await main.request("get_execution", {
      invocation_id: record?.invocation_id,
      include_events: true,
    });
    const execution = detail.result as {
      status: string;
      error: { code: number };
      events: Array<{ event: string }>;
    };
    expect(execution.status).toBe("failed");
    expect(execution.error.code).toBe(ERROR_CODES.INPUT_VALIDATION_FAILED);
    expect(execution.events.map((e) => e.event)).toEqual([
      "invocation.created",
      "execution.failed",
    ]);
  });

  it("input 非对象 → -32602", async () => {
    const res = await main.request("invoke", {
      capability_id: "file.write",
      input: "not-an-object",
    });
    expect(res.error?.code).toBe(ERROR_CODES.INVALID_PARAMS);
  });

  it("产物登记：sync 响应与 get_execution 均携带 artifacts（M2-04，PRD 第 9 节 Result 五分）", async () => {
    // 挂起模式：手动 emit artifact + result——模拟 file.write 的
    // ctx.artifacts.register 时序（先登记产物、后返回业务结果）
    const proc = currentProc(procs);
    const baseline = proc.sent.length; // 共享 sent 队列：按基线取增量命令
    proc.invokeReply = () => null;
    const pending = main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
    });
    try {
      // 等 invoke 命令送达假进程（ws I/O 异步；emit 早于 invocation 创建会被丢）
      const cmd = await waitInvoke(proc, baseline);
      const artifactFile = join(root, "Kiko Workbench", "file", "notes.txt");
      proc.emit({
        type: "artifact",
        invocationId: cmd.invocationId,
        file: artifactFile,
        relativePath: "file/notes.txt",
        filename: "notes.txt",
        mimeType: "text/plain",
        size: 5,
      });
      proc.emit({
        type: "result",
        invocationId: cmd.invocationId,
        result: { path: "file/notes.txt", size: 5 },
      });
      const res = await pending;

      // sync 响应：artifacts 完整五字段（与 7.2 artifacts 表列同构）
      const result = res.result as { artifacts: Array<Record<string, unknown>> };
      expect(result.artifacts).toEqual([
        {
          file: artifactFile,
          relative_path: "file/notes.txt",
          filename: "notes.txt",
          mime_type: "text/plain",
          size: 5,
        },
      ]);

      // get_execution：同一产物可追溯（ExecutionDetail.artifacts 填充）
      const detail = await main.request("get_execution", {
        invocation_id: cmd.invocationId,
      });
      const execution = detail.result as { artifacts: unknown[] };
      expect(execution.artifacts).toEqual(result.artifacts);
    } finally {
      proc.invokeReply = proc.defaultReply;
    }
  });

  it("无产物调用 → 响应不含 artifacts 字段（防响应噪音）", async () => {
    const res = await main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
    });
    expect((res.result as Record<string, unknown>).artifacts).toBeUndefined();
  });
});

describe("invoke async（5.3.3）", () => {
  it("受理即返回 { status: running }；后续事件序列 created → started → completed 推送", async () => {
    const subscriber = new TestClient(`ws://127.0.0.1:${server.port}`);
    clients.push(subscriber);
    await subscriber.opened();
    const subscribed = await subscriber.request("subscribe_event", {});
    expect((subscribed.result as { subscribed: boolean }).subscribed).toBe(true);

    const res = await main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
      mode: "async",
    });
    const asyncResult = res.result as { invocation_id: string; status: string };
    expect(asyncResult.status).toBe("running");

    // 事件序列（5.4 notification：method = "event"）
    const created = await subscriber.nextNotification();
    expect(created.method).toBe("event");
    expect((created.params as { event: string }).event).toBe("invocation.created");
    const started = await subscriber.nextNotification();
    expect((started.params as { event: string }).event).toBe("execution.started");
    const completed = await subscriber.nextNotification();
    expect((completed.params as { event: string }).event).toBe("execution.completed");
    expect((completed.params as { invocation_id: string }).invocation_id).toBe(
      asyncResult.invocation_id,
    );
  });
});

// ---------------------------------------------------------------------------
// get_execution（5.3.4）
// ---------------------------------------------------------------------------

describe("get_execution（5.3.4）", () => {
  it("include_events=true 返回事件时间线；include_events 缺省不含 events 字段", async () => {
    const invokeRes = await main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
    });
    const invocationId = (invokeRes.result as { invocation_id: string }).invocation_id;

    const withEvents = await main.request("get_execution", {
      invocation_id: invocationId,
      include_events: true,
    });
    const detail = withEvents.result as {
      events: Array<{ event: string }>;
      logs?: unknown;
    };
    expect(detail.events.map((e) => e.event)).toEqual([
      "invocation.created",
      "execution.started",
      "execution.completed",
    ]);
    expect(detail.logs).toBeUndefined(); // include_logs 未开

    const withoutEvents = await main.request("get_execution", {
      invocation_id: invocationId,
    });
    expect((withoutEvents.result as { events?: unknown }).events).toBeUndefined();
  });

  it("invocation 不存在 → 40003", async () => {
    const res = await main.request("get_execution", { invocation_id: "inv_ghost" });
    expect(res.error?.code).toBe(ERROR_CODES.INVOCATION_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// subscribe_event（5.3.5）
// ---------------------------------------------------------------------------

describe("subscribe_event（5.3.5）", () => {
  it("filter 按 invocation_id：匹配的推送、不匹配的不推送", async () => {
    // 订阅者 A：全量；订阅者 B：filter 指向一个不存在的 invocation
    const all = new TestClient(`ws://127.0.0.1:${server.port}`);
    const filtered = new TestClient(`ws://127.0.0.1:${server.port}`);
    clients.push(all, filtered);
    await all.opened();
    await filtered.opened();
    await all.request("subscribe_event", {});
    await filtered.request("subscribe_event", {
      filter: { invocation_id: "inv_ghost" },
    });

    // 触发一次执行（产生 created / started / completed 事件）
    await main.request("invoke", {
      capability_id: "file.write",
      input: { path: "notes.txt" },
    });

    // A 收到三条；B 一条不收（100ms 内无 notification 即视为未推送）
    for (const expected of ["invocation.created", "execution.started", "execution.completed"]) {
      const notification = await all.nextNotification();
      expect((notification.params as { event: string }).event).toBe(expected);
    }
    expect(await filtered.drainNotifications()).toEqual([]);
  });

  it("filter.invocation_id 类型错 → -32602", async () => {
    const res = await main.request("subscribe_event", {
      filter: { invocation_id: 123 },
    });
    expect(res.error?.code).toBe(ERROR_CODES.INVALID_PARAMS);
  });
});

// ---------------------------------------------------------------------------
// cancel（5.3.6）
// ---------------------------------------------------------------------------

describe("cancel（5.3.6）", () => {
  it("resolved 态（未执行）取消 → { status: cancelled }", async () => {
    // 直接经 InvocationManager 造 resolved 记录（不经 runtime 执行）
    const record = invocation.createInvocation({
      capabilityId: "file.write",
      input: { path: "pending.txt" },
    });
    const res = await main.request("cancel", { invocation_id: record.invocation_id });
    expect(res.result).toEqual({
      invocation_id: record.invocation_id,
      status: "cancelled",
    });
  });

  it("终态再取消 → 40004", async () => {
    const record = invocation.createInvocation({
      capabilityId: "file.write",
      input: { path: "pending.txt" },
    });
    await main.request("cancel", { invocation_id: record.invocation_id });
    const res = await main.request("cancel", { invocation_id: record.invocation_id });
    expect(res.error?.code).toBe(ERROR_CODES.ILLEGAL_STATE_OPERATION);
  });
});

// ---------------------------------------------------------------------------
// 协议层（5.2 / 5.5）
// ---------------------------------------------------------------------------

describe("协议层错误处理（5.2 / 5.5）", () => {
  it("未知方法 → -32601", async () => {
    const res = await main.request("unknown.method", {});
    expect(res.error?.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
  });

  it("malformed 消息 → -32600 且 id 为 null", async () => {
    const res = await main.sendRawAndWait("not a json");
    expect(res.error?.code).toBe(ERROR_CODES.INVALID_REQUEST);
    expect(res.id).toBeNull();
  });

  it("batch 消息（数组）→ -32600", async () => {
    const res = await main.sendRawAndWait('[{ "jsonrpc": "2.0" }]');
    expect(res.error?.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });

  it("notification（无 id）不回响应：发送后正常请求仍可用", async () => {
    main.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "discover" }));
    const res = await main.request("discover", {});
    expect(res.result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R3：端口占用探测
// ---------------------------------------------------------------------------

describe("端口策略（R3）", () => {
  /** 占住一个临时端口，返回 { port, release } */
  function blockPort(): Promise<{ port: number; release: () => Promise<void> }> {
    return new Promise((resolve) => {
      const blocker: Server = createServer();
      blocker.listen(0, "127.0.0.1", () => {
        const port = (blocker.address() as { port: number }).port;
        resolve({
          port,
          release: () =>
            new Promise<void>((done) => {
              blocker.close(() => done());
            }),
        });
      });
    });
  }

  it("起始端口被占 → +1 重试绑定下一端口", async () => {
    const blocker = await blockPort();
    const assembled = await setupServer({ port: blocker.port });
    try {
      expect(assembled.server.port).toBe(blocker.port + 1);
    } finally {
      await assembled.server.stop();
      await blocker.release();
    }
  });

  it("连续占用超上限 → 启动失败（INTERNAL_ERROR）", async () => {
    const blockers: Array<{ release: () => Promise<void> }> = [];
    const base = await blockPort();
    blockers.push(base);
    // 占满 base.port ~ base.port+10（R3 上限 10 次重试 = 11 个候选端口）
    for (let i = 0; i < 10; i++) {
      blockers.push(await blockPortOnPort(base.port + 1 + i));
    }
    const { server: doomed } = await (async () => {
      // 复用组装但不 start：单独驱动 start 断言失败
      const registry = makeRegistry();
      const state = new StateManager(new MemoryStateStore());
      const events = new EventManager(new MemoryEventStore());
      const logs = new LogManager(new MemoryLogStore());
      const workspace = new WorkspaceManager({ documentsDir: root });
      const cancelBridge: { hook?: (invocationId: string) => void } = {};
      const inv = new InvocationManager({
        registry,
        state,
        events,
        logs,
        onCancelRequested: (id) => cancelBridge.hook?.(id),
      });
      const runtime = new ExecutionRuntime({
        registry,
        invocation: inv,
        state,
        events,
        logs,
        workspace,
        userPluginsRoot: "/user-plugins",
        // S8 扩展字段（PluginContext.esbuildBinaryPath 注入源）：单测占位
        esbuildBinaryPath: "/fake/esbuild.exe",
        launcher: () => {
          throw new Error("不应启动进程");
        },
      });
      return {
        server: new WsRpcServer(
          { registry, invocation: inv, runtime, events, state },
          { port: base.port, maxPortRetries: 10 },
        ),
      };
    })();
    await expect(doomed.start()).rejects.toThrow(/均被占用/);
    await doomed.stop();
    for (const blocker of blockers.reverse()) await blocker.release();
  });
});

/** 在指定端口占住一个监听（端口探测耗尽用例） */
function blockPortOnPort(port: number): Promise<{ release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const blocker: Server = createServer();
    blocker.once("error", (e: Error) => reject(e));
    blocker.listen(port, "127.0.0.1", () => {
      resolve({
        release: () =>
          new Promise<void>((done) => {
            blocker.close(() => done());
          }),
      });
    });
  });
}

/** 当前进程（最近启动的假进程） */
function currentProc(procs: TestProcess[]): TestProcess {
  const proc = procs.at(-1);
  if (proc === undefined) throw new Error("尚无进程被启动");
  return proc;
}

// ---------------------------------------------------------------------------
// M2-02：WS auth 鉴权状态机 + HTTP POST /rpc 通道（5.1）
// ---------------------------------------------------------------------------

/** 鉴权测试专用 token（64 字符 hex 形态与生产一致） */
const AUTH_TOKEN = "a".repeat(64);
/** 鉴权 server 独立实例（既有 server 为无鉴权模式，互不干扰） */
let authServer: WsRpcServer;

beforeAll(async () => {
  const assembled = await setupServer({ port: 24784, authToken: AUTH_TOKEN });
  authServer = assembled.server;
});

afterAll(async () => {
  await authServer.stop();
});

describe("WS 鉴权状态机（M2-02，5.1）", () => {
  /** 新建到鉴权 server 的连接 */
  async function openAuthClient(): Promise<TestClient> {
    const client = new TestClient(`ws://127.0.0.1:${authServer.port}`);
    clients.push(client);
    await client.opened();
    return client;
  }

  /** 等待连接关闭（鉴权失败后 server 主动 close） */
  function waitClose(client: TestClient): Promise<void> {
    return new Promise((resolve) => client.ws.once("close", () => resolve()));
  }

  it("未鉴权先发 discover → -32001 + 连接被关闭", async () => {
    const client = await openAuthClient();
    const closed = waitClose(client);
    const res = await client.request("discover", {});
    expect(res.error?.code).toBe(ERROR_CODES.AUTH_FAILED);
    // 5.1："失败关闭连接"——错误响应送达后连接终止
    await closed;
  });

  it("错 token auth → -32001 + 连接被关闭", async () => {
    const client = await openAuthClient();
    const closed = waitClose(client);
    const res = await client.request("auth", { token: "b".repeat(64) });
    expect(res.error?.code).toBe(ERROR_CODES.AUTH_FAILED);
    await closed;
  });

  it("正确 token auth → { authenticated: true }，后续方法正常", async () => {
    const client = await openAuthClient();
    const authRes = await client.request("auth", { token: AUTH_TOKEN });
    expect(authRes.result).toEqual({ authenticated: true });
    // 鉴权通过后全方法可用（发现链路回归）
    const res = await client.request("discover", {});
    expect(res.result).toBeDefined();
    client.close();
  });

  it("已鉴权后再发 auth → 幂等成功（重复握手无害）", async () => {
    const client = await openAuthClient();
    await client.request("auth", { token: AUTH_TOKEN });
    const again = await client.request("auth", { token: AUTH_TOKEN });
    expect(again.result).toEqual({ authenticated: true });
    client.close();
  });

  it("auth 参数缺 token → -32001（类型校验在鉴权层）", async () => {
    const client = await openAuthClient();
    const closed = waitClose(client);
    const res = await client.request("auth", {});
    expect(res.error?.code).toBe(ERROR_CODES.AUTH_FAILED);
    await closed;
  });
});

describe("HTTP POST /rpc 通道（M2-02，5.1）", () => {
  /** 发 HTTP JSON-RPC 请求（Bearer 可选）；返回 { status, body } */
  async function httpRpc(
    payload: string,
    options?: { authorization?: string; method?: string; path?: string },
  ): Promise<{ status: number; body: string }> {
    const method = options?.method ?? "POST";
    const path = options?.path ?? "/rpc";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.authorization !== undefined) headers["Authorization"] = options.authorization;
    const response = await fetch(`http://127.0.0.1:${authServer.port}${path}`, {
      method,
      headers,
      body: method === "POST" ? payload : undefined,
    });
    return { status: response.status, body: await response.text() };
  }

  it("无 Authorization → 401（body 携带 -32001）", async () => {
    const { status, body } = await httpRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "discover", params: {} }),
    );
    expect(status).toBe(401);
    expect((JSON.parse(body) as JsonRpcMessage).error?.code).toBe(ERROR_CODES.AUTH_FAILED);
  });

  it("错 token → 401", async () => {
    const { status } = await httpRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "discover", params: {} }),
      { authorization: `Bearer ${"c".repeat(64)}` },
    );
    expect(status).toBe(401);
  });

  it("非 Bearer scheme → 401", async () => {
    const { status } = await httpRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "discover", params: {} }),
      { authorization: `Basic ${AUTH_TOKEN}` },
    );
    expect(status).toBe(401);
  });

  it("正确 Bearer → 200 + discover 结果（R4 契约在 HTTP 通道同样成立）", async () => {
    const { status, body } = await httpRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "discover", params: {} }),
      { authorization: `Bearer ${AUTH_TOKEN}` },
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as JsonRpcMessage;
    expect(parsed.id).toBe(2);
    expect((parsed.result as { capabilities: unknown[] }).capabilities).toHaveLength(1);
    expect(body).not.toContain("schema");
  });

  it("invoke(sync) 全链路经 HTTP 完成（TestProcess 应答）", async () => {
    const { status, body } = await httpRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "invoke",
        params: { capability_id: "file.write", input: { path: "http.txt" }, mode: "sync" },
      }),
      { authorization: `Bearer ${AUTH_TOKEN}` },
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as JsonRpcMessage;
    expect(parsed.error).toBeUndefined();
    expect((parsed.result as { status: string }).status).toBe("completed");
  });

  it("subscribe_event 经 HTTP → -32601（仅 WS 可用）", async () => {
    const { status, body } = await httpRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "subscribe_event", params: {} }),
      { authorization: `Bearer ${AUTH_TOKEN}` },
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as JsonRpcMessage;
    expect(parsed.error?.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
    expect(parsed.error?.message).toContain("仅 WS");
  });

  it("业务错误 → 200 + error body（40001 语义经 HTTP 通道透传）", async () => {
    const { status, body } = await httpRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "describe",
        params: { capability_id: "ghost.capability" },
      }),
      { authorization: `Bearer ${AUTH_TOKEN}` },
    );
    expect(status).toBe(200);
    expect((JSON.parse(body) as JsonRpcMessage).error?.code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
  });

  it("malformed body → 200 + -32600", async () => {
    const { status, body } = await httpRpc("not a json", {
      authorization: `Bearer ${AUTH_TOKEN}`,
    });
    expect(status).toBe(200);
    expect((JSON.parse(body) as JsonRpcMessage).error?.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });

  it("非 POST → 405；非 /rpc 路径 → 404", async () => {
    const get = await httpRpc("", { method: "GET" });
    expect(get.status).toBe(405);
    const notFound = await httpRpc("", { path: "/other" });
    expect(notFound.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// M2-03：异步执行与取消（5.3.3 async / 5.3.6 双路径 / 5.4 progress 推送）
// ---------------------------------------------------------------------------

/**
 * 轮询假进程 sent 增量直至新 invoke 命令出现（共享队列按基线区分；
 * ws I/O 异步送达，测试需确认命令到达后再手动 emit 驱动）。
 */
async function waitInvoke(
  proc: TestProcess,
  baseline: number,
  timeoutMs = 2_000,
): Promise<Extract<HostCommand, { type: "invoke" }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cmd = proc.sent.slice(baseline).find((c) => c.type === "invoke");
    if (cmd !== undefined) return cmd;
    if (Date.now() > deadline) throw new Error("等待 invoke 命令超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 长任务基座：预热进程（sync invoke 完成 = 进程就绪且复用）后切换挂起模式
 * （invokeReply 返回 null → 不自动应答），再发 async invoke——invoke 命令
 * 落入挂起进程，测试手动 emit progress / result / cancelled 驱动事件链。
 * 用例结束 finally 恢复默认应答，避免污染后续用例。
 */
async function startLongTask(): Promise<{ invocationId: string; proc: TestProcess }> {
  // 预热：默认应答模式下完成一次 sync invoke，确保插件进程已启动并复用
  await main.request("invoke", { capability_id: "file.write", input: { path: "warmup.txt" } });
  const proc = currentProc(procs);
  proc.invokeReply = () => null; // 挂起模式
  const res = await main.request("invoke", {
    capability_id: "file.write",
    input: { path: "longtask.txt" },
    mode: "async",
  });
  const { invocation_id: invocationId } = res.result as { invocation_id: string };
  return { invocationId, proc };
}

/** 等待订阅者收到指定事件名（跳过其他事件；超时防挂死） */
async function waitEvent(
  subscriber: TestClient,
  eventName: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`等待事件 ${eventName} 超时`);
    const notification = await Promise.race([
      subscriber.nextNotification(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`等待事件 ${eventName} 超时`)), remaining),
      ),
    ]);
    const params = notification.params as { event?: string } & Record<string, unknown>;
    if (params.event === eventName) return params;
  }
}

describe("异步执行与取消（M2-03，5.3.3 / 5.3.6 / 5.4）", () => {
  it("长任务 progress 序列推送：started → progress(percent 递增) → completed", async () => {
    const subscriber = new TestClient(`ws://127.0.0.1:${server.port}`);
    clients.push(subscriber);
    await subscriber.opened();
    await subscriber.request("subscribe_event", {});

    const { invocationId, proc } = await startLongTask();
    try {
      // 等执行启动（started 即 markRunning 完成，后续 progress 均属运行中）
      await waitEvent(subscriber, "execution.started");

      // 手动驱动两段进度 + 完成（模拟 dev.longtask 的 ctx.progress 检查点）
      proc.emit({ type: "progress", invocationId, percent: 25, message: "quadrant 1" });
      proc.emit({ type: "progress", invocationId, percent: 75 });
      proc.emit({ type: "result", invocationId, result: { slept_ms: 100 } });

      // 5.4 推送格式：method=event，params.data 携带 percent/message
      const progress25 = (await waitEvent(subscriber, "execution.progress")) as {
        invocation_id: string;
        data: { percent: number; message?: string };
      };
      expect(progress25.invocation_id).toBe(invocationId);
      expect(progress25.data.percent).toBe(25);
      expect(progress25.data.message).toBe("quadrant 1");
      const progress75 = (await waitEvent(subscriber, "execution.progress")) as {
        data: { percent: number; message?: string };
      };
      expect(progress75.data.percent).toBe(75);
      expect(progress75.data.message).toBeUndefined();

      const completed = await waitEvent(subscriber, "execution.completed");
      expect(completed.invocation_id).toBe(invocationId);
    } finally {
      // 恢复默认应答（挂起模式不得泄漏到后续用例的 warmup）
      proc.invokeReply = proc.defaultReply;
    }
  });

  it("running 态 cancel（协作路径）：cancelled 事件推送 + 进程存活未强杀", async () => {
    const subscriber = new TestClient(`ws://127.0.0.1:${server.port}`);
    clients.push(subscriber);
    await subscriber.opened();
    await subscriber.request("subscribe_event", {});

    const { invocationId, proc } = await startLongTask();
    try {
      await waitEvent(subscriber, "execution.started");

      // cancelBehavior 默认 cooperative：cancel 命令 → 检查点退出回 cancelled
      const res = await main.request("cancel", { invocation_id: invocationId });

      // 5.3.6：cancel 返回时已处终态 cancelled
      expect(res.result).toEqual({ invocation_id: invocationId, status: "cancelled" });
      // 订阅者收到 execution.cancelled 推送
      const cancelled = await waitEvent(subscriber, "execution.cancelled");
      expect(cancelled.invocation_id).toBe(invocationId);
      // 协作路径不触发强杀：进程存活
      expect(proc.exited).toBe(false);
    } finally {
      // 恢复默认应答（挂起模式不得泄漏到后续用例的 warmup）
      proc.invokeReply = proc.defaultReply;
    }
  });

  it("running 态 cancel（不协作强杀路径）：宽限耗尽 → kill 进程 + 终态 cancelled", async () => {
    // 独立 server：宽限缩至 150ms（真实默认 5s，单测不等长时限）
    const assembled = await setupServer({ port: 24785, cancelGraceMs: 150 });
    try {
      const client = new TestClient(`ws://127.0.0.1:${assembled.server.port}`);
      clients.push(client);
      await client.opened();
      const subscriber = new TestClient(`ws://127.0.0.1:${assembled.server.port}`);
      clients.push(subscriber);
      await subscriber.opened();
      await subscriber.request("subscribe_event", {});

      // 预热该 server 的进程后切挂起 + 不协作（不响应 cancel 命令）
      await client.request("invoke", {
        capability_id: "file.write",
        input: { path: "warmup.txt" },
      });
      const proc = currentProc(assembled.procs);
      proc.invokeReply = () => null;
      proc.cancelBehavior = "ignore";

      const res = await client.request("invoke", {
        capability_id: "file.write",
        input: { path: "stubborn.txt" },
        mode: "async",
      });
      const { invocation_id: invocationId } = res.result as { invocation_id: string };
      await waitEvent(subscriber, "execution.started");

      // cancel：宽限 150ms 内插件不响应 → 强杀 + cancelled 终态
      const cancelRes = await client.request("cancel", { invocation_id: invocationId });

      expect(cancelRes.result).toEqual({ invocation_id: invocationId, status: "cancelled" });
      // 5.3.6 强杀路径：进程被 kill（区别于协作路径的存活断言）
      expect(proc.exited).toBe(true);
      const cancelled = await waitEvent(subscriber, "execution.cancelled");
      expect(cancelled.invocation_id).toBe(invocationId);
    } finally {
      await assembled.server.stop();
    }
  });
});
