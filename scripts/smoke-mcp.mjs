/**
 * M3 冒烟测试脚本（任务清单 M3-03 收口；设计文档第 9 节 / 11 节 M3 验收门）
 *
 * 全链路自动化（真实传输层，区别于 server.test.ts 的 InMemory 集成）：
 *   headless Electron（WS Server + 真插件 utilityProcess）
 *     ↑ WS（KIKO_WS_URL + subscribe_event 全量订阅）
 *   mcp-adapter stdio 进程（MCP Server 网关）
 *     ↑ stdio（MCP JSON-RPC 2.0）
 *   @modelcontextprotocol/sdk Client（StdioClientTransport）
 *
 * 验收门覆盖映射（任务清单 M3 验收门）：
 *   门1 MCP 客户端 tools/list 可见 file + document 全部能力及 schema
 *   门2 tools/call 成功执行 file.write 与 document.create（真插件执行）
 *   门3 长任务（dev.longtask）执行期间 MCP 侧收到 progress notification
 *
 * 环境隔离：临时目录承载 documentsDir / workspaceRoot / userData；
 * headless 走 KIKO_NO_AUTH=1（冒烟兼容开关；真实 token 鉴权由
 * smoke-auth.mjs 验证，本脚本聚焦 MCP 映射层）。
 *
 * 用法：node scripts/smoke-mcp.mjs；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

// ---------------------------------------------------------------------------
// 基础工具（与 smoke.mjs 同款约定）
// ---------------------------------------------------------------------------

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const mcpAdapterDir = join(repoRoot, "packages", "mcp-adapter");

const steps = [];
let failed = false;

async function step(name, fn) {
  try {
    await fn();
    steps.push({ name, ok: true });
    console.log(`[smoke-mcp] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[smoke-mcp] FAIL ${name}\n         ${String(e?.message ?? e)}`);
  }
}

function check(condition, message, actual) {
  if (!condition) {
    throw new Error(
      actual === undefined ? message : `${message}（实际：${JSON.stringify(actual)}）`,
    );
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err !== null) rejectRun(Object.assign(err, { stderr: String(stderr) }));
      else resolveRun(String(stdout).trim());
    });
  });
}

// ---------------------------------------------------------------------------
// MCP SDK Client（从 mcp-adapter 依赖范围解析 SDK）
// ---------------------------------------------------------------------------

const requireFromAdapter = createRequire(join(mcpAdapterDir, "package.json"));
const { Client } = requireFromAdapter("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireFromAdapter("@modelcontextprotocol/sdk/client/stdio.js");

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译 desktop + mcp-adapter（防旧产物误导） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  await run(process.execPath, [tscEntry, "-p", join(mcpAdapterDir, "tsconfig.json")]);
  console.log("[smoke-mcp] desktop + mcp-adapter 构建完成");

  // --- 环境隔离：临时沙箱 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-smoke-mcp-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const requestedPort = 24000 + Math.floor(Math.random() * 10000);

  // --- spawn headless Electron（WS Server + 插件运行时） ---
  const requireFromDesktop = createRequire(join(desktopDir, "package.json"));
  const electronExe = requireFromDesktop("electron");
  check(typeof electronExe === "string", "无法解析 electron 可执行路径");
  const headless = spawn(electronExe, ["."], {
    cwd: desktopDir,
    env: {
      ...process.env,
      KIKO_WS_PORT: String(requestedPort),
      KIKO_DOCUMENTS_DIR: documentsDir,
      KIKO_WORKSPACE_ROOT: workspaceRoot,
      KIKO_USER_DATA_DIR: userDataDir,
      KIKO_NO_AUTH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  headless.stdout.on("data", (chunk) => process.stdout.write(`[headless] ${chunk}`));
  headless.stderr.on("data", (chunk) => process.stderr.write(`[headless-err] ${chunk}`));
  console.log(`[smoke-mcp] headless 已启动：pid=${headless.pid} 请求端口=${requestedPort}`);

  // 从启动日志解析实际 WS 端口（R3 探测可能 +1 偏移）
  const actualPort = await new Promise((resolvePort) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match !== null) {
        headless.stdout.off("data", onData);
        resolvePort(Number(match[1]));
      }
    };
    headless.stdout.on("data", onData);
    headless.once("exit", (code) => {
      if (code !== null) resolvePort(-1);
    });
  });
  check(actualPort > 0, "headless 启动失败（未见 WS 端点日志）");
  // 等待 WS 可连（headless 完成装配）
  await delay(1500);
  const kikoUrl = `ws://127.0.0.1:${actualPort}`;
  console.log(`[smoke-mcp] Kiko WS 端点：${kikoUrl}`);

  // --- spawn mcp-adapter（stdio MCP Server） ---
  const adapterMain = join(mcpAdapterDir, "dist", "main.js");
  check(existsSync(adapterMain), "mcp-adapter 构建产物缺失", adapterMain);
  const client = new Client({ name: "kiko-smoke", version: "0.0.1" }, { capabilities: {} });
  // StdioClientTransport：显式传完整 env（SDK 默认白名单不含 KIKO_*）
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [adapterMain],
    env: {
      ...process.env,
      KIKO_WS_URL: kikoUrl,
      // KIKO_TOKEN 不设：headless 以 KIKO_NO_AUTH=1 运行
    },
  });
  await client.connect(transport);
  console.log("[smoke-mcp] MCP Client 已连接（stdio）");

  const WRITE_PATH = "smoke-mcp/hello.txt";
  const WRITE_CONTENT = "kiko mcp smoke 你好世界";

  // --- 门1：tools/list 可见 file + document 全部能力及 schema ---
  await step("门1 tools/list：file + document 全部能力在列且 schema 完整", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    for (const id of ["file.list", "file.read", "file.write", "document.create"]) {
      check(names.includes(id), `tools/list 应包含 ${id}`, names);
    }
    // schema 完整性：file.write 的 required 含 path/content（describe 合并）
    const write = result.tools.find((t) => t.name === "file.write");
    check(
      write?.inputSchema?.required?.includes("path") === true &&
        write?.inputSchema?.required?.includes("content") === true,
      "file.write inputSchema.required 应含 path/content",
      write?.inputSchema,
    );
    // outputSchema 透传（MCP 侧可见输出结构）
    const doc = result.tools.find((t) => t.name === "document.create");
    check(
      doc?.outputSchema?.properties?.file !== undefined,
      "document.create outputSchema 应透传",
      doc?.outputSchema,
    );
    // description 携带插件来源（Agent 可辨识能力归属）
    check(
      String(write?.description ?? "").includes("file"),
      "file.write description 应含插件来源",
      write?.description,
    );
  });

  // --- 门2a：tools/call 执行 file.write（真插件 utilityProcess 执行） ---
  await step("门2 tools/call(file.write)：completed + 落盘核对", async () => {
    const result = await client.callTool({
      name: "file.write",
      arguments: { path: WRITE_PATH, content: WRITE_CONTENT },
    });
    check(result.isError !== true, "file.write 不应失败", result);
    const payload = JSON.parse(result.content[0].text);
    check(payload.status === "completed", "status 应 completed", payload.status);
    check(payload.result?.path === WRITE_PATH, "返回 path 应一致", payload.result);
    // structuredContent 对齐 output_schema 形状
    check(
      result.structuredContent?.path === WRITE_PATH,
      "structuredContent 应对齐 output_schema",
      result.structuredContent,
    );
    // 落盘核对（主进程侧直接读文件）
    const onDisk = await readFile(join(workspaceRoot, WRITE_PATH), "utf-8");
    check(onDisk === WRITE_CONTENT, "落盘内容应与写入一致", onDisk);
  });

  // --- 门2b：tools/call 执行 document.create（含产物登记） ---
  await step("门2 tools/call(document.create)：completed + artifacts 登记", async () => {
    const result = await client.callTool({
      name: "document.create",
      arguments: { content: "# MCP 冒烟\n\nhello docx", filename: "smoke.docx" },
    });
    check(result.isError !== true, "document.create 不应失败", result);
    const payload = JSON.parse(result.content[0].text);
    check(payload.status === "completed", "status 应 completed", payload.status);
    check(
      typeof payload.result?.filename === "string" && payload.result.filename.endsWith(".docx"),
      "result.filename 应为 docx 文件名",
      payload.result,
    );
    // 产物登记（M2-04 五分结构）：artifacts 数组非空且指向工作空间文件
    check(
      Array.isArray(payload.artifacts) && payload.artifacts.length > 0,
      "artifacts 应非空（document.create 产物登记）",
      payload.artifacts,
    );
    check(
      existsSync(String(payload.artifacts[0]?.file ?? "")),
      "artifact 文件应实际落盘",
      payload.artifacts,
    );
  });

  // --- 门3：长任务 progress notification（M3-02 转发） ---
  await step("门3 tools/call(dev.longtask)：执行期间收到 progress notification", async () => {
    const received = [];
    const result = await client.callTool(
      {
        name: "dev.longtask",
        arguments: { duration_ms: 2500, progress_interval_ms: 500 },
        _meta: { progressToken: "smoke-progress" },
      },
      undefined,
      {
        onprogress: (progress) => {
          received.push({ progress: progress.progress, message: progress.message });
        },
      },
    );
    check(result.isError !== true, "dev.longtask 不应失败", result);
    // 2.5s 任务 / 500ms 间隔 → 至少 3 次上报（10%/30%/50%/70%/90% 附近）
    check(received.length >= 3, `progress 通知应 ≥3 次（实际 ${received.length} 次）`, received);
    check(
      received.every((r) => r.progress >= 0 && r.progress <= 100),
      "progress 应在 0-100 区间",
      received,
    );
    // percent 递增序列（长任务心跳的有序性）
    const percents = received.map((r) => r.progress);
    check(
      percents.every((p, i) => i === 0 || p >= percents[i - 1]),
      "progress 应单调递增",
      percents,
    );
    console.log(`[smoke-mcp]   progress 样例：${JSON.stringify(received.slice(0, 3))}`);
  });

  // --- 错误映射抽验：未知工具 → MCP INVALID_PARAMS ---
  await step("错误映射：未知工具 → McpError(-32602)", async () => {
    let caught = null;
    await client.callTool({ name: "no.such_tool", arguments: {} }).catch((e) => void (caught = e));
    check(caught !== null, "未知工具应抛错");
    check(caught?.code === -32602, "未知能力（40001）应映射为 INVALID_PARAMS(-32602)", {
      code: caught?.code,
      message: caught?.message,
    });
  });

  // --- 门6：bundle 产物可用性（打包链分发的真实形态） ---
  // 用户安装版运行的是 esbuild 自包含单文件（resources/mcp-adapter/
  // main.js），非 tsc 产物——必须对真实分发物验证（banner createRequire
  // 修复的回归防线）。产物缺失（未跑 bundle:plugins）时跳过并提示。
  const bundledAdapter = join(
    repoRoot,
    "apps",
    "desktop",
    "build-resources",
    "mcp-adapter",
    "main.js",
  );
  if (existsSync(bundledAdapter)) {
    await step("门6 bundle 产物：esbuild 单文件经 stdio 正常服务", async () => {
      const bundledClient = new Client(
        { name: "kiko-smoke-bundled", version: "0.0.1" },
        { capabilities: {} },
      );
      const bundledTransport = new StdioClientTransport({
        command: process.execPath,
        args: [bundledAdapter],
        env: { ...process.env, KIKO_WS_URL: kikoUrl },
      });
      await bundledClient.connect(bundledTransport);
      try {
        // listTools + callTool 双抽验（全量链路走 bundle 产物）
        const tools = await bundledClient.listTools();
        check(
          tools.tools.some((t) => t.name === "file.write"),
          "bundle 产物应列出 file.write",
        );
        const writeResult = await bundledClient.callTool({
          name: "file.write",
          arguments: { path: "smoke-mcp/bundled.txt", content: "bundled" },
        });
        const writePayload = JSON.parse(writeResult.content[0].text);
        check(writePayload.status === "completed", "bundle 产物调用应 completed", writePayload);
        const onDisk = await readFile(join(workspaceRoot, "smoke-mcp", "bundled.txt"), "utf-8");
        check(onDisk === "bundled", "bundle 产物落盘核对", onDisk);
      } finally {
        await bundledClient.close();
      }
    });
  } else {
    console.log(
      "[smoke-mcp] SKIP 门6：bundle 产物缺失（先跑 pnpm -C apps/desktop run bundle:plugins）",
    );
  }

  // --- 收尾：断开 + 杀进程树 + 清理沙箱 ---
  await client.close();
  await run("taskkill", ["/T", "/F", "/PID", String(headless.pid)]).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  console.log("\n[smoke-mcp] ====== 汇总 ======");
  for (const s of steps) console.log(`[smoke-mcp] ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  const passed = steps.filter((s) => s.ok).length;
  console.log(`[smoke-mcp] ${passed}/${steps.length} 步骤通过`);
  process.exit(failed ? 1 : 0);
}

// 整体兜底超时（headless 启动 + docx 转换 + 长任务，3 分钟余量）
setTimeout(() => {
  console.error("[smoke-mcp] 整体超时（180s），强制失败退出");
  process.exit(1);
}, 180_000).unref();

main().catch((e) => {
  console.error("[smoke-mcp] 致命错误：", e);
  process.exit(1);
});
