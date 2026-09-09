/**
 * 协议方法类型定义（设计文档 5.3）
 *
 * 六方法的 params / result 类型 + 方法名常量。
 * 传输层（WS / HTTP）统一使用 JSON-RPC 2.0 编解码（json-rpc.ts），
 * 本文件只定义业务语义形状。
 */
import type {
  ArtifactInfo,
  CapabilityDefinition,
  ExecutionEvent,
  ExecutionLog,
  InvocationStatus,
  ResultError,
} from "./types.js";

/** 协议方法名常量（唯一权威来源，防止字符串拼拼错） */
export const RPC_METHODS = {
  /** WS 连接鉴权（M2-02，5.1：连接后首条消息；仅 WS 通道存在） */
  AUTH: "auth",
  DISCOVER: "discover",
  DESCRIBE: "describe",
  INVOKE: "invoke",
  GET_EXECUTION: "get_execution",
  SUBSCRIBE_EVENT: "subscribe_event",
  CANCEL: "cancel",
  /**
   * 第三方插件目录重扫（S11，零 Shell 自举方案 3.3）：
   * 部署后无需重启即可发现新插件。方法集扩展（5.3 六方法之外）
   * ——偏差表 2026-09-01 登记。
   */
  PLUGINS_RESCAN: "plugins.rescan",
} as const;

export type RpcMethodName = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** 事件推送 notification 的 method 名（设计文档 5.4） */
export const EVENT_NOTIFICATION_METHOD = "event";

// ---------- 5.1 auth（WS 连接鉴权，M2-02） ----------

/**
 * auth 请求参数（5.1："WS 连接后首条消息必须为 auth"）。
 * 消息形状为文档空白处的实现期补全（见偏差表 2026-08-20）。
 */
export interface AuthParams {
  /** 首次启动生成并持久化在 settings.json 的 access_token */
  token: string;
}

/** auth 成功响应 */
export interface AuthResult {
  authenticated: true;
}

// ---------- 5.3.1 discover ----------

/** discover 请求参数：query 省略时返回全部能力摘要 */
export interface DiscoverParams {
  query?: string;
}

/** 能力摘要（discover 响应条目）：契约锁定不含任何 schema 字段（防 Context 膨胀，设计文档 R4） */
export interface CapabilitySummary {
  id: string;
  name: string;
  description: string;
  /** 所属插件 id（如 "document"） */
  plugin: string;
}

export interface DiscoverResult {
  capabilities: CapabilitySummary[];
}

// ---------- 5.3.2 describe ----------

export interface DescribeParams {
  capability_id: string;
}

/** describe 响应：完整能力定义（含 input/output schema 与 examples） */
export type DescribeResult = CapabilityDefinition;

// ---------- 5.3.3 invoke ----------

export type InvokeMode = "sync" | "async";

export interface InvokeParams {
  capability_id: string;
  /** 能力输入，形状由 capability 的 input_schema 约束 */
  input: Record<string, unknown>;
  /** 缺省 sync */
  mode?: InvokeMode;
}

/** sync 模式响应：阻塞至执行完成；成功带 result（业务数据），失败带 error */
export interface InvokeSyncResult {
  invocation_id: string;
  status: InvocationStatus;
  /** 业务数据（output_schema 形状，同 get_execution.result） */
  result?: unknown;
  /**
   * 产物登记信息（PRD 第 9 节 Result 五分结构；M2-04）。
   * 非空才输出——无产物的调用不产生响应噪音。与 result 中路径字段
   * 职责不同（data 面向 Agent 消费，artifacts 面向管理/审计/UI）。
   */
  artifacts?: ArtifactInfo[];
  error?: ResultError;
}

/** async 模式响应：立即返回，后续状态经事件推送 / get_execution 查询 */
export interface InvokeAsyncResult {
  invocation_id: string;
  status: "running";
}

export type InvokeResult = InvokeSyncResult | InvokeAsyncResult;

// ---------- 5.3.4 get_execution ----------

export interface GetExecutionParams {
  invocation_id: string;
  /** 缺省 false（轮询场景防响应膨胀） */
  include_events?: boolean;
  /** 缺省 false */
  include_logs?: boolean;
}

/** invocation 执行详情（get_execution 响应） */
export interface ExecutionDetail {
  invocation_id: string;
  capability_id: string;
  status: InvocationStatus;
  mode: InvokeMode;
  /** ISO 8601 UTC */
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  /** 业务数据（output_schema 形状）；未完成或失败时缺省 */
  result?: unknown;
  /**
   * 产物登记信息（PRD 第 9 节 Result 五分结构；M2-04）。
   * 非空才输出（与 InvokeSyncResult.artifacts 同语义）。
   */
  artifacts?: ArtifactInfo[];
  error?: ResultError | null;
  /** 仅 include_events=true 时返回 */
  events?: ExecutionEvent[];
  /** 仅 include_logs=true 时返回 */
  logs?: ExecutionLog[];
}

// ---------- 5.3.5 subscribe_event（仅 WS） ----------

/** 事件订阅参数：filter 省略 = 订阅全量 */
export interface SubscribeEventParams {
  filter?: {
    invocation_id?: string;
  };
}

/** 订阅确认响应（设计文档未定义形状，本协议取 { subscribed: true }，见偏差表） */
export interface SubscribeEventResult {
  subscribed: true;
}

// ---------- 5.3.6 cancel ----------

export interface CancelParams {
  invocation_id: string;
}

/** cancel 响应：先协作后强杀，返回时已处于 cancelled 终态 */
export interface CancelResult {
  invocation_id: string;
  status: "cancelled";
}

// ---------- plugins.rescan（S11，零 Shell 自举方案 3.3） ----------

/** rescan 响应：第三方插件根重扫的增量结果 */
export interface RescanResult {
  /** 本轮新注册的插件 id（discover 立即可见；error 态插件也在此列，原因可查插件列表） */
  added: string[];
  /** 磁盘上已消失、本轮卸载的第三方插件 id（运行中进程被终止） */
  removed: string[];
  /** 扫描到但未生效的目录明细（已注册的文件变更需重启；id 冲突内置优先） */
  skipped: Array<{
    id: string;
    reason: string;
  }>;
}
