/**
 * M2-06 Electron 应用壳冒烟脚本（dev 模式全链路的自动化锚点）
 *
 * 与既有 smoke 同构，但验证对象是**应用壳形态**（KIKO_SHELL=1）：
 * prod 构建产物（tsc 主进程 + vite 渲染进程）+ 真实窗口加载。
 * dev 模式（vite dev server + HMR）留人工验证，本脚本覆盖同等链路。
 *
 * 验证链路（对照任务清单 M2-06 / 设计文档第 3 / 10 节）：
 *   步骤 1  壳启动：core 装配 + 窗口创建 + Vue 渲染进程加载
 *           （stdout：[kiko-shell] ready / renderer loaded）
 *   步骤 2  UI 数据通（IPC）：渲染进程经 preload 桥拉到真实数据
 *           （[kiko-renderer] ipc-ready: plugins=4 invocations=0）
 *   步骤 3  WS 通道并存（真实 Agent 路径）：settings.json token auth
 *           → discover（document.create 可见）→ invoke file.write completed
 *   步骤 4  事件推送全链：core 事件 → EventManager → webContents.send
 *           → Vue 订阅回调（[kiko-renderer] event: execution.started/completed）
 *
 * 用法：node scripts/smoke-shell.mjs；全过 exit 0。
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
// 基础工具（与 smoke-doc.mjs 同构）
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
    console.log(`[shell] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[shell] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// 壳进程管理（stdout 收集 + 模式等待）
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

/** spawn 应用壳；stdout 累积到行缓冲（waitForLog 的数据源），透传便于诊断 */
function startShell(env) {
  const electronExe = resolveElectronExe();
  const shell = spawn(electronExe, ["."], {
    cwd: desktopDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** 已累积 stdout（waitForLog 既要回看历史也要增量等待） */
  let buffer = "";
  const waiters = [];
  shell.stdout.on("data", (chunk) => {
    const text = String(chunk);
    buffer += text;
    process.stdout.write(`[shell-app] ${text}`);
    // 唤醒所有等待者（各自重测模式，命中自移除）
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
    /** stdout 累积缓冲（端口 / token 路径等内容提取用） */
    getBuffer: () => buffer,
    /** 等待 stdout 出现匹配模式（历史 + 增量）；超时抛错 */
    waitForLog(pattern, label, timeoutMs = 30000) {
      if (pattern.test(buffer)) return Promise.resolve();
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          pattern,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            rejectWait(new Error(`等待日志超时：${label}（30s 内未见匹配）`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

/** WS JSON-RPC 客户端（与 smoke-doc 同构；首帧 auth 支持真实装配） */
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

  send(payload) {
    this.ws.send(JSON.stringify(payload));
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
      this.send({ jsonrpc: "2.0", id, method, params });
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译（protocol → sdk → desktop 主进程 tsc + 渲染进程 vite） ---
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
  // 渲染进程产物（vite build → dist/renderer）
  await run(
    process.execPath,
    [join(desktopDir, "node_modules", "vite", "bin", "vite.js"), "build"],
    {
      cwd: desktopDir,
    },
  );
  console.log("[shell] 构建完成（protocol / sdk / desktop 主进程 + 渲染进程）");

  // --- 环境隔离（真实鉴权装配：token 走 settings.json，不设 KIKO_NO_AUTH） ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-shell-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const settingsPath = join(sandbox, "settings.json");
  const requestedPort = 38000 + Math.floor(Math.random() * 10000);
  const shellEnv = {
    KIKO_SHELL: "1",
    // 单实例锁逃生门（托盘常驻配套）：本脚本 killTree 强杀后重启第二
    // 实例，OS 级锁释放的微小延迟不该影响测试稳定性
    KIKO_NO_SINGLE_LOCK: "1",
    KIKO_WS_PORT: String(requestedPort),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: userDataDir,
    KIKO_SETTINGS_PATH: settingsPath,
    KIKO_DB_PATH: join(sandbox, "kiko.db"),
  };
  console.log(`[shell] 沙箱=${sandbox}`);

  const app = startShell(shellEnv);
  let port = 0;
  let token = "";

  await step("壳启动：core 装配 + 窗口创建 + Vue 渲染进程加载（prod 产物）", async () => {
    await app.waitForLog(/\[kiko-shell\] ready: workspace=/, "kiko-shell ready");
    await app.waitForLog(/renderer loaded: url=file:\/\//, "renderer loaded");
  });

  await step("UI 数据通：渲染进程经 IPC 桥拉到真实数据（plugins=4 / invocations=0）", async () => {
    await app.waitForLog(
      /\[kiko-renderer\] ipc-ready: plugins=4 invocations=0/,
      "renderer ipc-ready（插件卡片 + 调用历史空表）",
    );
  });

  await step(
    "WS 通道并存：settings.json 读取 token → auth → discover 可见 document.create",
    async () => {
      // 端口从日志解析（R3 探测可能偏移；ws 端点行随 ready 输出）
      await app.waitForLog(/ws:\/\/127\.0\.0\.1:\d+/, "ws 端点行");
      const portMatch = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(app.getBuffer());
      check(portMatch !== null, "应能从日志解析 WS 端口");
      port = Number(portMatch[1]);
      // 真实 Agent 路径：token 从 settings.json 读取（鉴权启用装配）
      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      check(typeof settings.access_token === "string", "settings.json 应含 access_token");
      token = settings.access_token;

      const client = new SmokeClient(`ws://127.0.0.1:${port}`);
      await client.opened();
      const authRes = await client.request("auth", { token });
      check(authRes.result?.authenticated === true, "auth 应成功", authRes);
      const discovered = await client.request("discover", {});
      const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
      check(ids.includes("document.create"), "discover 应含 document.create", ids);
      check(ids.includes("file.write"), "discover 应含 file.write", ids);
      client.close();
    },
  );

  await step("事件推送全链：WS invoke → core 事件 → IPC 单向推送 → Vue 订阅回调", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    check(
      (await client.request("auth", { token })).result?.authenticated === true,
      "auth 复连应成功",
    );

    const res = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "shell-smoke.txt", content: "M2-06 壳冒烟" },
    });
    check(res.result?.status === "completed", "file.write 应 completed", res.result);

    // 渲染进程订阅回调的 console 锚点（主进程 console-message 转发）
    await app.waitForLog(
      /\[kiko-renderer\] event: execution\.started/,
      "渲染进程收到 execution.started",
    );
    await app.waitForLog(
      /\[kiko-renderer\] event: execution\.completed/,
      "渲染进程收到 execution.completed",
    );
    client.close();
  });

  // --- 步骤 5：settings.json 工作空间位置读取（M2-06 任务内容验收锚点） ---
  await step("settings.json workspace_root：重启后工作空间切换到自定义位置", async () => {
    await killTree(app.shell.pid);
    // 读-改-写注入 workspace_root（保留 access_token——真实用户配置路径）
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const customRoot = join(sandbox, "custom-workspace");
    settings.workspace_root = customRoot;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

    // 重启壳（KIKO_WORKSPACE_ROOT 不设——env 覆写优先级高于 settings，
    // 必须走 settings.json 路径才是本步骤的验证目标）
    const restartEnv = { ...shellEnv };
    delete restartEnv.KIKO_WORKSPACE_ROOT;
    const app2 = startShell(restartEnv);
    try {
      await app2.waitForLog(
        new RegExp(`\\[kiko-shell\\] ready: workspace=${customRoot.replace(/\\/g, "\\\\")} `),
        "ready 行应报告自定义工作空间",
      );
    } finally {
      await killTree(app2.shell.pid);
    }
  });

  // --- 收尾：强杀 + 沙箱清理 ---
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  console.log("\n[shell] 结果汇总：");
  for (const s of steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  console.log(`[shell] ${steps.filter((s) => s.ok).length}/${steps.length} 步通过`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("[shell] 脚本异常：", e);
  process.exit(1);
});
