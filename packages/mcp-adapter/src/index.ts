/**
 * @kiko-workbench/mcp-adapter —— MCP 适配器（设计文档第 9 节，M3）
 *
 * 职责：自定义协议 ⇄ MCP 适配（映射表见 server.ts 头注）
 *   - tools/list            <- discover() + 逐能力 describe() 合并（MCP 需一次性全量 schema）
 *   - tools/call            <- invoke（async 受理 + 等终态；对外同步语义）
 *   - progress notification <- execution.progress 事件转发（长任务心跳）
 *   - subscribe_event / get_execution 原始形态在 MCP 侧不可表达，
 *     映射时丢弃（kiko-rpc.ts 接口注释即文档化说明）
 *
 * 进程形态（实现期决策，登记偏差表）：stdio 独立进程 + WS 网关——
 * 插件宿主（utilityProcess）只能存活于 Electron 主进程，故适配器经
 * WS 连接运行中的 Kiko（复用鉴权与插件运行时），不进程内组装 core。
 * 依赖 protocol + ws + @modelcontextprotocol/sdk（不含 core）。
 *
 * 入口：main.ts（bin: kiko-mcp-adapter，stdio MCP Server）
 */
export { createKikoMcpServer } from "./server.js";
export { WsKikoRpcClient, type WsKikoRpcOptions } from "./ws-kiko-rpc.js";
export type {
  KikoRpcClient,
  KikoRpcError,
  KikoProgressEvent,
  KikoTerminalStatus,
} from "./kiko-rpc.js";
