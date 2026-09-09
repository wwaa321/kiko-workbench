/**
 * mcp-adapter stdio 入口（设计文档第 9 节："标准 MCP Server（stdio /
 * HTTP 可选）"的 stdio 形态）
 *
 * 进程模型：独立纯 Node 进程（外部 MCP 客户端——Claude Desktop /
 * Cursor 等——以命令方式拉起），经 WS 连接运行中的 Kiko（headless /
 * desktop 主进程的 WsRpcServer）。
 *
 * 环境变量（与 desktop 的 KIKO_* 惯例对齐）：
 *   KIKO_WS_URL   缺省 ws://127.0.0.1:47830（设计文档第 3 节要点 2）
 *   KIKO_TOKEN    WS 鉴权 token（settings.json 的 access_token；
 *                 服务端 KIKO_NO_AUTH=1 时可不设）
 *
 * 退出策略（任一通道断裂即退出，交由 MCP 宿主重启）：
 *   - WS 断连 / 鉴权失败：stdio Server 关闭 → 进程退出（exit 1）
 *   - stdin EOF（MCP 客户端关闭）：关闭 WS → 进程退出（exit 0）
 *   - 未捕获异常：日志到 stderr 后退出（stdio 通道不得混入非 MCP 帧）
 */
import { WsKikoRpcClient } from "./ws-kiko-rpc.js";
import { createKikoMcpServer } from "./server.js";

/** 读取环境变量（窄化 undefined，main 模块无测试注入需求） */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const rpc = new WsKikoRpcClient({
    url: env("KIKO_WS_URL"),
    token: env("KIKO_TOKEN"),
  });

  // 后端连接先行：失败即快退（MCP 客户端可读 stderr 诊断）
  try {
    await rpc.connect();
  } catch (error) {
    console.error(
      `[kiko-mcp] Kiko 服务连接失败（${env("KIKO_WS_URL") ?? "ws://127.0.0.1:47830"}）：${String(error instanceof Error ? error.message : error)}`,
    );
    process.exit(1);
  }

  // MCP Server 挂接 stdio 传输（动态导入避免库代码耦合传输形态）
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createKikoMcpServer(rpc);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 任一侧断裂即整体退出（stdio Server 无原生"close on stdin EOF"，
  // 显式监听兜底；交由 MCP 宿主按需重启进程）
  server.onclose = () => {
    rpc.close();
    process.exit(0);
  };
  process.stdin.once("end", () => {
    rpc.close();
    void server.close();
  });

  console.error(
    `[kiko-mcp] ready: backend=${env("KIKO_WS_URL") ?? "ws://127.0.0.1:47830"}（stdio 已就绪）`,
  );
}

main().catch((error) => {
  // 兜底：未捕获异常走 stderr（stdout 是 MCP 帧，不得污染）
  console.error(`[kiko-mcp] 致命错误：${String(error instanceof Error ? error.message : error)}`);
  process.exit(1);
});
