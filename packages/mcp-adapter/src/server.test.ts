/**
 * MCP Server 集成测试（M3-03；设计文档第 9 节 + 任务清单 M3 验收门）
 *
 * 测试形态：@modelcontextprotocol/sdk 的 Client + InMemoryTransport
 * 直连 createKikoMcpServer（后端注入 fake KikoRpcClient）——不经 WS /
 * stdio 传输层，聚焦映射表五行语义的端到端验证：
 *   门1 tools/list 可见能力全量 schema（input/output）
 *   门2 tools/call 成功执行并返回结构化结果
 *   门3 协议错误映射（40001 → McpError INVALID_PARAMS）
 *   门4 执行失败 → isError: true（非协议错误）
 *   门5 progress notification 转发（progressToken 路由 + invocation 精确匹配）
 *
 * 真实链路（headless Electron + stdio + 真插件执行）由
 * scripts/smoke-mcp.mjs 覆盖（对应任务清单 M3-03 冒烟收口）。
 */
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExecutionDetail } from "@kiko-workbench/protocol";
import { createKikoMcpServer } from "./server.js";
import type { KikoProgressEvent, KikoRpcClient, KikoRpcError } from "./kiko-rpc.js";

/** callTool 返回值收窄（SDK 返回类型带宽索引签名，content 推导为 unknown） */
function asToolResult(result: unknown): CallToolResult {
  return result as CallToolResult;
}

/** 取首块文本载荷（content 为联合类型，按 type 收窄到 text 块） */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  if (block !== undefined && "text" in block) return block.text;
  throw new Error("首内容块不是 text 块");
}

// ---------------------------------------------------------------------------
// Fake KikoRpcClient（可编程后端；与 WsKikoRpcClient 同构）
// ---------------------------------------------------------------------------

/** 构造带 code/data 的协议层错误（WsKikoRpcClient.rpcError 同形状） */
function kikoError(code: number, message: string, data?: unknown): KikoRpcError {
  const error = new Error(message) as KikoRpcError;
  error.code = code;
  error.data = data;
  return error;
}

/** fake 后端的可编程行为 */
interface FakeBehavior {
  /** invoke 失败时抛出的协议错误（优先于 detail） */
  invokeError?: KikoRpcError;
  /** invoke 返回的终态详情 */
  detail: ExecutionDetail;
  /** invoke 执行期间推送的 progress 序列（受理后按序异步发出） */
  progress?: Array<{ percent: number; message?: string }>;
  /** invoke 受理到终态的等待时长（缺省 20ms；并发隔离测试拉长以留出事件窗口） */
  invokeDelayMs?: number;
}

class FakeKikoRpcClient implements KikoRpcClient {
  readonly progressListeners = new Set<(event: KikoProgressEvent) => void>();
  private seq = 0;
  /** invoke 调用记录（capabilityId, input）——断言映射正确性 */
  readonly invokeCalls: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];

  constructor(private readonly behavior: FakeBehavior) {}

  async discover() {
    return [
      {
        id: "file.write",
        name: "写文件",
        description: "向工作空间写入文件",
        plugin: "file",
      },
      {
        id: "dev.longtask",
        name: "长任务",
        description: "模拟长任务",
        plugin: "dev",
      },
    ];
  }

  async describe(capabilityId: string) {
    if (capabilityId === "file.write") {
      return {
        id: "file.write",
        name: "写文件",
        description: "向工作空间写入文件",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
        output_schema: {
          type: "object",
          properties: { path: { type: "string" }, size: { type: "number" } },
        },
      };
    }
    return {
      id: "dev.longtask",
      name: "长任务",
      description: "模拟长任务",
      input_schema: {
        type: "object",
        properties: { duration_ms: { type: "number" } },
        required: ["duration_ms"],
      },
      output_schema: { type: "object", properties: { slept_ms: { type: "number" } } },
    };
  }

  async invoke(
    capabilityId: string,
    input: Record<string, unknown>,
    onAccepted?: (invocationId: string) => void,
  ): Promise<ExecutionDetail> {
    this.invokeCalls.push({ capabilityId, input });
    if (this.behavior.invokeError !== undefined) throw this.behavior.invokeError;
    const invocationId = `inv_${++this.seq}`;
    // 受理回调（progress 路由键生效时点）
    onAccepted?.(invocationId);
    // 执行期间推送 progress（受理后异步发出，模拟真实事件流）
    for (const step of this.behavior.progress ?? []) {
      setTimeout(() => this.emitProgress({ invocationId, ...step }), 10);
    }
    // 简单终态等待：progress 发完即终态（时序上晚于 progress）
    const waitMs = this.behavior.invokeDelayMs ?? 10 * (this.behavior.progress?.length ?? 0) + 20;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return { ...this.behavior.detail, invocation_id: invocationId };
  }

  subscribeProgress(listener: (event: KikoProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  /** fake 侧直接发出 progress 事件（测试并发隔离时也用它） */
  emitProgress(event: KikoProgressEvent): void {
    for (const listener of this.progressListeners) listener(event);
  }

  close(): void {
    // fake 无资源（接口完整性保留）
  }
}

// ---------------------------------------------------------------------------
// 测试装配：MCP Client ⇄ InMemoryTransport ⇄ Kiko MCP Server ⇄ fake 后端
// ---------------------------------------------------------------------------

async function setup(behavior: FakeBehavior) {
  const rpc = new FakeKikoRpcClient(behavior);
  const server = createKikoMcpServer(rpc);
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { rpc, server, client };
}

/** 组装 fake 终态详情（completed 路径） */
function completedDetail(result: unknown): ExecutionDetail {
  return {
    invocation_id: "inv_x",
    capability_id: "file.write",
    status: "completed",
    mode: "async",
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    result,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 门1：tools/list（映射表第 1 行）
// ---------------------------------------------------------------------------

describe("MCP Server: tools/list", () => {
  it("discover + describe 合并出全量 schema（input/output 均在）", async () => {
    const { client } = await setup({ detail: completedDetail({}) });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const write = result.tools.find((t) => t.name === "file.write");
    expect(write).toBeDefined();
    // input_schema 原样透传（required 含 path/content）
    expect(write?.inputSchema).toMatchObject({
      type: "object",
      required: ["path", "content"],
    });
    // output_schema 原样透传
    expect(write?.outputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" }, size: { type: "number" } },
    });
    // description 携带插件来源（能力归属可见）
    expect(write?.description).toContain("插件：file");
  });
});

// ---------------------------------------------------------------------------
// 门2：tools/call 成功路径（映射表第 2 行）
// ---------------------------------------------------------------------------

describe("MCP Server: tools/call", () => {
  it("成功：content 携带完整载荷 + structuredContent 对齐 output_schema", async () => {
    const { rpc, client } = await setup({
      detail: completedDetail({ path: "a.txt", size: 12 }),
    });
    const result = asToolResult(
      await client.callTool({
        name: "file.write",
        arguments: { path: "a.txt", content: "hello" },
      }),
    );
    // 映射键正确：name → capability_id，arguments → input
    expect(rpc.invokeCalls).toEqual([
      { capabilityId: "file.write", input: { path: "a.txt", content: "hello" } },
    ]);
    expect(result.isError).not.toBe(true);
    // 文本载荷含 invocation_id（Agent 可溯源）
    const payload = JSON.parse(firstText(result));
    expect(payload.invocation_id).toMatch(/^inv_/);
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({ path: "a.txt", size: 12 });
    // result 为对象 → structuredContent 直接对齐（output_schema 形状）
    expect(result.structuredContent).toEqual({ path: "a.txt", size: 12 });
  });

  it("执行失败：isError true + error 载荷（非协议错误）", async () => {
    const { client } = await setup({
      detail: {
        ...completedDetail(undefined),
        status: "failed",
        error: { code: 50001, message: "路径越界" },
      },
    });
    const result = asToolResult(await client.callTool({ name: "file.write", arguments: {} }));
    expect(result.isError).toBe(true);
    const payload = JSON.parse(firstText(result));
    expect(payload.status).toBe("failed");
    expect(payload.error).toEqual({ code: 50001, message: "路径越界" });
  });

  it("协议错误 40001：映射为 McpError INVALID_PARAMS", async () => {
    const { client } = await setup({
      detail: completedDetail({}),
      invokeError: kikoError(40001, "能力不存在：nope"),
    });
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("协议错误 40002：McpError INVALID_PARAMS 携带 ajv 明细", async () => {
    const { client } = await setup({
      detail: completedDetail({}),
      invokeError: kikoError(40002, "输入校验失败", { errors: [{ keyword: "required" }] }),
    });
    await expect(
      client.callTool({ name: "file.write", arguments: { path: "x" } }),
    ).rejects.toMatchObject({ code: -32602, data: { errors: [{ keyword: "required" }] } });
  });

  it("协议错误 40005：映射为 INTERNAL_ERROR 且保留原始码", async () => {
    const { client } = await setup({
      detail: completedDetail({}),
      invokeError: kikoError(40005, "插件不可用"),
    });
    await expect(client.callTool({ name: "file.write", arguments: {} })).rejects.toMatchObject({
      code: -32603,
      data: { kikoErrorCode: 40005 },
    });
  });
});

// ---------------------------------------------------------------------------
// 门5：progress notification 转发（映射表第 3 行，M3-02）
// ---------------------------------------------------------------------------

describe("MCP Server: progress 转发", () => {
  it("progressToken 请求收到 notifications/progress（percent/message/total）", async () => {
    const { client } = await setup({
      detail: completedDetail({ slept_ms: 100 }),
      progress: [{ percent: 50, message: "halfway" }, { percent: 100 }],
    });
    const received: Array<{ progress: number; total?: number; message?: string }> = [];
    const result = asToolResult(
      await client.callTool(
        {
          name: "dev.longtask",
          arguments: { duration_ms: 100 },
          _meta: { progressToken: "token-1" },
        },
        undefined,
        {
          // onprogress 回调参数即 ProgressNotification.params
          onprogress: (progress) => {
            received.push({
              progress: progress.progress,
              total: progress.total,
              message: progress.message,
            });
          },
        },
      ),
    );
    expect(result.isError).not.toBe(true);
    expect(received).toEqual([
      { progress: 50, total: 100, message: "halfway" },
      { progress: 100, total: 100, message: undefined },
    ]);
  });

  it("无 progressToken 的调用不产生通知（转发按需）", async () => {
    const { client } = await setup({
      detail: completedDetail({ slept_ms: 1 }),
      progress: [{ percent: 30 }],
    });
    // 不传 onprogress：MCP SDK 仅在客户端声明进度消费（onprogress）时
    // 才会注入 progressToken——未声明即"不请求进度"，服务端不转发
    const result = asToolResult(
      await client.callTool({ name: "dev.longtask", arguments: { duration_ms: 1 } }),
    );
    expect(result.isError).not.toBe(true);
  });

  it("并发调用互不串扰（invocation 精确匹配）", async () => {
    const { rpc, client } = await setup({
      detail: completedDetail({ slept_ms: 1 }),
      // 拉长执行时长：waitFor 轮询（50ms 间隔）期间 invocation 必须仍在
      // 运行（listener 尚未退订），定向推送的 progress 才处于活跃路由
      invokeDelayMs: 300,
    });
    const receivedA: number[] = [];
    const receivedB: number[] = [];

    // 两个并发调用：A 带 token 收 10%，B 带 token 收 90%（fake 侧
    // 手工 emit，控制事件归属与到达次序）
    const invokeA = client
      .callTool(
        { name: "dev.longtask", arguments: {}, _meta: { progressToken: "tok-a" } },
        undefined,
        { onprogress: (progress) => receivedA.push(progress.progress) },
      )
      .then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const invokeB = client
      .callTool(
        { name: "dev.longtask", arguments: {}, _meta: { progressToken: "tok-b" } },
        undefined,
        { onprogress: (progress) => receivedB.push(progress.progress) },
      )
      .then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

    // 等两个调用都已受理（invocation 已建立），再定向推送 progress
    await vi.waitFor(() => expect(rpc.invokeCalls).toHaveLength(2));
    rpc.emitProgress({ invocationId: "inv_1", percent: 10 });
    rpc.emitProgress({ invocationId: "inv_2", percent: 90 });
    await Promise.all([invokeA, invokeB]);

    // 各 token 只收到自己 invocation 的进度
    expect(receivedA).toEqual([10]);
    expect(receivedB).toEqual([90]);
  });
});
