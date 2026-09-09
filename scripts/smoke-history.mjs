/**
 * M2-08 调用历史 + Trace + 产物冒烟脚本（autopilot 端到端验收）
 *
 * 验证对象：调用历史分页/筛选（数据量控制）+ Execution Trace 展开 +
 * "打开所在文件夹"（任务清单 M2-08 / 设计文档第 10 节）。
 *
 * 自动化策略：渲染进程 autopilot 模式（KIKO_AUTOPILOT=m2-08 → URL
 * query → Vue 自动驱动与用户操作**同款** fetchHistory / applyFilters /
 * selectInvocation / openArtifact 处理函数），主进程 console-message
 * 转发锚点到 stdout，本脚本断言。
 *
 * 验证链路：
 *   步骤 1  WS 数据制造：file.read 越界 failed ×1 + file.write ×2 +
 *           file.list ×1（全新 SQLite 库，autopilot 阶段 1 等待恰好 4 条
 *           → 锚点 history-loaded）
 *   步骤 2  failed 记录 UI 可查：history-status（状态筛选 → 1 条
 *           file.read）+ trace-error（Error Trace 展示）——崩溃/恢复标记
 *           failed 的记录经同款 invocation:list 路径呈现（UI 只读 SQLite）
 *   步骤 3  分页/筛选锚点：history-filter（能力子串 file.wri → 2 条）+
 *           history-paged（limit=1 → has_more 探测）
 *   步骤 4  Trace 展开：trace-open（事件时间线 ≥3 + result + 产物=1）
 *           + 产物落盘外部佐证（磁盘文件内容比对）
 *   步骤 5  产物定位：artifact-rejected（越界路径白名单拒绝）+
 *           artifact-shown（真实 shell.showItemInFolder）
 *
 * 用法：node scripts/smoke-history.mjs；全过 exit 0。
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
// 基础工具（与 smoke-plugins.mjs 同构）
// ---------------------------------------------------------------------------

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const desktopDir = join(repoRoot, "apps", "desktop");

const steps = [];
let failed = false;

async function step(name, fn) {
  try {
    await fn();
    steps.push({ name, ok: true });
    console.log(`[history] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[history] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// 壳进程管理（stdout 行缓冲 + 模式等待；与 smoke-plugins.mjs 同构）
// ---------------------------------------------------------------------------

function resolveElectronExe() {
  const requireFromDesktop = createRequire(join(desktopDir, "package.json"));
  const electronPath = requireFromDesktop("electron");
  check(
    typeof electronPath === "string" && electronPath.length > 0,
    "无法解析 electron 可执行路径",
  );
  return electronPath;
}

function startShell(env) {
  const electronExe = resolveElectronExe();
  const shell = spawn(electronExe, ["."], {
    cwd: desktopDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = [];
  shell.stdout.on("data", (chunk) => {
    const text = String(chunk);
    buffer += text;
    process.stdout.write(`[shell-app] ${text}`);
    for (const w of [...waiters]) {
      if (w.pattern.test(buffer)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  });
  shell.stderr.on("data", (chunk) => process.stderr.write(`[shell-app-err] ${chunk}`));
  return {
    shell,
    getBuffer: () => buffer,
    waitForLog(pattern, label, timeoutMs = 30000) {
      if (pattern.test(buffer)) return Promise.resolve();
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          pattern,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            rejectWait(new Error(`等待日志超时：${label}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  await delay(1500);
}

// ---------------------------------------------------------------------------
// WS JSON-RPC 客户端（与 smoke-plugins.mjs 同构）
// ---------------------------------------------------------------------------

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

/** 从日志解析 WS 端口 + settings.json 读取 token（真实鉴权装配路径） */
async function resolveEndpoint(app, sandbox) {
  await app.waitForLog(/ws:\/\/127\.0\.0\.1:\d+/, "ws 端点行");
  const portMatch = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(app.getBuffer());
  check(portMatch !== null, "应能从日志解析 WS 端口");
  const settings = JSON.parse(await readFile(join(sandbox, "settings.json"), "utf-8"));
  check(typeof settings.access_token === "string", "settings.json 应含 access_token");
  return { port: Number(portMatch[1]), token: settings.access_token };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译（渲染进程含 M2-08 改动；主进程含 query IPC + 白名单） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [
    tscEntry,
    "-p",
    join(repoRoot, "packages/protocol", "tsconfig.json"),
  ]);
  await run(process.execPath, [
    tscEntry,
    "-p",
    join(repoRoot, "packages/plugin-sdk", "tsconfig.json"),
  ]);
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  await run(
    process.execPath,
    [join(desktopDir, "node_modules", "vite", "bin", "vite.js"), "build"],
    {
      cwd: desktopDir,
    },
  );
  console.log("[history] 构建完成（protocol / sdk / desktop 主进程 + 渲染进程）");

  // --- 环境隔离 + autopilot 注入（全新 SQLite 库：恰好 3 条记录可断言） ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-history-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const shellEnv = {
    KIKO_SHELL: "1",
    KIKO_AUTOPILOT: "m2-08",
    KIKO_WS_PORT: String(41000 + Math.floor(Math.random() * 2000)),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: join(sandbox, "user-data"),
    KIKO_SETTINGS_PATH: join(sandbox, "settings.json"),
    KIKO_DB_PATH: join(sandbox, "kiko.db"),
  };
  console.log(`[history] 沙箱=${sandbox}`);

  const app = startShell(shellEnv);
  const mainPid = app.shell.pid;

  // --- 步骤 1：壳启动 + WS 数据制造（恰好 4 条：1 failed + 3 completed）---
  await step(
    "WS 数据制造：file.read 越界 failed ×1 + file.write ×2 + file.list ×1（→ history-loaded）",
    async () => {
      await app.waitForLog(/\[kiko-shell\] ready: workspace=/, "kiko-shell ready");
      await app.waitForLog(/renderer loaded: url=file:\/\//, "renderer loaded");

      const endpoint = await resolveEndpoint(app, sandbox);
      const client = new SmokeClient(`ws://127.0.0.1:${endpoint.port}`);
      await client.opened();
      const authRes = await client.request("auth", { token: endpoint.token });
      check(authRes.result?.authenticated === true, "auth 应成功", authRes);

      // 恰好 4 次调用（autopilot 阶段 1 断言总数 = 4；多一次即失败）：
      // 1 条 failed（file.read 越界 50001——失败记录 UI 可查的验证载体，
      // 与崩溃/恢复标记 failed 的记录同构：UI 只读 SQLite 经 invocation:list）
      //   + 2 条 completed file.write + 1 条 completed file.list
      const badRead = await client.request("invoke", {
        capability_id: "file.read",
        input: { path: "C:\\Windows\\win.ini" },
        mode: "sync",
      });
      check(badRead.result?.status === "failed", "file.read 越界应 failed", badRead);
      check(badRead.result?.error?.code === 50001, "越界错误码应 50001", badRead);
      const write1 = await client.request("invoke", {
        capability_id: "file.write",
        input: { path: "history/a.txt", content: "history-a" },
        mode: "sync",
      });
      check(write1.result?.status === "completed", "file.write(a) 应 completed", write1);
      const write2 = await client.request("invoke", {
        capability_id: "file.write",
        input: { path: "history/b.txt", content: "history-b" },
        mode: "sync",
      });
      check(write2.result?.status === "completed", "file.write(b) 应 completed", write2);
      const list = await client.request("invoke", {
        capability_id: "file.list",
        input: {},
        mode: "sync",
      });
      check(list.result?.status === "completed", "file.list 应 completed", list);
      client.close();

      // autopilot 阶段 1 锚点（60s 轮询窗口内完成）
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 history-loaded: total=4/,
        "history-loaded 锚点",
        60000,
      );
    },
  );

  // --- 步骤 2：failed 记录 UI 可查（状态筛选 + Error Trace）---
  await step(
    "failed 记录 UI 可查：history-status（状态筛选 1 条）+ trace-error（Error Trace）",
    async () => {
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 history-status: matched=1 capability=file\.read/,
        "history-status 锚点",
      );
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 trace-error: code=50001/,
        "trace-error 锚点",
      );
    },
  );

  // --- 步骤 3：筛选 + 分页锚点（存储层 SQL 下推链路）---
  await step(
    "筛选 + 分页锚点：history-filter（file.wri → 2 条）+ history-paged（limit=1 has_more）",
    async () => {
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 history-filter: capability=file\.wri matched=2/,
        "history-filter 锚点",
      );
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 history-paged: matched=1 has_more=true/,
        "history-paged 锚点",
      );
    },
  );

  // --- 步骤 4：Trace 展开 + 产物落盘外部佐证 ---
  await step("Trace 展开锚点 + 产物落盘佐证（事件时间线 ≥3 + result + 产物磁盘可读）", async () => {
    await app.waitForLog(
      /\[kiko-renderer\] autopilot m2-08 trace-open: events=\d+ logs=\d+ result=present artifacts=1/,
      "trace-open 锚点",
    );
    // 外部佐证：两次 file.write 产物真实落盘且内容一致
    const a = await readFile(join(workspaceRoot, "history", "a.txt"), "utf-8");
    check(a === "history-a", "产物 a.txt 内容应一致", a);
    const b = await readFile(join(workspaceRoot, "history", "b.txt"), "utf-8");
    check(b === "history-b", "产物 b.txt 内容应一致", b);
  });

  // --- 步骤 5：产物定位（白名单负向 + 真实打开正向）---
  await step(
    "产物定位锚点：artifact-rejected（越界拒绝）+ artifact-shown（资源管理器定位）",
    async () => {
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 artifact-rejected: out_of_workspace=true/,
        "artifact-rejected 锚点",
      );
      await app.waitForLog(
        /\[kiko-renderer\] autopilot m2-08 artifact-shown: ok file=/,
        "artifact-shown 锚点",
      );
    },
  );

  // --- 收尾 ---
  await killTree(mainPid);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  console.log("");
  const passCount = steps.filter((s) => s.ok).length;
  console.log(`[history] 结果：${passCount}/${steps.length} 步通过`);
  if (failed) {
    console.error("[history] 存在失败步骤，见上方 FAIL 行");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[history] 脚本异常退出：", e);
  process.exit(1);
});
