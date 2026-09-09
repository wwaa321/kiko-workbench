/**
 * M2-03 异步执行与取消冒烟脚本（M2 验收门"async invoke + progress 推送 +
 * cancel 双路径"的自动化锚点）
 *
 * 与 scripts/smoke.mjs / smoke-auth.mjs 同构：spawn headless Electron +
 * WS JSON-RPC，环境隔离（临时目录承载 documentsDir / workspaceRoot /
 * userData / db）。KIKO_NO_AUTH=1 跳过鉴权（鉴权链路由 smoke-auth.mjs
 * 覆盖），专注异步语义。
 *
 * 验证链路（对照任务清单 M2-03 验收标准 + 设计文档 5.3.3 / 5.3.5 /
 * 5.3.6 / 5.4）：
 *   步骤 1  headless 启动，dev 插件（dev.longtask）出现在插件清单
 *   步骤 2  路径 A（协作取消）：invoke async(10s, 进度间隔 300ms) →
 *           subscribe_event 收 progress 序列（percent 递增）→ cancel →
 *           响应 cancelled + execution.cancelled 推送（远早于 10s 完成）
 *   步骤 3  路径 A 收尾：get_execution 事件时间线含 progress 事件序列
 *   步骤 4  路径 B（强杀）：invoke async(10s, ignore_cancel=true) →
 *           cancel → 5s 宽限内插件不响应 → 强杀 + 终态 cancelled
 *           （cancel 响应耗时 ≥ 5s 佐证宽限真实生效）
 *   步骤 5  路径 B 收尾：强杀后插件进程 lazy 重启——短任务(2s)正常完成
 *           （崩溃/强杀不熔断：intentional kill 不计崩溃，恢复可用）
 *
 * 用法：node scripts/smoke-async.mjs；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// 基础工具（与 smoke-auth.mjs 同构）
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
    console.log(`[async] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[async] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// headless 进程管理 + WS 客户端（含 notification 接收）
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

/** WS JSON-RPC 客户端：request 按 id 配对响应；notification（无 id）入队列 */
class SmokeClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    /** 5.4 事件推送队列（method=event 的 notification） */
    this.notifications = [];
    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method === "event") this.notifications.push(msg.params);
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

  /**
   * 等待下一个指定事件名的推送（跳过不匹配事件；超时抛错）。
   * params 形状（5.4）：{ event, invocation_id, timestamp, data }
   */
  waitEvent(eventName, invocationId, timeoutMs = 15000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        rejectEvent(new Error(`等待事件 ${eventName} 超时`));
      }, timeoutMs);
      const poll = () => {
        const index = this.notifications.findIndex(
          (p) =>
            p.event === eventName &&
            (invocationId === undefined || p.invocation_id === invocationId),
        );
        if (index >= 0) {
          clearTimeout(timer);
          resolveEvent(this.notifications.splice(index, 1)[0]);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  close() {
    this.ws.close();
  }
}

/** 强杀进程树（/F = 非优雅退出；冒烟不依赖优雅退出路径） */
async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  await delay(1500);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译（protocol → sdk → dev 插件 → desktop，防旧产物误导） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  for (const project of ["packages/protocol", "packages/plugin-sdk", "packages/plugins/dev"]) {
    await run(process.execPath, [tscEntry, "-p", join(repoRoot, project, "tsconfig.json")]);
  }
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[async] 构建完成（protocol / sdk / dev 插件 / desktop）");

  // --- 环境隔离：临时目录承载全部可写路径 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-async-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const requestedPort = 26000 + Math.floor(Math.random() * 10000);
  // KIKO_NO_AUTH=1：鉴权链路由 smoke-auth.mjs 覆盖，本冒烟专注异步语义
  const headlessEnv = {
    KIKO_WS_PORT: String(requestedPort),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: userDataDir,
    KIKO_DB_PATH: join(sandbox, "kiko.db"),
    KIKO_SETTINGS_PATH: join(sandbox, "settings.json"),
    KIKO_NO_AUTH: "1",
  };
  console.log(`[async] 沙箱=${sandbox}`);

  const headless = startHeadless(headlessEnv, "headless");
  console.log(`[async] headless 已启动：pid=${headless.pid}`);
  let port = 0;

  await step("启动：dev 插件加载成功（dev.longtask 可发现）", async () => {
    port = await resolveWsPort(headless);
    check(port > 0, "headless 启动失败（未见 WS 端点日志）");
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    const discovered = await client.request("discover", { query: "Long" });
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(ids.includes("dev.longtask"), "discover 应包含 dev.longtask", ids);
    client.close();
  });

  // ================= 路径 A：协作取消（progress 序列 + cancel） =================

  await step("路径 A：async 受理即返回 + progress 序列推送（percent 递增）", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    await client.request("subscribe_event", {});

    const t0 = Date.now();
    const res = await client.request("invoke", {
      capability_id: "dev.longtask",
      input: { duration_ms: 10000, progress_interval_ms: 300 },
      mode: "async",
    });
    const invocationId = res.result?.invocation_id;
    check(res.result?.status === "running", "async invoke 应返回 running", res.result);

    // progress 序列：至少两个检查点且 percent 严格递增（5.4 推送）
    const first = await client.waitEvent("execution.progress", invocationId);
    const firstPercent = first.data?.percent;
    const second = await client.waitEvent("execution.progress", invocationId);
    check(
      typeof firstPercent === "number" && firstPercent < second.data?.percent,
      "progress percent 应递增",
      [first.data, second.data],
    );
    console.log(`[async]   progress 序列：${firstPercent}% → ${second.data.percent}%`);

    // 协作取消：远早于 10s 任务完成（5.3.6 返回时已终态）
    const cancelRes = await client.request("cancel", { invocation_id: invocationId });
    const elapsed = Date.now() - t0;
    check(cancelRes.result?.status === "cancelled", "cancel 响应应为 cancelled", cancelRes.result);
    check(elapsed < 8000, `协作取消应远早于 10s 完成（实际 ${elapsed}ms）`, elapsed);
    console.log(`[async]   协作取消耗时 ${elapsed}ms（任务设定 10s）`);

    // 订阅者收到 execution.cancelled 推送（5.4）
    const cancelled = await client.waitEvent("execution.cancelled", invocationId);
    check(cancelled.invocation_id === invocationId, "cancelled 推送应匹配 invocation");

    // get_execution 事件时间线包含 progress 事件（5.3.4 include_events）
    const detail = await client.request("get_execution", {
      invocation_id: invocationId,
      include_events: true,
    });
    const timeline = (detail.result?.events ?? []).map((e) => e.event);
    const progressCount = timeline.filter((e) => e === "execution.progress").length;
    check(
      progressCount >= 2 && timeline.at(-1) === "execution.cancelled",
      "事件时间线应含 ≥2 个 progress 且以 cancelled 收尾",
      timeline,
    );
    console.log(`[async]   时间线：${timeline.join(" → ")}`);
    client.close();
  });

  // ================= 路径 B：不协作强杀（ignore_cancel + 5s 宽限） =================

  await step("路径 B：ignore_cancel 不协作 → 5s 宽限耗尽强杀 + 终态 cancelled", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    await client.request("subscribe_event", {});

    const res = await client.request("invoke", {
      capability_id: "dev.longtask",
      input: { duration_ms: 10000, ignore_cancel: true, progress_interval_ms: 300 },
      mode: "async",
    });
    const invocationId = res.result?.invocation_id;
    check(res.result?.status === "running", "async invoke 应返回 running", res.result);
    // 等首个 progress：确认插件真的在跑（强杀路径的"正在运行"前提）
    await client.waitEvent("execution.progress", invocationId);

    const t0 = Date.now();
    // 宽限 5s（真实默认值）+ 终态确认：超时上限 15s 覆盖
    const cancelRes = await client.request("cancel", { invocation_id: invocationId }, 15000);
    const elapsed = Date.now() - t0;
    check(
      cancelRes.result?.status === "cancelled",
      "强杀路径 cancel 响应应为 cancelled",
      cancelRes.result,
    );
    // 宽限真实生效：不协作插件要等满 5s 宽限才被强杀收尾
    check(elapsed >= 5000, `不协作取消应等待 ≥5s 宽限（实际 ${elapsed}ms）`, elapsed);
    console.log(`[async]   强杀路径 cancel 耗时 ${elapsed}ms（含 5s 宽限）`);

    const cancelled = await client.waitEvent("execution.cancelled", invocationId);
    check(cancelled.invocation_id === invocationId, "cancelled 推送应匹配 invocation");
    client.close();
  });

  await step("路径 B 收尾：强杀后插件进程 lazy 重启，短任务正常完成", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    // 强杀是 intentional kill（不计崩溃、不熔断）→ 下次 invoke 重启进程
    const res = await client.request("invoke", {
      capability_id: "dev.longtask",
      input: { duration_ms: 1500, progress_interval_ms: 500 },
      mode: "sync",
    });
    check(res.result?.status === "completed", "强杀后短任务应正常完成（进程恢复）", res.result);
    const slept = res.result?.result?.slept_ms;
    check(typeof slept === "number" && slept >= 1400, "slept_ms 应接近任务时长", slept);
    client.close();
  });

  await killTree(headless.pid);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[async] ======== 冒烟结果 ========");
  for (const s of steps) {
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : `（${s.error}）`}`);
  }
  console.log(`[async] ${steps.filter((s) => s.ok).length}/${steps.length} 步通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[async] 冒烟脚本自身异常：", e);
  process.exit(1);
});
