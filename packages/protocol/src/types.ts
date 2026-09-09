/**
 * 核心对象类型定义（设计文档 7.1）
 *
 * 本文件是协议层类型权威来源：
 *   - CapabilityDefinition 能力定义（注册与 describe 的数据结构）
 *   - InvocationStatus    对外统一状态（PRD 第 8 节）
 *   - ArtifactInfo        执行产物（见设计文档 7.4）
 *   - InvocationResult    执行结果（PRD 第 9 节）
 *   - ExecutionEvent      标准事件（PRD 第 10 节 / 设计文档 5.4）
 *   - ExecutionLog        执行日志条目（get_execution include_logs 返回）
 */

/** JSON Schema 对象（draft-07）。协议层不约束其内部结构，ajv 校验由 core 侧执行 */
export type JsonSchema = object;

/** 能力定义：注册与 describe 的数据结构（设计文档 7.1 / 8.3） */
export interface CapabilityDefinition {
  /** 如 "document.create"，全局唯一 */
  id: string;
  name: string;
  description: string;
  /** 输入 JSON Schema（draft-07），invoke 时由 ajv 校验 */
  input_schema: JsonSchema;
  /** 输出 JSON Schema（draft-07） */
  output_schema: JsonSchema;
  /** 调用示例（describe 返回，供 Agent 理解用法） */
  examples?: Array<{ input: unknown; output: unknown }>;
  /** 执行超时毫秒数，缺省由 core 兜底（默认 30000） */
  timeout_ms?: number;
}

/** 对外统一状态（PRD 第 8 节：内部状态可更丰富，对外表现为五种） */
export type InvocationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** 执行产物（设计文档 7.4 工作空间与产物管理） */
export interface ArtifactInfo {
  /** 绝对路径 */
  file: string;
  /** 工作空间相对路径 */
  relative_path: string;
  /** 最终落盘文件名（同名冲突时含序号） */
  filename: string;
  mime_type: string;
  /** 字节数 */
  size: number;
}

/** 结构化错误信息（InvocationResult.error / get_execution.error / invoke 响应 error） */
export interface ResultError {
  code: number;
  message: string;
  /** 校验失败时携带 ajv 明细（40002，设计文档 5.5） */
  errors?: unknown[];
}

/** 执行结果（PRD 第 9 节：结构化，区分 data / artifacts / metadata / error） */
export interface InvocationResult {
  status: InvocationStatus;
  /** 业务数据（output_schema 描述的形状，面向 Agent 消费） */
  data?: unknown;
  /** 产物登记信息（面向管理/审计/UI），与 data 中路径字段职责不同 */
  artifacts?: ArtifactInfo[];
  metadata?: Record<string, unknown>;
  error?: ResultError;
}

/** 标准事件类型（设计文档 5.4：六种；扩展事件允许自定义字符串） */
export const EVENT_TYPES = {
  INVOCATION_CREATED: "invocation.created",
  EXECUTION_STARTED: "execution.started",
  EXECUTION_PROGRESS: "execution.progress",
  EXECUTION_COMPLETED: "execution.completed",
  EXECUTION_FAILED: "execution.failed",
  EXECUTION_CANCELLED: "execution.cancelled",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** 标准事件（设计文档 5.4）：事件推送 notification 的 params 即本类型 */
export interface ExecutionEvent {
  /** 标准事件类型之一（EVENT_TYPES），扩展事件允许自定义字符串 */
  event: EventType | (string & {});
  invocation_id: string;
  /** ISO 8601 UTC */
  timestamp: string;
  data: Record<string, unknown>;
}

/** 执行日志条目（get_execution include_logs 返回；对应设计文档 8.5 host 的 log 消息） */
export interface ExecutionLog {
  /** ISO 8601 UTC */
  timestamp: string;
  message: string;
}
