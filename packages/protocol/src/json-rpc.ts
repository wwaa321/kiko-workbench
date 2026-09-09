/**
 * JSON-RPC 2.0 编解码（设计文档 5.2 / 5.4）
 *
 * 本协议对 JSON-RPC 2.0 做如下子集约定：
 *   - params 仅接受对象（命名参数），数组（位置参数）与本协议六方法不兼容 → -32600
 *   - 不支持 batch（数组消息）→ -32600
 *   - id 仅接受 number / string（null 为规范保留值，本协议不使用）→ -32600
 *   - 无 id 的消息视为 notification（事件推送，见 5.4）
 *   - JSON 文本解析失败不使用 -32700，统一归入 -32600（设计文档 5.5 未定义 parse error）
 */
import { ERROR_CODES, RpcError } from "./errors.js";

/** JSON-RPC 消息 id：number 或 string */
export type RpcId = number | string;

/** 入站请求 / notification（无 id 即 notification，如 5.4 事件推送） */
export interface RpcRequest {
  jsonrpc: "2.0";
  /** 缺省 = notification（服务端不回响应） */
  id?: RpcId;
  method: string;
  /** 命名参数（本协议不使用位置参数） */
  params?: Record<string, unknown>;
}

/** 成功响应 */
export interface RpcSuccessResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result: unknown;
}

/** 失败响应（id 为 null：无法确定请求 id 时，如 malformed 消息） */
export interface RpcErrorResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

/**
 * 解析已 JSON.parse 的入站消息。
 * 任何结构违规（非对象 / jsonrpc 非 "2.0" / method 缺失或非 string /
 * params 非对象 / id 类型非法）抛 RpcError(-32600)。
 */
export function decodeRpcMessage(payload: unknown): RpcRequest {
  // 顶层必须是普通对象（数组 = batch 不支持；null / 原始值 = 非法）
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new RpcError(
      ERROR_CODES.INVALID_REQUEST,
      "消息必须是 JSON-RPC 2.0 单对象（不支持 batch）",
    );
  }
  const obj = payload as Record<string, unknown>;

  // jsonrpc 字段：必须精确等于 "2.0"
  if (obj["jsonrpc"] !== "2.0") {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, 'jsonrpc 字段必须为 "2.0"');
  }

  // method 字段：非空 string
  if (typeof obj["method"] !== "string" || obj["method"].length === 0) {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, "method 字段必须为非空字符串");
  }

  // id 字段：可缺省（notification）；存在则必须为 number / string
  const id = obj["id"];
  if (id !== undefined && typeof id !== "number" && typeof id !== "string") {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, "id 字段必须为 number 或 string");
  }

  // params 字段：可缺省；存在则必须为对象（本协议仅使用命名参数）
  const params = obj["params"];
  if (
    params !== undefined &&
    (typeof params !== "object" || params === null || Array.isArray(params))
  ) {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, "params 必须为对象（本协议仅使用命名参数）");
  }

  // 组装规范化消息（仅保留已校验字段，不透传多余字段）
  const message: RpcRequest = { jsonrpc: "2.0", method: obj["method"] };
  if (id !== undefined) message.id = id;
  if (params !== undefined) message.params = params as Record<string, unknown>;
  return message;
}

/** 解析 JSON 文本（WS message / HTTP body）；解析失败统一 -32600（见文件头约定） */
export function decodeRpcMessageText(raw: string): RpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, "消息不是合法 JSON");
  }
  return decodeRpcMessage(parsed);
}

/** 是否为 notification（无 id；服务端不回响应，见 5.4 事件推送） */
export function isNotification(message: RpcRequest): boolean {
  return message.id === undefined;
}

/** 编码成功响应 */
export function encodeSuccess(id: RpcId, result: unknown): RpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

/** 编码失败响应；id 传 null 用于无法确定请求 id 的场景（如 malformed 消息） */
export function encodeError(id: RpcId | null, error: RpcError): RpcErrorResponse {
  const err: RpcErrorResponse["error"] = { code: error.code, message: error.message };
  if (error.data !== undefined) err.data = error.data;
  return { jsonrpc: "2.0", id, error: err };
}

/** 编码事件推送 notification（设计文档 5.4：method = "event"，params = ExecutionEvent） */
export function encodeNotification(method: string, params?: Record<string, unknown>): RpcRequest {
  const message: RpcRequest = { jsonrpc: "2.0", method };
  if (params !== undefined) message.params = params;
  return message;
}
