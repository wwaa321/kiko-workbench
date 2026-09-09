/**
 * M2-02 鉴权冒烟脚本（M2 验收门"鉴权生效：无 token 拒绝 / 有 token 全链路"的自动化锚点）
 *
 * 与 scripts/smoke.mjs（M1-12）/ smoke-persistence.mjs（M2-01）同构：
 * spawn headless Electron + WS/HTTP 双通道 JSON-RPC，环境隔离（临时目录
 * 承载 settings.json / documentsDir / workspaceRoot / userData / db）。
 *
 * 验证链路（对照任务清单 M2-02 验收标准 + 设计文档 5.1）：
 *   步骤 1  Round1 启动（默认鉴权模式）：settings.json 生成 64 hex token
 *   步骤 2  WS 未鉴权先发 discover → -32001 错误响应 + 连接被关闭
 *   步骤 3  WS 正确 token auth → { authenticated: true }，后续
 *           discover → invoke(sync) 全链路正常
 *   步骤 4  HTTP 无 Authorization → 401（body 携带 -32001）；错 token → 401
 *   步骤 5  HTTP 正确 Bearer → 200 + discover / invoke(sync) 全链路
 *   步骤 6  强杀重启（同一 settings.json）：token 跨重启稳定，
 *           Round1 的 token 在 Round2 依然有效（5.1"重启 token 稳定"）
 *
 * 用法：node scripts/smoke-auth.mjs；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// 基础工具（与 smoke-persistence.mjs 同构）
// ---------------------------------------------------------------------------

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** 工程根（scripts/ 的上一级） */
const repoRoot = resolve(scriptDir, "..");
const desktopDir = join(repoRoot, "apps", "desktop");

/** 分步执行记录（汇总输出用） */
const steps = [];
let failed = false;

/** 执行单步：异常 / 断言失败记入步骤表，不中断后续步骤 */
async function step(name, fn) {
  try {
    await fn();
    steps.push({ name, ok: true });
    console.log(`[auth] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[auth] FAIL ${name}\n           ${String(e?.message ?? e)}`);
  }
}

/** 断言辅助：条件不成立抛错（带上下文） */
function check(condition, message, actual) {
  if (!condition) {
    throw new Error(
      actual === undefined ? message : `${message}（实际：${JSON.stringify(actual)}）`,
    );
  }
}

/** execFile 的 Promise 包装（stdout 修剪） */
function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err !== null) rejectRun(Object.assign(err, { stderr: String(stderr) }));
      else resolveRun(String(stdout).trim());
    });
  });
}

// ---------------------------------------------------------------------------
// headless 进程管理 + WS/HTTP 客户端
// ---------------------------------------------------------------------------

/** 解析 electron 可执行文件真身（apps/desktop 依赖范围内 require('electron') 返回路径） */
function resolveElectronExe() {
  const requireFromDesktop = createRequire(join(desktopDir, "package.json"));
  const electronPath = requireFromDesktop("electron");
  check(
    typeof electronPath === "string" && electronPath.length > 0,
    "无法解析 electron 可执行路径",
  );
  return electronPath;
}

/** spawn headless，返回句柄；stdout 透传便于诊断 */
function startHeadless(env, label) {
  const electronExe = resolveElectronExe();
  const headless = spawn(electronExe, ["."], {
    cwd: desktopDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  headless.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  headless.stderr.on("data", (chunk) => process.stderr.write(`[${label}-err] ${chunk}`));
  return headless;
}

/** 从启动日志解析实际 WS 端口（R3 探测可能 +1 偏移）；早退返回 -1 */
async function resolveWsPort(headless) {
  return new Promise((resolvePort) => {
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
}

/** WS JSON-RPC 客户端（按 id 配对响应；支持等待 close） */
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

  /** 等待连接关闭（鉴权失败后 server 主动 close 的断言用） */
  closed(timeoutMs = 10000) {
    return new Promise((resolveClosed, rejectClosed) => {
      const timer = setTimeout(() => rejectClosed(new Error("连接未在时限内关闭")), timeoutMs);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolveClosed();
      });
    });
  }

  close() {
    this.ws.close();
  }
}

/** HTTP POST /rpc 请求（Bearer 可选）；返回 { status, body } */
async function httpRpc(port, payload, authorization) {
  const headers = { "Content-Type": "application/json" };
  if (authorization !== undefined) headers["Authorization"] = authorization;
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers,
    body: payload,
  });
  return { status: response.status, body: await response.text() };
}

/** 强杀进程树（/F = 非优雅退出；鉴权冒烟不依赖优雅退出路径） */
async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  await delay(1500);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译 desktop（确保 headless dist 与源码一致，防旧产物误导） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[auth] desktop 构建完成");

  // --- 环境隔离：临时目录承载全部可写路径（settings.json 在沙箱内） ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-auth-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const dbPath = join(sandbox, "kiko.db");
  const settingsPath = join(sandbox, "settings.json");
  const requestedPort = 26000 + Math.floor(Math.random() * 10000);
  // 注意：不设 KIKO_NO_AUTH——本冒烟验证的就是默认鉴权模式
  const headlessEnv = {
    KIKO_WS_PORT: String(requestedPort),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: userDataDir,
    KIKO_DB_PATH: dbPath,
    KIKO_SETTINGS_PATH: settingsPath,
  };
  console.log(`[auth] 沙箱=${sandbox} settings=${settingsPath}`);

  const WRITE_PATH = "auth/hello.txt";
  const WRITE_CONTENT = "kiko auth smoke 你好世界";

  // ================= Round 1：默认鉴权模式全链路 =================
  let round1Token = null;
  let port1 = 0;
  const headless1 = startHeadless(headlessEnv, "headless-1");
  console.log(`[auth] Round1 headless 已启动：pid=${headless1.pid}`);

  await step("Round1 启动：settings.json 生成 64 hex token + 启动日志报告鉴权已启用", async () => {
    port1 = await resolveWsPort(headless1);
    check(port1 > 0, "Round1 headless 启动失败（未见 WS 端点日志）");
    // settings.json 由 resolveAuthToken 在 WS 就绪前后写入；轮询等待文件出现
    for (let i = 0; i < 50; i++) {
      try {
        await readFile(settingsPath, "utf-8");
        break;
      } catch {
        await delay(200);
        if (i === 49) throw new Error("settings.json 未在 10s 内生成");
      }
    }
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    check(
      /^[0-9a-f]{64}$/.test(settings.access_token ?? ""),
      "access_token 应为 64 位 hex",
      settings.access_token,
    );
    round1Token = settings.access_token;
  });

  await step("Round1 WS 未鉴权先发 discover → -32001 响应 + 连接被关闭", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port1}`);
    await client.opened();
    const closed = client.closed();
    const res = await client.request("discover", {});
    check(res.error?.code === -32001, "未鉴权 discover 应得 -32001", res.error);
    await closed; // 5.1："失败关闭连接"
  });

  await step("Round1 WS 正确 token auth → 后续 discover / invoke(sync) 全链路正常", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port1}`);
    await client.opened();
    const authRes = await client.request("auth", { token: round1Token });
    check(
      authRes.result?.authenticated === true,
      "auth 应返回 { authenticated: true }",
      authRes.result,
    );
    const discovered = await client.request("discover", {});
    check(
      Array.isArray(discovered.result?.capabilities) && discovered.result.capabilities.length > 0,
      "鉴权后 discover 应返回能力列表",
      discovered,
    );
    const invoked = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: WRITE_PATH, content: WRITE_CONTENT },
      mode: "sync",
    });
    check(invoked.error === undefined, "invoke 不应报 JSON-RPC error", invoked.error);
    check(invoked.result?.status === "completed", "write 应 completed", invoked.result);
    const onDisk = await readFile(join(workspaceRoot, WRITE_PATH), "utf-8");
    check(onDisk === WRITE_CONTENT, "落盘内容应与写入一致", onDisk);
    client.close();
  });

  await step("Round1 HTTP 无 Authorization / 错 token → 401（body 携带 -32001）", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "discover", params: {} });
    const noAuth = await httpRpc(port1, payload);
    check(noAuth.status === 401, "无 Authorization 应 401", noAuth.status);
    check(JSON.parse(noAuth.body).error?.code === -32001, "401 body 应携带 -32001", noAuth.body);
    const badAuth = await httpRpc(port1, payload, `Bearer ${"f".repeat(64)}`);
    check(badAuth.status === 401, "错 token 应 401", badAuth.status);
  });

  await step("Round1 HTTP 正确 Bearer → 200 + discover / invoke(sync) 全链路", async () => {
    const bearer = `Bearer ${round1Token}`;
    const discovered = await httpRpc(
      port1,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "discover", params: {} }),
      bearer,
    );
    check(discovered.status === 200, "正确 Bearer 应 200", discovered.status);
    check(
      JSON.parse(discovered.body).result?.capabilities?.length > 0,
      "HTTP discover 应返回能力列表",
      discovered.body,
    );
    const invoked = await httpRpc(
      port1,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "invoke",
        params: {
          capability_id: "file.write",
          input: { path: "auth/http.txt", content: "http" },
          mode: "sync",
        },
      }),
      bearer,
    );
    check(invoked.status === 200, "HTTP invoke 应 200", invoked.status);
    check(
      JSON.parse(invoked.body).result?.status === "completed",
      "HTTP invoke 应 completed",
      invoked.body,
    );
  });

  await step("Round1 强杀主进程（token 持久化在 settings.json，不依赖优雅退出）", async () => {
    await killTree(headless1.pid);
  });

  // ================= Round 2：token 跨重启稳定 =================
  let port2 = 0;
  const headless2 = startHeadless(headlessEnv, "headless-2");
  console.log(`[auth] Round2 headless 已启动：pid=${headless2.pid}`);

  await step("Round2 重启：settings.json token 稳定（不重新生成）", async () => {
    port2 = await resolveWsPort(headless2);
    check(port2 > 0, "Round2 headless 启动失败（未见 WS 端点日志）");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    check(
      settings.access_token === round1Token,
      "重启后 token 应与 Round1 一致（客户端免重新配置）",
      settings.access_token,
    );
  });

  await step("Round2 WS：Round1 的 token 依然有效（auth → invoke 全链路）", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port2}`);
    await client.opened();
    const authRes = await client.request("auth", { token: round1Token });
    check(authRes.result?.authenticated === true, "旧 token 应依然通过鉴权", authRes);
    const invoked = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "auth/restart.txt", content: "restart-ok" },
      mode: "sync",
    });
    check(invoked.result?.status === "completed", "重启后 invoke 应正常", invoked.result);
    client.close();
  });

  await killTree(headless2.pid);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[auth] ======== 冒烟结果 ========");
  for (const s of steps) {
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : `（${s.error}）`}`);
  }
  console.log(`[auth] ${steps.filter((s) => s.ok).length}/${steps.length} 步通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[auth] 冒烟脚本自身异常：", e);
  process.exit(1);
});
