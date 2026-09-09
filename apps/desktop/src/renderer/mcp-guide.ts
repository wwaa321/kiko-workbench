/**
 * MCP 接入配置生成器（"MCP 接入"模态数据 → 即贴即用的客户端配置）
 *
 * 产物形态：标准 mcpServers JSON 片段——Claude Desktop（claude_
 * desktop_config.json）/ Cursor（.cursor/mcp.json 或全局 mcp.json）等
 * MCP 客户端通用格式。用户复制后粘贴进所用客户端的配置文件，重启
 * 客户端即可把 Kiko Workbench 的能力挂载为 MCP 工具集。
 *
 * command 用 "node"：适配器为纯 Node ESM 单文件，由 MCP 客户端
 * spawn——要求用户本机装有 Node.js（≥18，MCP SDK 基线）；路径与
 * token 由 ConnectionInfo 运行时注入，不能静态写死。
 */
import type { ConnectionInfo } from "../shared.js";

/**
 * 生成 MCP 客户端配置 JSON（mcpServers 片段，2 空格缩进）。
 *
 * @param info 运行时连接信息（适配器路径 + WS 端点 + token）；
 *             mcpAdapterPath 缺失时返回 null（模态展示引导文案）
 */
export function buildMcpConfig(info: ConnectionInfo): string | null {
  if (info.mcpAdapterPath === undefined) return null;
  const server: Record<string, unknown> = {
    command: "node",
    args: [info.mcpAdapterPath],
    env: {
      KIKO_WS_URL: info.wsUrl,
      // 无鉴权模式（KIKO_NO_AUTH）不注入 token——适配器跳过 auth 握手
      ...(info.token !== undefined ? { KIKO_TOKEN: info.token } : {}),
    },
  };
  return JSON.stringify({ mcpServers: { "kiko-workbench": server } }, null, 2);
}
