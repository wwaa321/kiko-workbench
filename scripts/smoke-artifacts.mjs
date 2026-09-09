/**
 * M2-04 产物管理落库冒烟脚本（任务清单 M2-04 验收：
 * "同名两次调用各自可追溯；artifacts 表字段完整"的自动化锚点）
 *
 * 与 smoke-async.mjs / smoke-auth.mjs 同构：spawn headless Electron +
 * WS JSON-RPC，环境隔离（临时目录承载 documentsDir / workspaceRoot /
 * userData / db）。KIKO_NO_AUTH=1 跳过鉴权（鉴权链路由 smoke-auth.mjs
 * 覆盖），专注产物链路。
 *
 * 验证链路（对照设计文档 7.4.2 / 7.2 / PRD 第 9 节 Result 五分）：
 *   步骤 1  headless 启动，file 插件（file.write）可发现
 *   步骤 2  同名两次 file.write（内容长度不同）→ 覆盖语义（7.4.2 例外：
 *           显式路径不自动改名）+ 两次响应各自携带 artifacts 完整五字段
 *           （file/relative_path/filename/mime_type/size），size 各自
 *           对应写入内容——同名调用各自可追溯
 *   步骤 3  磁盘佐证：文件内容 = 第二次写入（覆盖）；artifact.file 绝对
 *           路径真实存在
 *   步骤 4  get_execution 两次查询 → 各自 artifacts 与响应一致（追溯）
 *   步骤 5  强杀重启（同一 db）→ get_execution → artifacts 持久化往返
 *           完整（7.2 artifacts 表 → ExecutionDetail 填充）
 *
 * 用法：node scripts/smoke-artifacts.mjs；全过 exit 0。
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
// 基础工具（与 smoke-async.mjs 同构）
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
    console.log(`[art] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[art] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// headless 进程管理 + WS 客户端（与 smoke-async.mjs 同构，裁剪事件部分）
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

/** WS JSON-RPC 客户端：request 按 id 配对响应 */
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

/** 强杀进程树（/F = 非优雅退出；冒烟不依赖优雅退出路径） */
async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  await delay(1500);
}

/** 断言 artifacts 条目形状完整（7.2 artifacts 表五列同构） */
function expectArtifactShape(artifact, { filename, relativePath, size, mimeType }) {
  check(
    typeof artifact.file === "string" && artifact.file.length > 0,
    "artifact.file 应为非空绝对路径",
    artifact,
  );
  check(artifact.filename === filename, `artifact.filename 应为 ${filename}`, artifact.filename);
  check(
    artifact.relative_path === relativePath,
    `artifact.relative_path 应为 ${relativePath}`,
    artifact.relative_path,
  );
  check(artifact.mime_type === mimeType, `artifact.mime_type 应为 ${mimeType}`, artifact.mime_type);
  check(artifact.size === size, `artifact.size 应为 ${size}`, artifact.size);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // --- 前置：编译（protocol → sdk → file 插件 → desktop，防旧产物误导） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  for (const project of ["packages/protocol", "packages/plugin-sdk", "packages/plugins/file"]) {
    await run(process.execPath, [tscEntry, "-p", join(repoRoot, project, "tsconfig.json")]);
  }
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[art] 构建完成（protocol / sdk / file 插件 / desktop）");

  // --- 环境隔离：临时目录承载全部可写路径 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-art-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const requestedPort = 27000 + Math.floor(Math.random() * 10000);
  const headlessEnv = {
    KIKO_WS_PORT: String(requestedPort),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: userDataDir,
    KIKO_DB_PATH: join(sandbox, "kiko.db"),
    KIKO_SETTINGS_PATH: join(sandbox, "settings.json"),
    KIKO_NO_AUTH: "1",
  };
  console.log(`[art] 沙箱=${sandbox}`);

  const headless = startHeadless(headlessEnv, "headless");
  console.log(`[art] headless 已启动：pid=${headless.pid}`);
  let port = 0;

  await step("启动：file 插件加载成功（file.write 可发现）", async () => {
    port = await resolveWsPort(headless);
    check(port > 0, "headless 启动失败（未见 WS 端点日志）");
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    const discovered = await client.request("discover", { query: "Write" });
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(ids.includes("file.write"), "discover 应包含 file.write", ids);
    client.close();
  });

  // 同名两次写入（覆盖语义验证的输入）：内容长度刻意不同（size 即区分证据）
  const writePath = "smoke-artifacts/同名产物.txt";
  const firstContent = "第一次写入（短）";
  const secondContent = "第二次写入（内容更长，覆盖第一次）——同名可追溯";
  const firstSize = Buffer.byteLength(firstContent, "utf-8");
  const secondSize = Buffer.byteLength(secondContent, "utf-8");
  const writes = [];

  await step(
    "同名两次 file.write → 覆盖语义（不自动改名）+ 响应各自携带 artifacts 五字段",
    async () => {
      const client = new SmokeClient(`ws://127.0.0.1:${port}`);
      await client.opened();

      for (const content of [firstContent, secondContent]) {
        const res = await client.request("invoke", {
          capability_id: "file.write",
          input: { path: writePath, content },
        });
        const result = res.result;
        check(result?.status === "completed", "file.write 应 completed", result);
        check(
          Array.isArray(result?.artifacts) && result.artifacts.length === 1,
          "sync 响应应携带 1 条 artifacts（PRD 第 9 节 Result 五分）",
          result,
        );
        writes.push({ invocationId: result.invocation_id, artifact: result.artifacts[0] });
      }

      // 各自可追溯：两次 artifacts 的 filename 一致（覆盖语义不改名），
      // size 各自对应写入内容（11.x 节审计链不断裂的直接证据）
      const [first, second] = writes;
      expectArtifactShape(first.artifact, {
        filename: "同名产物.txt",
        relativePath: "smoke-artifacts/同名产物.txt",
        size: firstSize,
        mimeType: "text/plain",
      });
      expectArtifactShape(second.artifact, {
        filename: "同名产物.txt",
        relativePath: "smoke-artifacts/同名产物.txt",
        size: secondSize,
        mimeType: "text/plain",
      });
      check(first.invocationId !== second.invocationId, "两次调用应各自产生独立 invocation");
      console.log(`[art]   两次登记：size ${firstSize} / ${secondSize} bytes，invocation 各自独立`);
      client.close();
    },
  );

  await step("磁盘佐证：文件存在且内容 = 第二次写入（覆盖）；artifact.file 真实", async () => {
    const [first, second] = writes;
    const content = await readFile(second.artifact.file, "utf-8");
    check(content === secondContent, "磁盘内容应为第二次写入（覆盖语义）", content);
    check(first.artifact.file === second.artifact.file, "两次登记的绝对路径应一致");
    // 路径落点：工作空间内（7.4.1 布局）
    check(
      second.artifact.file.replace(/\\/g, "/").startsWith(workspaceRoot.replace(/\\/g, "/")),
      "artifact.file 应位于工作空间内",
      second.artifact.file,
    );
  });

  await step("get_execution：两次调用各自 artifacts 可追溯（与响应一致）", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    for (const w of writes) {
      const detail = await client.request("get_execution", {
        invocation_id: w.invocationId,
      });
      const execution = detail.result;
      check(execution?.artifacts?.length === 1, "get_execution 应携带 artifacts", execution);
      check(
        JSON.stringify(execution.artifacts[0]) === JSON.stringify(w.artifact),
        "get_execution artifacts 应与 invoke 响应一致",
        execution.artifacts[0],
      );
    }
    client.close();
  });

  await step("强杀重启 → artifacts 持久化往返完整（7.2 artifacts 表恢复）", async () => {
    await killTree(headless.pid);
    const reborn = startHeadless(headlessEnv, "reborn");
    const rebornPort = await resolveWsPort(reborn);
    check(rebornPort > 0, "重启失败（未见 WS 端点日志）");
    const client = new SmokeClient(`ws://127.0.0.1:${rebornPort}`);
    await client.opened();

    // 两条 invocation 的 artifacts 均从 SQLite 恢复（重启前登记 → 重启后可查）
    for (const w of writes) {
      const detail = await client.request("get_execution", {
        invocation_id: w.invocationId,
      });
      const execution = detail.result;
      check(execution?.status === "completed", "重启后 invocation 状态应为 completed", execution);
      check(
        JSON.stringify(execution.artifacts?.[0]) === JSON.stringify(w.artifact),
        "重启后 artifacts 应完整恢复（五字段不变）",
        execution?.artifacts,
      );
    }
    client.close();
    await killTree(reborn.pid);
  });

  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[art] ======== 冒烟结果 ========");
  for (const s of steps) {
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : `（${s.error}）`}`);
  }
  console.log(`[art] ${steps.filter((s) => s.ok).length}/${steps.length} 步通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[art] 冒烟脚本自身异常：", e);
  process.exit(1);
});
