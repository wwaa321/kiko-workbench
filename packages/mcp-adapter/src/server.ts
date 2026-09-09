/**
 * Kiko MCP Server（设计文档第 9 节映射表的实现）
 *
 * | MCP 侧               | Kiko 侧                          | 本文件落点 |
 * |-----------------------|----------------------------------|-----------|
 * | tools/list            | discover() + 逐能力 describe()    | listTools |
 * | tools/call            | invoke（async 受理 + 等终态，对外同步语义）| callTool |
 * | progress notification | execution.progress 事件转发      | callTool 内 progressToken 路由 |
 * | —                     | subscribe_event / get_execution  | 不可表达，丢弃（本表即文档化说明）|
 *
 * 细节决策：
 *   - 低层 Server API（而非高层 McpServer.registerTool）：映射表本身
 *     就是"手工协议翻译"，低层 handler 一对一贴齐映射行，无额外抽象
 *   - Tool.description 附带插件来源（plugin 字段）与示例摘要，其余字段
 *     原样透传（R4 的防 Context 膨胀仅约束 discover；MCP tools/list
 *     语义要求一次性给全 schema——映射表第 1 行已声明该妥协）
 *   - invoke 失败分层：协议层错误（40001/40002/…）抛 McpError（调用
 *     方未获得执行）；执行层失败（status=failed/cancelled）返回
 *     isError=true 的 CallToolResult（MCP 约定：工具失败≠协议错误）
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type ProgressNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { ExecutionDetail } from "@kiko-workbench/protocol";
import type { KikoRpcClient, KikoRpcError } from "./kiko-rpc.js";

/** MCP Server 对外身份（initialize 响应的 serverInfo） */
const SERVER_INFO = { name: "kiko-workbench", version: "0.1.0" } as const;

/** progress 通知的 total 固定 100（percent 语义为 0-100） */
const PROGRESS_TOTAL = 100;

/**
 * 创建 Kiko MCP Server。
 *
 * @param rpc Kiko 协议后端（生产 WsKikoRpcClient / 测试 fake）
 * @returns 已注册 tools/list 与 tools/call handler 的 Server（未连接，
 *   由调用方接 StdioServerTransport 或 InMemoryTransport）
 */
export function createKikoMcpServer(rpc: KikoRpcClient): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "Kiko Workbench 能力执行平台。每个工具对应一个 Kiko 能力（capability），" +
      "输入输出结构由各自 schema 定义；长任务执行期间会推送进度通知。",
  });

  // ---- 映射表第 1 行：tools/list ← discover + 逐能力 describe ----
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const summaries = await rpc.discover();
    const tools = await Promise.all(
      summaries.map(async (summary) => {
        const definition = await rpc.describe(summary.id);
        return {
          name: definition.id,
          description: [
            `${definition.name} —— ${definition.description}`,
            `插件：${summary.plugin}`,
          ].join("\n"),
          // MCP inputSchema/outputSchema 均为 JSON Schema 对象（与
          // capabilities.json 的 draft-07 定义同构，原样透传）
          inputSchema: definition.input_schema,
          outputSchema: definition.output_schema,
        };
      }),
    );
    return { tools };
  });

  // ---- 映射第 2/3 行：tools/call + progress 转发 ----
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest, extra) => {
    const toolName = request.params.name;
    // MCP 入参（缺省空对象：无必填参数的能力合法）
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    // 客户端请求带 progressToken 时转发长任务进度（M3-02）
    const progressToken = request.params._meta?.progressToken;

    // 受理后 invocation_id 落点（progress 路由的匹配键）
    let invocationId = "";
    // 活跃 invocation 的 progress 路由（invoke 响应前到达的极早期
    // progress 会丢失——窗口为本机 WS 往返毫秒级，插件尚在懒启动，
    // 实际不产生事件；此妥协由 async 受理换精确匹配，偏差表登记）
    const unsubscribe = rpc.subscribeProgress((event) => {
      if (event.invocationId !== invocationId) return;
      if (progressToken === undefined) return;
      // 经请求上下文回发通知（仅 handler 存续期内有效；终态即移除路由）
      void extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: event.percent,
          total: PROGRESS_TOTAL,
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
      } satisfies ProgressNotification);
    });
    try {
      // 后端 async 受理 + 等终态（对外同步语义：终态才返回）；
      // onAccepted 触发时 progress 路由的匹配键生效
      const detail = await rpc.invoke(toolName, input, (id) => {
        invocationId = id;
      });
      return toCallToolResult(detail);
    } catch (error) {
      // 协议层错误 → McpError（工具未执行：能力不存在 / 入参不合法 / 插件不可用）
      throw toMcpError(error);
    } finally {
      unsubscribe();
    }
  });

  return server;
}

/** 协议层错误映射：自定义协议错误码 → MCP 错误码（附原始明细） */
function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const kikoError = error as Partial<KikoRpcError>;
  if (typeof kikoError?.code === "number") {
    // 40001 能力不存在 / 40002 入参校验失败 → 调用方问题（INVALID_PARAMS）
    if (kikoError.code === 40001 || kikoError.code === 40002) {
      return new McpError(
        ErrorCode.InvalidParams,
        `${String(kikoError.message)}（Kiko 错误码 ${kikoError.code}）`,
        kikoError.data,
      );
    }
    // 40003/40004/40005/… → 服务端问题（INTERNAL_ERROR + 原 code 供诊断）
    return new McpError(
      ErrorCode.InternalError,
      `${String(kikoError.message)}（Kiko 错误码 ${kikoError.code}）`,
      { kikoErrorCode: kikoError.code, detail: kikoError.data },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(ErrorCode.InternalError, message);
}

/** 执行结果映射：ExecutionDetail → CallToolResult（成功 / 失败双路径） */
function toCallToolResult(detail: ExecutionDetail): CallToolResult {
  const completed = detail.status === "completed";
  // 载荷：完整保留 invocation_id / status / result / artifacts / error
  // （Agent 可凭 invocation_id 走 Kiko 原生通道 get_execution 溯源）
  const payload: Record<string, unknown> = {
    invocation_id: detail.invocation_id,
    status: detail.status,
  };
  if (detail.result !== undefined) payload["result"] = detail.result;
  if (detail.artifacts !== undefined && detail.artifacts.length > 0) {
    payload["artifacts"] = detail.artifacts;
  }
  if (detail.error != null) payload["error"] = detail.error;

  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: completed ? undefined : true,
  };
  // 结构化输出（structuredContent 必须为对象）：仅 result 为对象时提供，
  // 与 output_schema 对齐（标量结果仅文本载荷，不强包一层）
  if (completed && typeof detail.result === "object" && detail.result !== null) {
    result.structuredContent = detail.result as Record<string, unknown>;
  }
  return result;
}
