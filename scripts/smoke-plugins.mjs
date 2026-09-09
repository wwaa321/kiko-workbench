/**
 * M2-07 插件启停 UI 冒烟脚本（autopilot 端到端验收）
 *
 * 验证对象：插件卡片启停开关 + error 态崩溃原因展示与"重新启用"
 * （任务清单 M2-07 / 设计文档第 10 节）。
 *
 * 自动化策略：渲染进程 autopilot 模式（KIKO_AUTOPILOT=m2-07 → URL
 * query → Vue 自动驱动与用户点击**同款** setPluginEnabled 处理函数），
 * 主进程 console-message 转发锚点到 stdout，本脚本断言。
 *
 * 验证链路：
 *   步骤 1  壳启动 + autopilot 启停即时生效
 *           （锚点 toggle-off: file=disabled → 3s 停用窗口 → toggle-on）
 *   步骤 2  停用窗口外部佐证（Agent 视角）：discover 不含 file.* +
 *           invoke file.write 被拒 40001（启停即刻生效）
 *   步骤 3  启用恢复 + host 懒启动：invoke file.write completed
 *   步骤 4  连杀 host 进程 3 次 → 熔断 error → autopilot 轮询发现
 *           （含崩溃原因）→"重新启用"→ 锚点 re-enabled
 *   步骤 5  重新启用后可 invoke：discover 恢复 + file.write completed
 *           （清崩溃计数 + 懒启动新进程全链路）
 *   步骤 6  P-002 无配置根：dev.greeting 注册 + 未配置 invoke →
 *           50001 含设置面板指引（ctx.config 注入 {} 全链路）
 *   步骤 7  P-002 配置损坏容错：坏 JSON → host 重启后空配置注入 +
 *           警告日志 + 调用不阻断（仍走未配置指引路径）
 *
 * 用法：node scripts/smoke-plugins.mjs；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// 基础工具（与 smoke-shell.mjs 同构）
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
    console.log(`[plugins] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[plugins] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// 壳进程管理（stdout 行缓冲 + 模式等待；与 smoke-shell.mjs 同构）
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
  shell.stderr.on("data", (chunk) => {
    const text = String(chunk);
    // stderr 并入匹配 buffer：console.warn 类日志（如 P-002 配置损坏警告）
    // 走 stderr，锚点匹配需要覆盖双流
    buffer += text;
    process.stderr.write(`[shell-app-err] ${text}`);
    for (const w of [...waiters]) {
      if (w.pattern.test(buffer)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  });
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

// ---------------------------------------------------------------------------
// 插件 host 进程操作（与 smoke.mjs 同构：utilityProcess 命令行特征识别）
// ---------------------------------------------------------------------------

/** 查找插件 host 子进程（懒启动：脚本只 invoke file 能力 → 只有 file 的 host） */
async function findPluginHostPids(mainPid) {
  const stdout = await run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | ` +
      `Where-Object { $_.CommandLine -like '*node.mojom.NodeService*' } | ` +
      `Select-Object -ExpandProperty ProcessId`,
  ]).catch(() => "");
  return stdout
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => Number(token))
    .filter((pid) => Number.isInteger(pid));
}

/** 强杀单个进程（外部 kill = 非主动退出 → runtime 计为崩溃） */
function killPid(pid) {
  return run("taskkill", ["/F", "/PID", String(pid)]);
}

/** 轮询等待插件 host 子进程出现 / 消失（重启观测 / 熔断确认） */
async function waitForPluginHost(
  mainPid,
  expectPresent,
  { timeoutMs = 20000, intervalMs = 300 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await findPluginHostPids(mainPid);
    if (expectPresent && pids.length > 0) return true;
    if (!expectPresent && pids.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// WS JSON-RPC 客户端（与 smoke-shell.mjs 同构）
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

async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  await delay(1500);
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
  // --- 前置：编译（渲染进程含 M2-07 改动；主进程含 autopilot 注入） ---
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
  console.log("[plugins] 构建完成（protocol / sdk / desktop 主进程 + 渲染进程）");

  // --- 环境隔离 + autopilot 注入 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-plugins-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const shellEnv = {
    KIKO_SHELL: "1",
    KIKO_AUTOPILOT: "m2-07",
    KIKO_WS_PORT: String(39000 + Math.floor(Math.random() * 2000)),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: join(sandbox, "user-data"),
    KIKO_SETTINGS_PATH: join(sandbox, "settings.json"),
    KIKO_DB_PATH: join(sandbox, "kiko.db"),
  };
  console.log(`[plugins] 沙箱=${sandbox}`);

  const app = startShell(shellEnv);
  const mainPid = app.shell.pid;

  // --- 步骤 1：壳启动 + autopilot 阶段 1（启停即时生效） ---
  await step("壳启动 + autopilot 启停即时生效（toggle-off → toggle-on）", async () => {
    await app.waitForLog(/\[kiko-shell\] ready: workspace=/, "kiko-shell ready");
    await app.waitForLog(/renderer loaded: url=file:\/\//, "renderer loaded");
    await app.waitForLog(
      /\[kiko-renderer\] autopilot m2-07 toggle-off: file=disabled/,
      "toggle-off 锚点",
    );
  });

  // --- WS 连接（步骤 2 起共用；token 走 settings.json 真实装配） ---
  const endpoint = await resolveEndpoint(app, sandbox);
  const client = new SmokeClient(`ws://127.0.0.1:${endpoint.port}`);
  await client.opened();
  const authRes = await client.request("auth", { token: endpoint.token });
  check(authRes.result?.authenticated === true, "auth 应成功", authRes);

  // --- 步骤 2：停用窗口外部佐证（3s 窗口内完成两个请求） ---
  await step("停用即刻生效（Agent 视角）：discover 不含 file.* + invoke 40001", async () => {
    const discovered = await client.request("discover", {});
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(!ids.some((id) => id.startsWith("file.")), "停用期间 discover 不应含 file.*", ids);
    const invoked = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "blocked.txt", content: "should be rejected" },
      mode: "sync",
    });
    check(invoked.error?.code === 40001, "停用期间 invoke 应被拒 40001", invoked.error);
  });

  // --- 步骤 3：启用恢复 + host 懒启动（invoke 驱动进程启动） ---
  await step("启用恢复：toggle-on 锚点 + invoke file.write completed（host 启动）", async () => {
    await app.waitForLog(
      /\[kiko-renderer\] autopilot m2-07 toggle-on: file=enabled/,
      "toggle-on 锚点",
    );
    const invoked = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "plugins-smoke/baseline.txt", content: "m2-07 baseline" },
      mode: "sync",
    });
    check(invoked.result?.status === "completed", "启用后 invoke 应 completed", invoked);
    const hostUp = await waitForPluginHost(mainPid, true, { timeoutMs: 15000 });
    check(hostUp, "invoke 后 host 进程应存在（懒启动）");
  });

  // --- 步骤 4：连杀 3 次熔断 → autopilot 发现 error（含崩溃原因）→ 重新启用 ---
  await step("连杀 3 次熔断 error → UI 重新启用（锚点 re-enabled + reason_seen）", async () => {
    for (let i = 1; i <= 3; i++) {
      const pids = await findPluginHostPids(mainPid);
      check(pids.length > 0, `第 ${i} 次杀前 host 进程应存在`);
      await killPid(pids[0]);
      if (i < 3) {
        // 退避重启（1s → 2s）后进程回归，再杀下一次（连续 3 次崩溃 → 熔断）
        const back = await waitForPluginHost(mainPid, true, { timeoutMs: 20000 });
        check(back, `第 ${i} 次杀后应退避重启（连续计数前提）`);
      }
    }
    const gone = await waitForPluginHost(mainPid, false, { timeoutMs: 8000 });
    check(gone, "熔断后 host 进程应不再重启");
    // autopilot 轮询（500ms）发现 error → 断言崩溃原因 → 重新启用
    await app.waitForLog(
      /\[kiko-renderer\] autopilot m2-07 re-enabled: file=enabled reason_seen=true/,
      "re-enabled 锚点",
      30000,
    );
  });

  // --- 步骤 5：重新启用后可 invoke（清崩溃计数 + 懒启动新进程全链路） ---
  await step("重新启用后可 invoke：discover 恢复 + file.write completed", async () => {
    const discovered = await client.request("discover", {});
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(ids.includes("file.write"), "重新启用后 discover 应恢复 file.write", ids);
    const invoked = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "plugins-smoke/recovered.txt", content: "m2-07 re-enabled" },
      mode: "sync",
    });
    check(invoked.result?.status === "completed", "重新启用后 invoke 应 completed", invoked);
    check(
      invoked.result?.result?.path === "plugins-smoke/recovered.txt",
      "重新启用后产物路径应正确",
      invoked.result,
    );
  });

  // --- 步骤 6（P-002）：无配置根环境 → 声明配置的插件正常注册 + 未配置运行时反馈 ---
  await step("P-002 无配置根：dev.greeting 注册 + 未配置 invoke → 50001 含设置指引", async () => {
    // 沙箱 userData 下 plugin-config 根不存在——注册与调用链路不应受影响
    const discovered = await client.request("discover", {});
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(
      ids.includes("dev.greeting"),
      "声明配置的插件能力应在列（contributes.configuration 注册期校验通过）",
      ids,
    );
    // 未配置 api_token → 插件 handle 抛含设置面板指引的结构化错误（Agent 转达闭环）
    const invoked = await client.request("invoke", {
      capability_id: "dev.greeting",
      input: {},
      mode: "sync",
    });
    check(invoked.result?.status === "failed", "未配置关键配置应 failed", invoked.result);
    check(
      invoked.result?.error?.code === 50001 &&
        typeof invoked.result.error.message === "string" &&
        invoked.result.error.message.includes("设置"),
      "错误应为 50001 且信息含设置面板指引",
      invoked.result?.error,
    );
  });

  // --- 步骤 7（P-002）：配置文件损坏 → 损坏容错（空配置注入 + 不阻断加载） ---
  await step("P-002 配置损坏：坏 JSON → 插件仍可加载（空配置 + 警告日志 + 指引错误）", async () => {
    // 直写损坏配置文件（模拟磁盘半写 / 手工编辑出错）
    const configRoot = join(sandbox, "user-data", "plugin-config");
    await mkdir(configRoot, { recursive: true });
    await writeFile(join(configRoot, "dev.json"), "{broken json", "utf-8");
    // 杀 host 进程强制下次 load 重读配置（单次崩溃退避重启，不触发熔断）
    const pids = await findPluginHostPids(mainPid);
    check(pids.length > 0, "杀前 host 进程应存在（步骤 5/6 已懒启动）", pids);
    for (const pid of pids) await killPid(pid).catch(() => undefined);
    const back = await waitForPluginHost(mainPid, true, { timeoutMs: 20000 });
    check(back, "杀后 host 进程应退避重启（不熔断）");
    // 重启后的 load 读到损坏配置 → 注入 {} + 警告日志；调用仍走未配置指引路径
    const invoked = await client.request("invoke", {
      capability_id: "dev.greeting",
      input: {},
      mode: "sync",
    });
    check(
      invoked.result?.status === "failed" && invoked.result?.error?.message?.includes("设置"),
      "损坏容错后 invoke 应仍走未配置指引（不崩溃不阻断）",
      invoked.result?.error,
    );
    await app.waitForLog(/配置文件损坏，按空配置处理/, "损坏警告日志", 15000);
  });

  // --- 收尾 ---
  client.close();
  await killTree(mainPid);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  console.log("\n[plugins] ====== 汇总 ======");
  for (const s of steps) console.log(`[plugins] ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  const passed = steps.filter((s) => s.ok).length;
  console.log(`[plugins] ${passed}/${steps.length} 步骤通过`);
  process.exit(failed ? 1 : 0);
}

// 整体兜底超时（构建 + 退避熔断全链路 < 3 分钟）
setTimeout(() => {
  console.error("[plugins] 整体超时（180s），强制失败退出");
  process.exit(1);
}, 180_000).unref();

main().catch((e) => {
  console.error("[plugins] 致命错误：", e);
  process.exit(1);
});
