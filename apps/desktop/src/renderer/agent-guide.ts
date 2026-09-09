/**
 * Agent 接入文案生成器（"Agent 接入"模态数据 → 即贴即用的接入指南）
 *
 * 产物形态：一段面向 AI Agent 的中文 Markdown 说明——用户复制后直接
 * 粘贴到所用 Agent 的对话/系统提示词中，Agent 即获得完整接入知识
 * （端点、鉴权、协议方法、调用示例）。协议字段名保持英文（Agent 的
 * 解析惯例），叙述用中文（目标用户环境）。
 *
 * 端点与 token 由 ConnectionInfo 运行时注入——端口冲突自动 +1 重试
 * （ws-server.ts），不能静态写死默认端口。
 */
import type { ConnectionInfo } from "../shared.js";

/**
 * 生成面向 Agent 的接入指南全文。
 *
 * @param info 运行时连接信息（端点 + token；token 缺省时文案自动
 *             切换为"无鉴权模式"分支——KIKO_NO_AUTH 测试逃生门场景）
 */
export function buildAgentGuide(info: ConnectionInfo): string {
  // 鉴权段：有 token → auth 流程说明；无 → 明示免鉴权（Agent 不会瞎猜）
  const authSection =
    info.token !== undefined
      ? [
          "## 鉴权",
          "",
          `- WebSocket：连接后**第一条消息**必须是 auth 请求（携带下方 token）；鉴权失败返回错误码 -32001 并断开连接；重复 auth 幂等`,
          `- HTTP：在请求头携带 \`Authorization: Bearer ${info.token}\``,
          "",
          "auth 请求示例：",
          "",
          "```json",
          `{"jsonrpc": "2.0", "id": 1, "method": "auth", "params": {"token": "${info.token}"}}`,
          "```",
          "",
          `访问令牌（token）：\`${info.token}\``,
        ]
      : ["## 鉴权", "", "本实例运行于无鉴权模式，无需 auth 步骤，可直接调用下方方法。"];

  return [
    "# Kiko Workbench 能力平台接入说明",
    "",
    "Kiko Workbench 是运行在用户本机的能力执行平台（Agent-Native Capability Execution Platform）。你（AI Agent）可通过其本机 RPC 服务调用文件读写、文档生成等能力。",
    "",
    "## 服务端点",
    "",
    `- WebSocket（推荐，支持事件订阅与取消）：${info.wsUrl}`,
    `- HTTP POST（同步调用，路径 /rpc）：${info.httpUrl}`,
    "",
    ...authSection,
    "",
    "## 协议与方法",
    "",
    "JSON-RPC 2.0（请求带 `jsonrpc`/`id`/`method`/`params` 字段）。可用方法：",
    "",
    "| 方法 | 说明 |",
    "| --- | --- |",
    "| `discover(query?)` | 按关键词搜索能力，返回能力清单 |",
    "| `describe(capability_id)` | 获取能力的输入/输出 JSON Schema |",
    "| `invoke(capability_id, input, timeout_ms?)` | 执行能力，同步返回结果或异步返回 invocation_id |",
    "| `get_execution(invocation_id)` | 查询执行状态与结果 |",
    "| `subscribe_event(invocation_id)` | 订阅执行事件（仅 WS 通道） |",
    "| `cancel(invocation_id)` | 请求取消执行 |",
    "",
    "推荐流程：`discover`（找能力）→ `describe`（看参数 schema）→ `invoke`（按 schema 传参）。",
    "",
    "## 调用示例（HTTP）",
    "",
    "```bash",
    ...curlExample(info),
    "```",
    "",
    "## 常用错误码",
    "",
    "| 错误码 | 含义 |",
    "| --- | --- |",
    "| -32001 | 鉴权失败（token 缺失或错误） |",
    "| -32601 | 方法不存在 |",
    "| -32602 | 参数无效 |",
    "| 40001 | 能力不存在或已禁用 |",
    "| 40005 | 插件不可用（加载失败或崩溃熔断） |",
    "| 50001 | 插件执行错误（含路径越界） |",
  ].join("\n");
}

/** HTTP 调用示例 curl（有/无 token 两种形态，Agent 可直接照抄改参） */
function curlExample(info: ConnectionInfo): string[] {
  const lines = [`curl -X POST ${info.httpUrl} \\`, '  -H "Content-Type: application/json" \\'];
  if (info.token !== undefined) {
    lines.push(`  -H "Authorization: Bearer ${info.token}" \\`);
  }
  lines.push(
    '  -d \'{"jsonrpc": "2.0", "id": 1, "method": "discover", "params": {"query": "file"}}\'',
  );
  return lines;
}
