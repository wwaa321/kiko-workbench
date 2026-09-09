/**
 * 错误码表（设计文档 5.5）+ RpcError 异常类型
 *
 * 约定：
 *   - 传输层错误沿用 JSON-RPC 保留段（-32xxx）
 *   - 业务错误自定义段（40001~40007 / 50001）
 *   - 所有错误经 json-rpc.ts 的 encodeError 包装为 JSON-RPC error 响应
 */

/** 错误码常量（与设计文档 5.5 错误码表一一对应，勿改动数值） */
export const ERROR_CODES = {
  /** 鉴权失败：token 错误 / 未鉴权 */
  AUTH_FAILED: -32001,
  /** 无效请求：JSON-RPC 格式错误 */
  INVALID_REQUEST: -32600,
  /** 方法不存在 */
  METHOD_NOT_FOUND: -32601,
  /** 参数无效：缺少必填字段等（非 schema 校验） */
  INVALID_PARAMS: -32602,
  /** 内部错误 */
  INTERNAL_ERROR: -32603,
  /** 能力不存在：capability_id 未注册或插件已禁用 */
  CAPABILITY_NOT_FOUND: 40001,
  /** 输入校验失败：ajv 校验不通过，data.errors 携带 ajv 明细 */
  INPUT_VALIDATION_FAILED: 40002,
  /** Invocation 不存在 */
  INVOCATION_NOT_FOUND: 40003,
  /** 非法状态操作：对终态 invocation cancel 等 */
  ILLEGAL_STATE_OPERATION: 40004,
  /** 插件不可用：崩溃 / 加载失败 / 处于 error 状态 */
  PLUGIN_UNAVAILABLE: 40005,
  /** 执行超时：超过 capability 的 timeout_ms */
  EXECUTION_TIMEOUT: 40006,
  /** 执行被取消 */
  EXECUTION_CANCELLED: 40007,
  /** 插件 ID 冲突：导入的插件与已注册插件（内置 / 第三方）id 重复 */
  PLUGIN_ID_CONFLICT: 40008,
  /** 内置插件受保护：禁止删除 / 导出覆盖等破坏性操作 */
  BUILTIN_PLUGIN_PROTECTED: 40009,
  /** 插件界面未打开：ctx.ui.send 投递时表面不存在（P-003 v1，草案附录 C） */
  PLUGIN_UI_NOT_OPEN: 40010,
  /** 插件执行错误：插件抛出异常 */
  PLUGIN_EXECUTION_ERROR: 50001,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 默认错误消息（与设计文档 5.5 "含义"列一致） */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ERROR_CODES.AUTH_FAILED]: "鉴权失败",
  [ERROR_CODES.INVALID_REQUEST]: "无效请求",
  [ERROR_CODES.METHOD_NOT_FOUND]: "方法不存在",
  [ERROR_CODES.INVALID_PARAMS]: "参数无效",
  [ERROR_CODES.INTERNAL_ERROR]: "内部错误",
  [ERROR_CODES.CAPABILITY_NOT_FOUND]: "能力不存在",
  [ERROR_CODES.INPUT_VALIDATION_FAILED]: "输入校验失败",
  [ERROR_CODES.INVOCATION_NOT_FOUND]: "Invocation 不存在",
  [ERROR_CODES.ILLEGAL_STATE_OPERATION]: "非法状态操作",
  [ERROR_CODES.PLUGIN_UNAVAILABLE]: "插件不可用",
  [ERROR_CODES.EXECUTION_TIMEOUT]: "执行超时",
  [ERROR_CODES.EXECUTION_CANCELLED]: "执行被取消",
  [ERROR_CODES.PLUGIN_ID_CONFLICT]: "插件 ID 冲突",
  [ERROR_CODES.BUILTIN_PLUGIN_PROTECTED]: "内置插件受保护",
  [ERROR_CODES.PLUGIN_UI_NOT_OPEN]: "插件界面未打开",
  [ERROR_CODES.PLUGIN_EXECUTION_ERROR]: "插件执行错误",
};

/**
 * 协议统一错误类型：core / 传输层抛出，由服务端统一捕获并编码为
 * JSON-RPC error 响应（encodeError）。
 */
export class RpcError extends Error {
  readonly code: ErrorCode;
  /** 附加数据：如 40002 时携带 ajv 明细 */
  readonly data?: unknown;

  constructor(code: ErrorCode, message?: string, data?: unknown) {
    // message 缺省取错误码默认消息（Record 完整性由类型保证）
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
