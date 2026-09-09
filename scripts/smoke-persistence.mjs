/**
 * M2-01 持久化冒烟脚本（M2 验收门"执行中 kill 应用再启动"的自动化锚点）
 *
 * 与 scripts/smoke.mjs（M1-12）同构：spawn headless Electron + WS JSON-RPC，
 * 环境隔离（临时目录承载 documentsDir / workspaceRoot / userData / db）。
 *
 * 验证链路（对照任务清单 M2-01 验收标准 + M2 验收门第 5 条）：
 *   步骤 1  Round1 invoke(file.write, sync) → completed + 产物落盘
 *   步骤 2  强杀主进程（taskkill /F /T = 非优雅退出，不走 will-quit）
 *   步骤 3  注入残留：直接写 SQLite，模拟执行中被 kill 的 running 态
 *           invocation + 未启动的 pending（created）态 invocation
 *   步骤 4  Round2 重启（同一 KIKO_DB_PATH）：
 *           - 持久化：Round1 的 completed invocation 数据完整（状态 /
 *             result / 事件时间线 / 日志）
 *           - 恢复：注入的 running / pending → failed(50001) + 补发
 *             execution.failed 事件（事件有记录，验收门原文）
 *   注：UI 可查（验收门第 5 条的 UI 部分）属 M2-08 范围，留 UI 落地后复测。
 *
 * 用法：node scripts/smoke-persistence.mjs；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// 基础工具（与 smoke.mjs 同构）
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
    console.log(`[persist] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[persist] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// headless 进程管理 + WS 客户端（与 smoke.mjs 同构）
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

/** spawn headless（KIKO_DB_PATH 指向沙箱库文件），返回句柄；stdout 透传便于诊断 */
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

/** 轮询直到 WS 端口可连（headless 启动需要数秒） */
async function waitServerReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = new WebSocket(url);
    const outcome = await new Promise((resolveProbe) => {
      probe.once("open", () => resolveProbe("open"));
      probe.once("error", () => resolveProbe("error"));
    });
    probe.close();
    if (outcome === "open") return;
    if (Date.now() >= deadline) throw new Error(`headless WS ${timeoutMs}ms 内未就绪：${url}`);
    await delay(400);
  }
}

/** WS JSON-RPC 客户端（按 id 配对；与 smoke.mjs 同构） */
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

/** 强杀进程树（/F = 非优雅退出：不触发 will-quit，模拟崩溃 / 断电） */
async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  // 端口 / 文件句柄释放需要一点时间（Windows 上 taskkill 异步完成）
  await delay(1500);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译 desktop（确保 headless dist 与源码一致，防旧产物误导） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[persist] desktop 构建完成");

  // --- 环境隔离：临时目录承载全部可写路径（db 在沙箱内，两轮共用） ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-persist-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const dbPath = join(sandbox, "kiko.db");
  const requestedPort = 24000 + Math.floor(Math.random() * 10000);
  const headlessEnv = {
    // 无鉴权冒烟模式（与 smoke.mjs / smoke-bootstrap.mjs 同策略）：本脚本
    // 聚焦崩溃恢复语义，真实 token 鉴权路径已由 smoke-plugins / smoke-shell
    // 覆盖；不设此项时 headless 默认启用鉴权，WS 首条消息必须为 auth
    KIKO_NO_AUTH: "1",
    KIKO_WS_PORT: String(requestedPort),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: userDataDir,
    KIKO_DB_PATH: dbPath,
  };
  console.log(`[persist] 沙箱=${sandbox} db=${dbPath}`);

  const WRITE_PATH = "persist/hello.txt";
  const WRITE_CONTENT = "kiko persistence 你好世界";
  /** 注入的残留 invocation（模拟执行中被 kill 的窗口残留） */
  const INJECTED_RUNNING = "inv_injected_running";
  const INJECTED_PENDING = "inv_injected_pending";

  // ================= Round 1：正常执行 → completed → 强杀 =================
  let completedId = null;
  let headless1 = startHeadless(headlessEnv, "headless-1");
  console.log(`[persist] Round1 headless 已启动：pid=${headless1.pid}`);
  /** Round1 实际 WS 端口（resolveWsPort 只能调用一次：端口日志仅启动时输出） */
  let port1 = 0;

  await step("Round1 启动：WS 就绪 + db 文件已创建", async () => {
    port1 = await resolveWsPort(headless1);
    check(port1 > 0, "Round1 headless 启动失败（未见 WS 端点日志）");
    await waitServerReady(`ws://127.0.0.1:${port1}`);
    // WAL 模式下 kiko.db-wal 已出现（库文件由 createSqliteStores 即刻创建）
    const { access } = await import("node:fs/promises");
    await access(dbPath);
  });

  await step("Round1 invoke(file.write, sync)：completed + 落盘一致", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port1}`);
    await client.opened();
    const res = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: WRITE_PATH, content: WRITE_CONTENT },
      mode: "sync",
    });
    check(res.error === undefined, "invoke 不应报 JSON-RPC error", res.error);
    check(res.result.status === "completed", "write 应 completed", res.result);
    check(
      res.result.result?.size === Buffer.byteLength(WRITE_CONTENT, "utf-8"),
      "size 应为内容字节数",
      res.result.result,
    );
    completedId = res.result.invocation_id;
    client.close();
    const onDisk = await readFile(join(workspaceRoot, WRITE_PATH), "utf-8");
    check(onDisk === WRITE_CONTENT, "落盘内容应与写入一致", onDisk);
  });

  await step("Round1 强杀主进程（taskkill /F /T，非优雅退出）", async () => {
    await killTree(headless1.pid);
  });

  // ================= 注入残留：直接写 SQLite（模拟执行中被 kill） =================
  await step("注入残留：running + pending（created）两条 invocation 直写 SQLite", async () => {
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    try {
      db.exec("BEGIN");
      // running 态：执行中被 kill 的窗口残留（started_at 已落库）
      db.prepare(
        `INSERT INTO invocations
             (id, capability_id, input, status, mode, created_at, started_at, ended_at, result, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        INJECTED_RUNNING,
        "file.write",
        JSON.stringify({ path: "persist/interrupted.txt", content: "x" }),
        "running",
        "sync",
        now,
        now,
        null,
        null,
        null,
      );
      // pending 态（内部 created）：已创建未进插件进程的残留
      db.prepare(
        `INSERT INTO invocations
             (id, capability_id, input, status, mode, created_at, started_at, ended_at, result, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        INJECTED_PENDING,
        "file.write",
        JSON.stringify({ path: "persist/never-started.txt", content: "x" }),
        "created",
        "sync",
        now,
        null,
        null,
        null,
        null,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.close();
    }
  });

  // ================= Round 2：重启 → 持久化 + 恢复双验证 =================
  const headless2 = startHeadless(headlessEnv, "headless-2");
  console.log(`[persist] Round2 headless 已启动：pid=${headless2.pid}`);
  let client2 = null;

  await step("Round2 重启：WS 就绪 + 启动恢复日志输出", async () => {
    const port = await resolveWsPort(headless2);
    check(port > 0, "Round2 headless 启动失败（未见 WS 端点日志）");
    await waitServerReady(`ws://127.0.0.1:${port}`);
    client2 = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client2.opened();
  });

  await step(
    "持久化：Round1 completed invocation 状态 / result / 事件 / 日志全量还原",
    async () => {
      const res = await client2.request("get_execution", {
        invocation_id: completedId,
        include_events: true,
        include_logs: true,
      });
      check(res.error === undefined, "get_execution 不应报错", res.error);
      check(res.result.status === "completed", "重启后状态应保持 completed", res.result.status);
      check(
        res.result.result?.size === Buffer.byteLength(WRITE_CONTENT, "utf-8"),
        "result.data 应完整还原",
        res.result.result,
      );
      const timeline = (res.result.events ?? []).map((e) => e.event);
      check(
        JSON.stringify(timeline) ===
          JSON.stringify(["invocation.created", "execution.started", "execution.completed"]),
        "事件时间线应完整还原（created → started → completed）",
        timeline,
      );
      // 日志数组结构应存在（file 插件 host 有输出；空数组也算结构完整）
      check(Array.isArray(res.result.logs), "logs 字段应为数组", res.result.logs);
    },
  );

  await step("恢复：注入的 running → failed(50001) + 补发 execution.failed 事件", async () => {
    const res = await client2.request("get_execution", {
      invocation_id: INJECTED_RUNNING,
      include_events: true,
    });
    check(res.error === undefined, "get_execution 不应报错", res.error);
    check(res.result.status === "failed", "running 残留应被标记 failed", res.result.status);
    check(res.result.error?.code === 50001, "error.code 应为 50001", res.result.error);
    check(
      res.result.error?.message === "workbench restarted",
      "error.message 应为 workbench restarted",
      res.result.error,
    );
    const timeline = (res.result.events ?? []).map((e) => e.event);
    check(
      timeline.includes("execution.failed"),
      "应补发 execution.failed 事件（事件有记录）",
      timeline,
    );
  });

  await step("恢复：注入的 pending → failed(50001)（未启动路径同样兜底）", async () => {
    const res = await client2.request("get_execution", {
      invocation_id: INJECTED_PENDING,
      include_events: true,
    });
    check(res.error === undefined, "get_execution 不应报错", res.error);
    check(res.result.status === "failed", "pending 残留应被标记 failed", res.result.status);
    check(res.result.error?.code === 50001, "error.code 应为 50001", res.result.error);
    const timeline = (res.result.events ?? []).map((e) => e.event);
    check(timeline.includes("execution.failed"), "应补发 execution.failed 事件", timeline);
  });

  await step("Round2 新调用可用（恢复不阻断后续执行）", async () => {
    const res = await client2.request("invoke", {
      capability_id: "file.write",
      input: { path: "persist/after-restart.txt", content: "alive" },
      mode: "sync",
    });
    check(res.error === undefined, "invoke 不应报 JSON-RPC error", res.error);
    check(res.result.status === "completed", "重启后新调用应 completed", res.result);
  });

  // --- 收尾：断开 + 杀进程树 + 清理沙箱 ---
  client2?.close();
  await run("taskkill", ["/T", "/F", "/PID", String(headless2.pid)]).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[persist] ====== 汇总 ======");
  for (const s of steps) console.log(`[persist] ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  const passed = steps.filter((s) => s.ok).length;
  console.log(`[persist] ${passed}/${steps.length} 步骤通过`);
  process.exit(failed ? 1 : 0);
}

// 整体兜底超时：任何环节挂死都在 3 分钟内强退（防 CI 悬挂）
setTimeout(() => {
  console.error("[persist] 整体超时（180s），强制失败退出");
  process.exit(1);
}, 180_000).unref();

main().catch((e) => {
  console.error("[persist] 致命错误：", e);
  process.exit(1);
});
