/**
 * 零 Shell 自举闭环冒烟脚本（S12 验收锚点，《Kiko 插件零 Shell 自举
 * 闭环方案.md》4 节）
 *
 * 模拟**无终端 Agent**：全程仅 WS JSON-RPC 调用（零终端、零 npm、零
 * 重启）完成插件开发自举——验证 S8-S11 打通的分发链：
 *
 *   ①  install_guide(agent 缺省)：五步 + rescan_required（v2 双轨）
 *       + human 轨回归（8 步 + restart_required 不受影响）
 *   ②  file.write 五件套：manifest / capabilities / package.json /
 *       tsconfig / src/index.ts（模拟 Agent 写源码，import SDK）
 *   ③  sdk.build：utilityProcess 内 spawn esbuild CLI（alias 表内联
 *       vendor 物料），产物自包含
 *   ④  sdk.deploy：三件套复制到 user_plugins_root/<id>（零 shell）
 *   ⑤  plugins.rescan：added 含新插件（不重启工作台）
 *   ⑥  discover 可见新能力 → describe → invoke 成功（懒启动新进程）
 *   ⑦  二次 rescan：skipped（已注册不重载——首版诚实语义）
 *
 * 环境隔离与 smoke.mjs 同构：headless Electron + 临时目录沙箱 +
 * KIKO_NO_AUTH=1（真实鉴权路径由 smoke-plugins.mjs 覆盖，此处不重复）。
 *
 * 用法：node scripts/smoke-bootstrap.mjs（或 pnpm run smoke:bootstrap）；
 * 全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
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
    console.log(`[bootstrap] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[bootstrap] FAIL ${name}\n             ${String(e?.message ?? e)}`);
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

// ---------------------------------------------------------------------------
// WS JSON-RPC 客户端（与 smoke.mjs 同构：按 id 配对）
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

  /** 发请求并等响应 */
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
// 模拟 Agent 生成的插件五件套（零 shell 轨的被测产物）
// ---------------------------------------------------------------------------

/** 被测插件项目目录（workspace 内相对路径） */
const PROJECT_DIR = "smoke-hello-project";
/** 被测插件 id（manifest.id，部署目录名） */
const PLUGIN_ID = "smoke-hello";

/** 五件套内容（模拟 Agent 按《Kiko 插件开发规范.md》生成） */
const FIVE_FILES = {
  "manifest.json": JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Smoke Hello",
      description: "零 Shell 自举冒烟测试插件（Agent 经 file.write 写入）",
      version: "1.0.0",
      entry: "dist/index.js",
      permissions: [],
    },
    null,
    2,
  ),
  "capabilities.json": JSON.stringify(
    [
      {
        id: "hello.echo",
        name: "Echo Message",
        description: "Echo the input message back with a prefix (smoke bootstrap test capability)",
        input_schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message to echo back" },
          },
          required: ["message"],
        },
        output_schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Echoed message with prefix" },
            source: { type: "string", description: "Plugin identifier" },
          },
        },
      },
    ],
    null,
    2,
  ),
  "package.json": JSON.stringify(
    {
      name: "smoke-hello",
      version: "1.0.0",
      type: "module",
      private: true,
    },
    null,
    2,
  ),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        outDir: "dist",
      },
      include: ["src"],
    },
    null,
    2,
  ),
  // src/index.ts：import SDK（由 sdk.build 的 alias 表内联 vendor 物料）
  "src/index.ts": [
    '/** 模拟 Agent 生成的最小插件：单能力 hello.echo */',
    'import { RpcError, ERROR_CODES, type KikoPlugin } from "@kiko-workbench/plugin-sdk";',
    "",
    "const createHelloPlugin = (): KikoPlugin => ({",
    "  async setup(): Promise<void> {",
    "    // 无状态插件：setup 无事可做",
    "  },",
    "  async handle(capabilityId: string, input: unknown): Promise<unknown> {",
    '    if (capabilityId !== "hello.echo") {',
    "      throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `未知能力：${capabilityId}`);",
    "    }",
    "    const { message } = (input ?? {}) as { message?: string };",
    '    return { message: `echo: ${message ?? ""}`, source: "smoke-hello" };',
    "  },",
    "});",
    "",
    "// host 经 manifest.entry 动态加载：default 导出插件单例",
    "export default createHelloPlugin();",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置构建链：protocol / plugin-sdk → vendor 物料 → sdk 插件 / desktop ---
  // （sdk.build 的 alias 表消费 vendor 物料，vendor-sdk.mjs 又依赖两包 dist）
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tscEntry, "-p", join(repoRoot, "packages/protocol", "tsconfig.json")]);
  await run(process.execPath, [tscEntry, "-p", join(repoRoot, "packages/plugin-sdk", "tsconfig.json")]);
  await run(process.execPath, [join(desktopDir, "scripts", "vendor-sdk.mjs")], { cwd: desktopDir });
  await run(process.execPath, [tscEntry, "-p", join(repoRoot, "packages/plugins/sdk", "tsconfig.json")]);
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[bootstrap] 构建完成（protocol / plugin-sdk / vendor:sdk / sdk 插件 / desktop）");

  // --- 环境隔离：临时目录承载全部可写路径 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-bootstrap-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const requestedPort = 29000 + Math.floor(Math.random() * 2000);

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
      // 冒烟兼容开关（与 smoke.mjs 同策略：真实鉴权由 smoke-plugins.mjs 覆盖）
      KIKO_NO_AUTH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  headless.stdout.on("data", (chunk) => process.stdout.write(`[headless] ${chunk}`));
  headless.stderr.on("data", (chunk) => process.stderr.write(`[headless-err] ${chunk}`));
  const mainPid = headless.pid;
  console.log(`[bootstrap] headless 已启动：pid=${mainPid} 请求端口=${requestedPort} 沙箱=${sandbox}`);

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
    headless.once("exit", (code) => {
      if (code !== null) resolvePort(-1);
    });
  });
  check(actualPort > 0, "headless 启动失败（未见 WS 端点日志）");
  const url = `ws://127.0.0.1:${actualPort}`;
  await waitServerReady(url);
  const client = new SmokeClient(url);
  await client.opened();
  console.log(`[bootstrap] WS 已连接：${url}`);

  // ---------------- ① install_guide v2 双轨 ----------------
  await step("① install_guide(agent 缺省)：mode=agent + 五步 + rescan_required（零重启）", async () => {
    const res = await client.request("invoke", {
      capability_id: "sdk.install_guide",
      input: { project_dir: PROJECT_DIR },
      mode: "sync",
    });
    check(res.error === undefined, "install_guide 不应报 JSON-RPC error", res.error);
    check(res.result?.status === "completed", "install_guide 应 completed", res.result);
    const guide = res.result.result;
    check(guide?.mode === "agent", "缺省应为 agent 轨", guide?.mode);
    check(guide?.rescan_required === true, "agent 轨应 rescan_required=true", guide);
    check(guide?.restart_required === undefined, "agent 轨不应再输出 restart_required", guide);
    check(Array.isArray(guide?.steps) && guide.steps.length === 5, "agent 轨应五步", guide?.steps?.length);
    const titles = guide.steps.map((s) => s.title);
    check(titles[0] === "写五件套源码", "步骤 1 应为写五件套", titles);
    check(titles[4] === "验证", "步骤 5 应为验证", titles);
    // 指引命令携带精确 project_dir（Agent 可直接构造请求）
    check(
      String(guide.steps[1]?.command).includes(PROJECT_DIR),
      "build 步骤命令应含 project_dir",
      guide.steps[1]?.command,
    );
    // 规范获取指引可行动（Agent 读不到外部 md → 指向 sdk.spec 能力）
    check(
      String(guide.spec_read_via).includes("sdk.spec"),
      "agent 轨应输出 spec_read_via 指引",
      guide.spec_read_via,
    );
  });

  await step("①b install_guide(human)：v1 人类轨回归（八步 + restart_required 不受影响）", async () => {
    const res = await client.request("invoke", {
      capability_id: "sdk.install_guide",
      input: { mode: "human" },
      mode: "sync",
    });
    check(res.error === undefined, "human 轨不应报错", res.error);
    const guide = res.result?.result;
    check(guide?.mode === "human", "mode=human 应返回 human 轨", guide?.mode);
    check(guide?.restart_required === true, "human 轨应保留 restart_required", guide);
    check(guide?.rescan_required === undefined, "human 轨不应输出 rescan_required", guide);
    check(guide?.steps?.length === 8, "human 轨应保持八步", guide?.steps?.length);
  });

  await step("①c sdk.spec：Agent 读不到外部 md → 规范随物料分发（全文 + 章节过滤）", async () => {
    // 全文：含章节目录 + 真实规范关键内容（双轨标注随物料生效）
    const full = await client.request("invoke", {
      capability_id: "sdk.spec",
      input: {},
      mode: "sync",
    });
    check(full.error === undefined, "sdk.spec 全文不应报错", full.error);
    const spec = full.result?.result;
    check(spec?.name === "Kiko 插件开发规范.md", "应返回规范文档名", spec?.name);
    check(Array.isArray(spec?.sections) && spec.sections.length >= 11, "章节目录应完整", spec?.sections?.length);
    check(String(spec?.content).includes("resolveSafe"), "全文应含规范核心内容", undefined);
    // 章节：仅返回命中章节（Agent 控 context 占用）
    const section = await client.request("invoke", {
      capability_id: "sdk.spec",
      input: { section: "错误处理" },
      mode: "sync",
    });
    check(section.error === undefined, "sdk.spec 章节不应报错", section.error);
    const sec = section.result?.result;
    check(String(sec?.section).includes("错误处理"), "应命中错误处理章节", sec?.section);
    check(String(sec?.content).includes("RpcError"), "章节内容应含 RpcError 约定", undefined);
    check(!String(sec?.content).includes("resolveSafe("), "章节内容不应跨章（resolveSafe 属第 6 节）", undefined);
  });

  // ---------------- ② file.write 五件套 ----------------
  await step("② file.write 五件套：workspace 落盘源码项目（模拟 Agent 写码）", async () => {
    for (const [relPath, content] of Object.entries(FIVE_FILES)) {
      const res = await client.request("invoke", {
        capability_id: "file.write",
        input: { path: `${PROJECT_DIR}/${relPath}`, content },
        mode: "sync",
      });
      check(res.error === undefined, `写入 ${relPath} 不应报错`, res.error);
      check(res.result?.status === "completed", `写入 ${relPath} 应 completed`, res.result);
    }
    // 主进程侧核对一处（入口源码）
    const onDisk = await readFile(join(workspaceRoot, PROJECT_DIR, "src", "index.ts"), "utf-8");
    check(onDisk === FIVE_FILES["src/index.ts"], "src/index.ts 落盘内容应一致");
  });

  // ---------------- ③ sdk.build ----------------
  await step("③ sdk.build：utilityProcess 内 spawn esbuild，产物自包含", async () => {
    const res = await client.request(
      "invoke",
      {
        capability_id: "sdk.build",
        input: { project_dir: PROJECT_DIR },
        mode: "sync",
      },
      60000, // 构建含进程冷启动 + 杀软扫描余量（能力内置 120s 宽限）
    );
    check(res.error === undefined, "sdk.build 不应报 JSON-RPC error", res.error);
    check(res.result?.status === "completed", "sdk.build 应 completed", res.result);
    check(res.result?.error === undefined, "sdk.build 不应执行失败", res.result?.error);
    const buildResult = res.result.result;
    check(typeof buildResult?.entry === "string", "应返回产物入口", buildResult);
    check(typeof buildResult?.size === "number" && buildResult.size > 0, "应返回产物大小", buildResult);
    // 主进程侧核对产物存在 + 自包含（无裸包名 import，node: 除外）
    const bundle = await readFile(join(workspaceRoot, PROJECT_DIR, "dist", "index.js"), "utf-8");
    const bare = (bundle.match(/(?:from\s+|require\()["'][^"'.][^"']*["']/g) ?? []).filter(
      (m) => !m.includes('"node:') && !m.includes("'node:"),
    );
    check(bare.length === 0, "产物不应含裸包名 import（SDK 应已内联）", bare);
  }, );

  // ---------------- ④ sdk.deploy ----------------
  let deployedTo = "";
  await step("④ sdk.deploy：三件套复制到 user_plugins_root/<id>（零 shell）", async () => {
    const res = await client.request("invoke", {
      capability_id: "sdk.deploy",
      input: { project_dir: PROJECT_DIR },
      mode: "sync",
    });
    check(res.error === undefined, "sdk.deploy 不应报 JSON-RPC error", res.error);
    check(res.result?.status === "completed", "sdk.deploy 应 completed", res.result);
    const deployResult = res.result.result;
    check(deployResult?.rescan_hint === true, "应返回 rescan_hint=true", deployResult);
    deployedTo = String(deployResult?.deployed_to ?? "");
    check(deployedTo.length > 0, "应返回 deployed_to", deployResult);
    // 主进程侧核对三件套落位（与 S4 实测磁盘形态一致）
    for (const file of ["manifest.json", "capabilities.json", "dist/index.js"]) {
      const s = await stat(join(deployedTo, file));
      check(s.isFile(), `部署产物应存在：${file}`);
    }
  });

  // ---------------- ⑤ plugins.rescan ----------------
  await step("⑤ plugins.rescan：added 含新插件（不重启工作台）", async () => {
    // 部署前 discover 不应含新能力（对照前提）
    const before = await client.request("discover", {});
    const beforeIds = (before.result?.capabilities ?? []).map((c) => c.id);
    check(!beforeIds.includes("hello.echo"), "rescan 前 discover 不应含 hello.echo", beforeIds);

    const res = await client.request("plugins.rescan", {});
    check(res.error === undefined, "plugins.rescan 不应报错", res.error);
    check(
      Array.isArray(res.result?.added) && res.result.added.includes(PLUGIN_ID),
      `added 应含 ${PLUGIN_ID}`,
      res.result,
    );
    check(
      Array.isArray(res.result?.removed) && res.result.removed.length === 0,
      "removed 应为空（无卸载）",
      res.result,
    );
  });

  // ---------------- ⑥ discover + describe + invoke 新能力 ----------------
  await step("⑥ 新能力即席可用：discover → describe → invoke（懒启动新插件进程）", async () => {
    const discovered = await client.request("discover", {});
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(ids.includes("hello.echo"), "rescan 后 discover 应含 hello.echo", ids);

    const described = await client.request("describe", { capability_id: "hello.echo" });
    check(described.error === undefined, "describe 不应报错", described.error);
    const required = described.result?.input_schema?.required ?? [];
    check(required.includes("message"), "input_schema.required 应含 message", required);

    const ECHO_MESSAGE = "零 shell 自举闭环";
    const invoked = await client.request(
      "invoke",
      {
        capability_id: "hello.echo",
        input: { message: ECHO_MESSAGE },
        mode: "sync",
      },
      60000, // 首次 invoke 懒启动插件进程（utilityProcess 冷启动余量）
    );
    check(invoked.error === undefined, "invoke 不应报 JSON-RPC error", invoked.error);
    check(invoked.result?.status === "completed", "invoke 应 completed", invoked.result);
    check(
      invoked.result?.result?.message === `echo: ${ECHO_MESSAGE}`,
      "echo 内容应一致（插件真实执行）",
      invoked.result?.result,
    );
    check(invoked.result?.result?.source === PLUGIN_ID, "source 应为插件标识", invoked.result?.result);
  });

  // ---------------- ⑦ 二次 rescan：已注册不重载 ----------------
  await step("⑦ 二次 rescan：已注册插件进 skipped（文件变更不重载，首版语义）", async () => {
    const res = await client.request("plugins.rescan", {});
    check(res.error === undefined, "二次 rescan 不应报错", res.error);
    check(
      Array.isArray(res.result?.added) && res.result.added.length === 0,
      "二次 rescan 不应重复注册",
      res.result,
    );
    const skipped = res.result?.skipped ?? [];
    const entry = skipped.find((s) => s.id === PLUGIN_ID);
    check(entry !== undefined, `skipped 应含 ${PLUGIN_ID}`, skipped);
    check(
      typeof entry?.reason === "string" && entry.reason.length > 0,
      "skipped 应携带原因",
      entry,
    );
  });

  // --- 收尾：断开 + 杀进程树 + 清理沙箱 ---
  client.close();
  await run("taskkill", ["/T", "/F", "/PID", String(mainPid)]).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[bootstrap] ====== 汇总 ======");
  for (const s of steps) console.log(`[bootstrap] ${s.ok ? "PASS" : "FAIL"}  ${s.name}`);
  const passed = steps.filter((s) => s.ok).length;
  console.log(`[bootstrap] ${passed}/${steps.length} 步骤通过`);
  process.exit(failed ? 1 : 0);
}

// 整体兜底超时：构建链 + esbuild + 懒启动全链 < 5 分钟
setTimeout(() => {
  console.error("[bootstrap] 整体超时（300s），强制失败退出");
  process.exit(1);
}, 300_000).unref();

main().catch((e) => {
  console.error("[bootstrap] 致命错误：", e);
  process.exit(1);
});
