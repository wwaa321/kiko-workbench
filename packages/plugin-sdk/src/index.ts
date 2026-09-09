/**
 * @kiko-workbench/plugin-sdk —— 插件开发者 SDK
 *
 * 职责（设计文档第 8 节）：
 *   - types.ts   插件接口类型：KikoPlugin / PluginContext / InvocationContext
 *                （含 ctx.artifacts.save / register，见 7.4 产物管理）
 *   - paths.ts   resolveSafe 路径校验 + safeFilename + nextConflictName
 *                （plugin-host 单点使用，设计文档 7.4.3 / 8.5）
 *   - host.ts    plugin-host 运行时（M1-07 落地）
 *   - 协议错误模型 re-export（RpcError / ERROR_CODES）：插件作者唯一
 *     面对的接口层（8.4），抛 RpcError 可经 host 透传 code（M1-07）
 *
 * 依赖约束（设计文档第 4 节依赖方向）：
 *   - 插件只允许依赖本包（不得 import electron / core）
 *   - 本包对 protocol 仅类型依赖 + 错误模型运行时复用（RpcError /
 *     ERROR_CODES，属协议错误模型的必要 re-export）
 */
export * from "./types.js";
export * from "./paths.js";
export * from "./host.js";
export { RpcError, ERROR_CODES } from "@kiko-workbench/protocol";
