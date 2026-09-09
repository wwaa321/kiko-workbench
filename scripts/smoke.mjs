/**
 * M1 冒烟测试脚本（M1-12 验收锚点，设计文档 11 节 M1 验收清单）
 *
 * 全链路自动化：spawn headless Electron（环境隔离：临时目录承载
 * documentsDir / workspaceRoot / userData，不触碰用户真实 Documents——
 * 本机杀软对 Documents 新建文件的拦截会造成环境性 EPERM，见偏差表）。
 *
 * 验收门覆盖映射（清单见任务清单 M1 验收门）：
 *   门1 全链路 discover→describe→invoke(write,sync)→invoke(read)→get_execution → 步骤 1~5
 *   门2 非法 input 40002 + data.errors ajv 明细                          → 步骤 6
 *   门3 kill 插件进程 → 主进程存活 + 自动重启（50001 批处理单测锁定）     → 步骤 8
 *   门4 连续崩溃 3 次熔断 → error 态 + invoke 40005                      → 步骤 9
 *   门5 discover 响应无 schema 字段（R4）                                 → 步骤 1
 *   门6 越界拒绝 50001（write/read/list 三向）                            → 步骤 7
 *   门7 vitest 全绿                                                       → 不在本脚本（pnpm -r run test）
 *   P-003 headless 惰性化：dev.uitest → failed + 40010 含指引              → 门4 后步骤
 *
 * 插件 host 进程识别：Electron utilityProcess 命令行特征
 * `--utility-sub-type=node.mojom.NodeService`（GPU 是 gpu-process、
 * 网络服务是 network.mojom.NetworkService，实测区分）。
 *
 * 用法：node scripts/smoke.mjs（或 pnpm run smoke）；全过 exit 0。
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
// 基础工具
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
    console.log(`[smoke] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[smoke] FAIL ${name}\n         ${String(e?.message ?? e)}`);
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
// headless 进程管理（spawn / 就绪等待 / 树杀）
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

/**
 * 查找插件 host 子进程（utilityProcess 特征：node.mojom.NodeService）。
 * 返回 pid 数组（通常 0 或 1 个：file 插件懒启动单进程）。
 */
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

/**
 * 轮询等待插件 host 子进程出现 / 消失（重启观测 / 熔断确认）。
 * expectPresent=true：出现即返回 true，超时返回 false。
 */
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
// WS JSON-RPC 客户端（按 id 配对）
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

  /** 连接建立 */
  opened() {
    return new Promise((resolveOpen, rejectOpen) => {
      this.ws.once("open", resolveOpen);
      this.ws.once("error", rejectOpen);
    });
  }

  /** 发请求并等响应（timeoutMs 内无响应按失败处理） */
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译 desktop（确保 headless dist 与源码一致，防旧产物误导） ---
  // tsc 以 node 直跑其 js 入口（Windows 下 spawn .CMD 会 EINVAL）
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[smoke] desktop 构建完成");

  // --- 环境隔离：临时目录承载全部可写路径 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-smoke-"));
  // 复刻真实布局：workspace 位于 documents 内（file.read 沙箱基座是
  // documentsDir，读工作空间产物走 "workspace/..." 相对路径）
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  // 端口取随机高位（冲突概率≈0；真被占 headless 还有 R3 +1 探测兜底，
  // 但覆写指定端口时以实际端口为准——从启动日志解析）
  const requestedPort = 24000 + Math.floor(Math.random() * 10000);

  // --- spawn headless（stdout 透传便于诊断） ---
  const electronExe = resolveElectronExe();
  const headless = spawn(electronExe, ["."], {
    cwd: desktopDir,
    env: {
      ...process.env,
      KIKO_WS_PORT: String(requestedPort),
      KIKO_DOCUMENTS_DIR: documentsDir,
      KIKO_WORKSPACE_ROOT: workspaceRoot,
      KIKO_USER_DATA_DIR: userDataDir,
      // M2-02 引入 WS 鉴权后 M1 冒烟的兼容开关（bootstrap.ts
      // resolveAuthToken 预留：KIKO_NO_AUTH=1 → 无鉴权模式，本脚本
      // 直连即请求）。真实鉴权路径（settings.json token → 首条 auth
      // 消息）由 smoke-plugins.mjs 端到端验证，此处不重复覆盖。
      KIKO_NO_AUTH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  headless.stdout.on("data", (chunk) => process.stdout.write(`[headless] ${chunk}`));
  headless.stderr.on("data", (chunk) => process.stderr.write(`[headless-err] ${chunk}`));
  const mainPid = headless.pid;
  console.log(`[smoke] headless 已启动：pid=${mainPid} 请求端口=${requestedPort} 沙箱=${sandbox}`);

  /** 从启动日志解析实际 WS 端口（R3 探测可能 +1 偏移） */
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
    // 启动崩溃兜底：进程早退直接失败
    headless.once("exit", (code) => {
      if (code !== null) resolvePort(-1);
    });
  });
  check(actualPort > 0, "headless 启动失败（未见 WS 端点日志）");
  const url = `ws://127.0.0.1:${actualPort}`;
  await waitServerReady(url);
  const client = new SmokeClient(url);
  await client.opened();
  console.log(`[smoke] WS 已连接：${url}`);

  const WRITE_PATH = "smoke/hello.txt";
  const WRITE_CONTENT = "kiko smoke 你好世界";

  // --- 门1 / 门5：discover → R4 契约 ---
  let writeResult = null;
  await step("门1/5 discover：file 三能力在列 + R4 无 schema 字段", async () => {
    const res = await client.request("discover", {});
    check(res.error === undefined, "discover 不应报错", res.error);
    const capabilities = res.result.capabilities.map((c) => c.id).sort();
    // M1 时期内置插件仅 file，断言曾为精确匹配；M2-10a 起内置插件扩展为
    // file/document/dev/sdk，门1 语义是"file 三能力在列"（全链路可用性
    // 前提），改为包含式断言——后续新增内置插件无需再改本脚本
    for (const id of ["file.list", "file.read", "file.write"]) {
      check(capabilities.includes(id), `discover 应包含 ${id}`, capabilities);
    }
    // R4：契约双保险（键集 + 序列化无 schema 字样）
    check(!JSON.stringify(res.result).includes("schema"), "discover 响应含 schema 字段（R4 违约）");
  });

  // --- 门1：describe ---
  await step(
    "门1 describe(file.write)：input_schema 完整（required 含 path/content）",
    async () => {
      const res = await client.request("describe", { capability_id: "file.write" });
      check(res.error === undefined, "describe 不应报错", res.error);
      const required = res.result.input_schema?.required ?? [];
      check(
        required.includes("path") && required.includes("content"),
        "required 应含 path/content",
        required,
      );
    },
  );

  // --- 门1：invoke(file.write, sync) ---
  await step("门1 invoke(file.write, sync)：completed + size 一致", async () => {
    const res = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: WRITE_PATH, content: WRITE_CONTENT },
      mode: "sync",
    });
    check(res.error === undefined, "invoke 不应报 JSON-RPC error", res.error);
    check(res.result.status === "completed", "write 应 completed", res.result);
    check(
      res.result.result?.path === WRITE_PATH,
      "返回 path 应为正斜杠相对路径",
      res.result.result,
    );
    check(
      res.result.result?.size === Buffer.byteLength(WRITE_CONTENT, "utf-8"),
      "size 应为内容字节数",
      res.result.result,
    );
    writeResult = res.result;
    // 落盘核对（主进程侧直接读文件）
    const onDisk = await readFile(join(workspaceRoot, WRITE_PATH), "utf-8");
    check(onDisk === WRITE_CONTENT, "落盘内容应与写入一致", onDisk);
  });

  // --- 门1：invoke(file.read) ---
  await step("门1 invoke(file.read)：读回内容一致（工作空间经文档目录基座访问）", async () => {
    const res = await client.request("invoke", {
      capability_id: "file.read",
      input: { path: `workspace/${WRITE_PATH}` },
      mode: "sync",
    });
    check(res.error === undefined, "read 不应报 JSON-RPC error", res.error);
    check(res.result.status === "completed", "read 应 completed", res.result);
    check(res.result.result?.content === WRITE_CONTENT, "读回内容应一致", res.result.result);
  });

  // --- 门1：get_execution ---
  await step("门1 get_execution：completed + 事件时间线完整", async () => {
    const res = await client.request("get_execution", {
      invocation_id: writeResult.invocation_id,
      include_events: true,
    });
    check(res.error === undefined, "get_execution 不应报错", res.error);
    check(res.result.status === "completed", "终态应为 completed", res.result.status);
    const timeline = (res.result.events ?? []).map((e) => e.event);
    check(
      JSON.stringify(timeline) ===
        JSON.stringify(["invocation.created", "execution.started", "execution.completed"]),
      "事件时间线应为 created → started → completed",
      timeline,
    );
  });

  // --- 门2：40002 + data.errors ajv 明细 ---
  await step("门2 非法 input：40002 + data.errors 含 ajv 明细", async () => {
    const res = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "x.txt" }, // 缺 content
      mode: "sync",
    });
    check(res.error?.code === 40002, "应返回 40002", res.error);
    const errors = res.error?.data?.errors;
    check(Array.isArray(errors) && errors.length > 0, "data.errors 应为非空数组", res.error?.data);
    check(
      errors.some((e) => e.keyword === "required" && String(e.message).includes("content")),
      "ajv 明细应指出缺 content",
      errors,
    );
  });

  // --- 门6：越界三向全拒（50001） ---
  await step(
    "门6 越界拒绝：write 逃逸工作空间 / read 逃逸文档目录 / list 逃逸文档目录（均 50001）",
    async () => {
      const escapes = [
        { capability_id: "file.write", input: { path: "../../escape.txt", content: "x" } },
        { capability_id: "file.read", input: { path: "../../../Windows/win.ini" } },
        { capability_id: "file.list", input: { path: "../.." } },
      ];
      for (const { capability_id, input } of escapes) {
        const res = await client.request("invoke", { capability_id, input, mode: "sync" });
        check(res.error === undefined, `${capability_id} 越界是执行失败而非协议错误`, res.error);
        check(res.result?.error?.code === 50001, `${capability_id} 越界应 50001`, res.result);
      }
    },
  );

  // --- 门3：kill 插件进程 → 主进程存活 + 自动重启 ---
  await step("门3 kill 插件进程：主进程存活 + 退避自动重启 + 重启后执行恢复", async () => {
    // 前面步骤已触发懒启动，进程应在（空闲 5min 内不回收）
    check(await waitForPluginHost(mainPid, true, { timeoutMs: 5000 }), "插件 host 进程应在运行");
    const [hostPid] = await findPluginHostPids(mainPid);
    await killPid(hostPid);
    // 退避 1s + 重启加载 → invoke 顺延等待后成功（成功执行重置崩溃计数）
    const res = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "smoke/after-crash.txt", content: "recovered" },
      mode: "sync",
    });
    check(res.result?.status === "completed", "崩溃重启后 invoke 应恢复成功", res.result);
    check(await waitForPluginHost(mainPid, true, { timeoutMs: 5000 }), "重启后的插件进程应在运行");
    // 主进程存活：本条 request 本身经主进程 WS 完成，即为存活证明
  });
  // 注（验收门备注）："对应 invocation 标记 failed(50001)"的执行中崩溃路径
  // 由 runtime.test.ts 单测锁定（FakeProcess 执行中 exit → 批量 failed 50001）；
  // 真实进程执行窗口毫秒级、外部 kill 无法稳定命中，留人工复测。

  // --- 门4：连续崩溃 3 次熔断 ---
  await step("门4 连续崩溃 3 次：插件 error 态 + invoke 40005", async () => {
    // 上一步成功执行已重置计数（crashCount=0，进程活着）。连杀 3 次：
    // kill#1 → count=1 → 退避 1s 重启；kill#2 → count=2 → 退避 2s 重启；
    // kill#3 → count=3 → 熔断（error 态，不再重启）
    for (let round = 1; round <= 3; round++) {
      const present = await waitForPluginHost(mainPid, true, { timeoutMs: 20000 });
      check(present, `第 ${round} 次崩溃前插件进程应在运行`);
      const [hostPid] = await findPluginHostPids(mainPid);
      await killPid(hostPid);
    }
    // 熔断后不再重启：4s 内无新进程（第三次退避若存在会是 4s，但熔断路径
    // 直接 return 不安排重启——观察 5s 覆盖边界）
    check(await waitForPluginHost(mainPid, false, { timeoutMs: 5000 }), "熔断后插件进程不应重启");
    const res = await client.request("invoke", {
      capability_id: "file.write",
      input: { path: "should-not-run.txt", content: "x" },
      mode: "sync",
    });
    check(res.error?.code === 40005, "熔断后 invoke 应返回 40005", res.error);
  });

  // --- P-003：headless 惰性化（微应用能力在无窗口宿主下的结构化降级） ---
  await step("P-003 headless 惰性化：dev.uitest → failed + 40010 + 含「打开界面」指引", async () => {
    // headless 无窗口管理器装配（runtime uiRelay 默认 stub）——微应用推送
    // 能力应返回结构化错误而非挂死/崩溃（Agent 读到即可转达用户，P-003
    // 验收标准"能力返回结构化错误"的 headless 侧锚点）
    const res = await client.request("invoke", {
      capability_id: "dev.uitest",
      input: { message: "headless 惰性化验证" },
      mode: "sync",
    });
    check(res.error === undefined, "invoke 不应报 JSON-RPC error（插件级错误走 result.error）", res.error);
    check(res.result?.status === "failed", "无表面的 uitest 应 failed", res.result);
    check(
      res.result?.error?.code === 40010,
      "错误码应为 40010（PLUGIN_UI_NOT_OPEN 透传）",
      res.result?.error,
    );
    check(
      typeof res.result?.error?.message === "string" &&
        res.result.error.message.includes("打开界面"),
      "错误信息应含操作指引（Agent 转达闭环）",
      res.result?.error,
    );
  });

  // --- 主进程存活终验（崩溃风暴后 WS 仍可用） ---
  await step("终验：崩溃风暴后主进程 WS 仍可用（discover 正常）", async () => {
    const res = await client.request("discover", {});
    check(res.error === undefined, "discover 应正常", res.error);
  });

  // --- 收尾：断开 + 杀进程树 + 清理沙箱 ---
  client.close();
  await run("taskkill", ["/T", "/F", "/PID", String(mainPid)]).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[smoke] ====== 汇总 ======");
  for (const s of steps) console.log(`[smoke] ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  const passed = steps.filter((s) => s.ok).length;
  console.log(`[smoke] ${passed}/${steps.length} 步骤通过`);
  process.exit(failed ? 1 : 0);
}

// 整体兜底超时：任何环节挂死都在 3 分钟内强退（防 CI 悬挂）
setTimeout(() => {
  console.error("[smoke] 整体超时（180s），强制失败退出");
  process.exit(1);
}, 180_000).unref();

main().catch((e) => {
  console.error("[smoke] 致命错误：", e);
  process.exit(1);
});
