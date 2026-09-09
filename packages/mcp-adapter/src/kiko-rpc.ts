/**
 * Kiko RPC 后端抽象（设计文档第 9 节 MCP 适配器的"自定义协议侧"）
 *
 * 职责：定义 MCP Server 与 Kiko 自定义 JSON-RPC 协议之间的边界接口。
 * 生产实现为 WsKikoRpcClient（WS 连接运行中的 Kiko 实例——headless /
 * desktop 主进程），集成测试注入 fake（MCP SDK Client + InMemoryTransport
 * 直连 server，不经传输层）。
 *
 * 接口形状刻意贴齐自定义协议六方法中的四个（discover / describe /
 * invoke / get_execution）——第 9 节映射表右侧的能力；subscribe_event /
 * get_execution 的"推送"语义折叠为 subscribeProgress / waitForTerminal
 * 两个更贴合 MCP 消费方式的派生形式（MCP 侧不可表达原始事件流，见
 * 映射表第 4 行的文档化丢弃说明）。
 */
import type {
  CapabilityDefinition,
  CapabilitySummary,
  ExecutionDetail,
} from "@kiko-workbench/protocol";

/** execution.progress 事件的适配形状（data.percent / data.message 转译） */
export interface KikoProgressEvent {
  invocationId: string;
  /** 0-100（插件经 InvocationContext.progress 上报） */
  percent: number;
  message?: string;
}

/** invocation 终态类型（等待完成的语义锚点） */
export type KikoTerminalStatus = "completed" | "failed" | "cancelled";

/** MCP Server 对 Kiko 协议后端的全部要求（依赖注入，便于测试） */
export interface KikoRpcClient {
  /** discover：enabled 插件的能力摘要（含 id/name/description/plugin） */
  discover(): Promise<CapabilitySummary[]>;

  /** describe：完整能力定义（input_schema / output_schema / examples） */
  describe(capabilityId: string): Promise<CapabilityDefinition>;

  /**
   * 发起调用（invoke mode:"async" 受理 + 等终态）并返回执行详情。
   *
   * 用 async 而非 sync 模式的原因（实现期决策，登记偏差表）：
   * async 响应立即携带 invocation_id，进度事件与终态事件才能按
   * invocation 精确匹配——sync 模式下 invocation_id 要阻塞到终态才
   * 可见，progress 转发（M3-02）无从建立映射。对外仍表现为同步
   * 阻塞语义（MCP tools/call 等待终态才返回），与映射表第 2 行一致。
   *
   * @param onAccepted 受理回调（async 响应到达即触发，早于返回值
   *   resolve）——progress 路由在此建立 invocation_id 匹配
   */
  invoke(
    capabilityId: string,
    input: Record<string, unknown>,
    onAccepted?: (invocationId: string) => void,
  ): Promise<ExecutionDetail>;

  /**
   * 订阅 progress 事件（转发给 MCP notifications/progress 的数据源）。
   * 返回退订函数。
   */
  subscribeProgress(listener: (event: KikoProgressEvent) => void): () => void;

  /** 关闭后端连接 / 释放资源（幂等） */
  close(): void;
}

/** JSON-RPC error 形状（后端透传的协议层错误：40001/40002/40005 等） */
export interface KikoRpcError extends Error {
  /** 自定义协议错误码（protocol/src/errors.ts） */
  code: number;
  /** 错误附带数据（如 40002 的 ajv 明细） */
  data?: unknown;
}
