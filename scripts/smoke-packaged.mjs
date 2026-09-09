/**
 * M2-10a 打包产物冒烟脚本（win-unpacked 实跑核心链路）
 *
 * 验证对象：electron-builder 产物（release/win-unpacked/Kiko Workbench.exe）
 * 的打包形态适配全链路——asar 主进程 / resources/plugins bundle 加载 /
 * utilityProcess fork asar 内 host-entry / node:sqlite 打包运行时。
 *
 * 与开发态 smoke 的差异（本脚本专门锁定打包特有风险）：
 *   1. app.isPackaged = true → 入口分发默认应用壳（无 KIKO_SHELL）
 *   2. 插件目录 = resources/plugins（esbuild bundle，非 tsc 产物）
 *   3. host-entry = app.asar 内 node_modules（utilityProcess fork）
 *   4. SQLite = Electron 内嵌 Node 运行时（node:sqlite）
 *
 * 验证链路：
 *   步骤 1  打包产物启动：进程存活 + 端口监听（Windows GUI 子进程
 *           stdout 不保证可达——WS 连通即就绪锚点，stdout 仅锦上添花）
 *   步骤 2  鉴权装配：settings.json 生成 token → auth 成功
 *   步骤 3  插件 bundle 注册：discover 可见 file/document/dev 全部 5 能力
 *   步骤 4  全链路执行：invoke file.write completed（bundle 动态 import +
 *           asar host-entry fork + SQLite 落库 + artifacts 登记）
 *   步骤 5  document bundle 依赖：document.create completed + docx 文件
 *           真实落盘（docx inline 进 bundle 的运行时验证）
 *
 * 用法：node scripts/smoke-packaged.mjs（前置：pnpm --filter
 * kiko-workbench-desktop run dist 已产出 win-unpacked）；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const exePath = join(repoRoot, "apps", "desktop", "release", "win-unpacked", "Kiko Workbench.exe");

const steps = [];
let failed = false;

async function step(name, fn) {
  try {
    await fn();
    steps.push({ name, ok: true });
    console.log(`[packaged] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[packaged] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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

/** WS JSON-RPC 客户端（与既有 smoke 同构） */
class SmokeClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  opened() {
    return new Promise((resolveOpen, rejectOpen) => {
      this.ws.once("open", resolveOpen);
      this.ws.once("error", rejectOpen);
    });
  }

  request(method, params, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReq(msg);
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

/** 轮询 WS 端口直至连通（打包产物就绪探测；GUI 子进程 stdout 不可靠） */
async function waitWsReady(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = new WebSocket(`ws://127.0.0.1:${port}`);
    const outcome = await new Promise((resolveProbe) => {
      probe.once("open", () => resolveProbe("open"));
      probe.once("error", () => resolveProbe("error"));
    });
    probe.close();
    if (outcome === "open") return true;
    if (Date.now() >= deadline) return false;
    await delay(500);
  }
}

async function main() {
  // 前置断言：win-unpacked 产物存在
  await access(exePath);
  console.log(`[packaged] 产物：${exePath}`);

  // 环境隔离（沙箱可写区域；documents/workspace/userData 全重定向）
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-packaged-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const settingsPath = join(sandbox, "user-data", "settings.json");
  const port = 41500 + Math.floor(Math.random() * 2000);

  const app = spawn(exePath, [], {
    env: {
      ...process.env,
      KIKO_WS_PORT: String(port),
      KIKO_DOCUMENTS_DIR: documentsDir,
      KIKO_WORKSPACE_ROOT: workspaceRoot,
      KIKO_USER_DATA_DIR: join(sandbox, "user-data"),
      KIKO_SETTINGS_PATH: settingsPath,
      KIKO_DB_PATH: join(sandbox, "user-data", "kiko.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stdout 若可达（pipe 句柄传入）转储供排障；不可达也不影响 WS 锚点
  let stdoutTail = "";
  app.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdoutTail = (stdoutTail + text).slice(-4000);
    process.stdout.write(`[packaged-app] ${text}`);
  });
  app.stderr.on("data", (chunk) => process.stderr.write(`[packaged-app-err] ${chunk}`));
  const mainPid = app.pid;

  let client;
  try {
    await step("打包产物启动：进程存活 + WS 端口监听（isPackaged → 默认应用壳）", async () => {
      const ready = await waitWsReady(port);
      check(ready, "45s 内 WS 端口未连通（启动失败或端口被占）");
    });

    await step("鉴权装配：settings.json 生成 token → auth 成功", async () => {
      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      check(typeof settings.access_token === "string", "settings.json 应含 access_token");
      client = new SmokeClient(`ws://127.0.0.1:${port}`);
      await client.opened();
      const authRes = await client.request("auth", { token: settings.access_token });
      check(authRes.result?.authenticated === true, "auth 应成功", authRes);
    });

    await step("插件 bundle 注册：discover 可见 file/document/dev 全部 5 能力", async () => {
      const discovered = await client.request("discover", {});
      const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
      check(ids.length === 5, "应有 5 项能力", ids);
      for (const id of [
        "file.read",
        "file.write",
        "file.list",
        "document.create",
        "dev.longtask",
      ]) {
        check(ids.includes(id), `discover 应含 ${id}`, ids);
      }
    });

    await step(
      "全链路执行：file.write completed（bundle 动态 import + asar host-entry + SQLite）",
      async () => {
        const invoked = await client.request("invoke", {
          capability_id: "file.write",
          input: { path: "packaged-smoke/hello.txt", content: "打包产物冒烟" },
          mode: "sync",
        });
        check(invoked.result?.status === "completed", "file.write 应 completed", invoked);
        check(invoked.result?.artifacts?.length === 1, "响应应携带 artifacts", invoked.result);
      },
    );

    await step("document bundle 依赖：document.create completed + docx 真实落盘", async () => {
      const invoked = await client.request("invoke", {
        capability_id: "document.create",
        input: {
          filename: "打包验证",
          format: "docx",
          content: "# 打包验证\n\n- bundle 内联 docx 依赖\n- 显式东亚字体",
        },
        mode: "sync",
      });
      check(invoked.result?.status === "completed", "document.create 应 completed", invoked);
      const artifact = invoked.result?.artifacts?.[0];
      check(artifact !== undefined, "应登记 artifacts", invoked.result);
      // 磁盘佐证：绝对路径真实存在（协议 ArtifactInfo.file = 绝对路径）
      await access(artifact.file);
      check(artifact.size > 0, "docx 应非空", artifact);
    });
  } finally {
    client?.close();
    await run("taskkill", ["/T", "/F", "/PID", String(mainPid)]).catch(() => undefined);
    await delay(1000);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("\n[packaged] ====== 汇总 ======");
  for (const s of steps) console.log(`[packaged] ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  const passed = steps.filter((s) => s.ok).length;
  console.log(`[packaged] ${passed}/${steps.length} 步骤通过`);
  process.exit(failed ? 1 : 0);
}

// 整体兜底超时
setTimeout(() => {
  console.error("[packaged] 整体超时（120s），强制失败退出");
  process.exit(1);
}, 120_000).unref();

main().catch((e) => {
  console.error("[packaged] 致命错误：", e);
  process.exit(1);
});
