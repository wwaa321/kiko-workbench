/**
 * @kiko-workbench/protocol —— 协议层
 *
 * 职责（设计文档第 5 节 / 7.1 节）：
 *   - JSON-RPC 2.0 编解码（json-rpc.ts，含 malformed 请求的 -32600 判定）
 *   - 六方法参数与响应类型（methods.ts：discover / describe / invoke /
 *     get_execution / subscribe_event / cancel）
 *   - 核心对象类型（types.ts：CapabilityDefinition / InvocationStatus /
 *     ArtifactInfo / InvocationResult / ExecutionEvent / ExecutionLog）
 *   - 错误码常量与 RpcError（errors.ts，设计文档 5.5）
 *
 * 约束：零运行时依赖，纯类型 + 纯函数（设计文档第 4 节依赖方向）。
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./methods.js";
export * from "./json-rpc.js";
