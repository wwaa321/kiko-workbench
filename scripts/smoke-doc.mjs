/**
 * M2-05 document 插件冒烟脚本（M2 验收门 PRD 第 12 节场景 + R2 的自动化锚点）
 *
 * 与 smoke-artifacts.mjs / smoke-async.mjs 同构：spawn headless Electron +
 * WS JSON-RPC，环境隔离（临时目录承载 documentsDir / workspaceRoot /
 * userData / db）。KIKO_NO_AUTH=1 跳过鉴权（鉴权链路由 smoke-auth.mjs 覆盖）。
 *
 * 验证链路（对照任务清单 M2-05 / M2 验收门 / 设计文档 8.3 / R2）：
 *   步骤 1  headless 启动，document 插件（document.create）可发现
 *   步骤 2  PRD 12 场景：document.create（中文标题/列表/粗斜体 Markdown）
 *           → completed + 落盘 workspace/document/青岛旅行计划.docx
 *           + 响应 result（file/filename/mime_type）与 artifacts 同源
 *   步骤 3  R2 深验：解压首份 docx → word/document.xml 含
 *           eastAsia="Microsoft YaHei"（显式东亚字体，不依赖回退）
 *           + 中文标题/粗体 <w:b/>/有序与无序列表段落
 *   步骤 4  同名第二次（内容更长）→ 自动改名《青岛旅行计划 (2).docx》
 *           且首份未被覆盖（两文件字节大小不同）
 *   步骤 5  两条 invocation 经 get_execution 各自可追溯产物（(2) 前后分开）
 *
 * 用法：node scripts/smoke-doc.mjs；全过 exit 0。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, readFile, copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// 基础工具（与 smoke-artifacts.mjs 同构）
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
    console.log(`[doc] PASS ${name}`);
  } catch (e) {
    failed = true;
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`[doc] FAIL ${name}\n           ${String(e?.message ?? e)}`);
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
// headless 进程管理 + WS 客户端（与 smoke-artifacts.mjs 同构）
// ---------------------------------------------------------------------------

/** 解析 electron 可执行文件真身 */
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

/** 强杀进程树 */
async function killTree(pid) {
  await run("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
  await delay(1500);
}

/**
 * R2 深验辅助：解压 docx（zip）并返回 word/ 下指定 XML 文本。
 * Windows 用 PowerShell Expand-Archive（要求 .zip 扩展名 → 先复制改名）。
 */
async function extractXml(docxPath, scratchDir, xmlName) {
  const zipCopy = join(scratchDir, `doc-${Date.now()}.zip`);
  await copyFile(docxPath, zipCopy);
  const dest = join(scratchDir, `unzip-${Date.now()}`);
  await run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath "${zipCopy}" -DestinationPath "${dest}" -Force`,
  ]);
  return readFile(join(dest, "word", xmlName), "utf-8");
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** PRD 12 场景内容（中文标题 + 段落 + 有序/无序列表 + 粗斜体，R2 用例全覆盖） */
function scenarioContent(version) {
  return [
    `# 青岛三日旅行计划（${version}）`,
    "",
    "海滨之城的行程安排，涵盖经典景点与美食。",
    "",
    "## 每日安排",
    "1. 第一天 栈桥与小青岛",
    "2. 第二天 崂山风景区",
    "3. 第三天 八大关与奥帆中心",
    "",
    "## 亮点",
    "- **必去**：栈桥日出",
    "- *可选*：极地海洋世界",
    "",
    `生成版本标记：${version}——用于同名两份的字节差异佐证（${"详细".repeat(version === "初版" ? 2 : 30)}）。`,
  ].join("\n");
}

async function main() {
  // --- 前置：编译（protocol → sdk → document 插件 → desktop） ---
  const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  for (const project of ["packages/protocol", "packages/plugin-sdk", "packages/plugins/document"]) {
    await run(process.execPath, [tscEntry, "-p", join(repoRoot, project, "tsconfig.json")]);
  }
  await run(process.execPath, [tscEntry, "-p", join(desktopDir, "tsconfig.json")]);
  console.log("[doc] 构建完成（protocol / sdk / document 插件 / desktop）");

  // --- 环境隔离 ---
  const sandbox = await mkdtemp(join(tmpdir(), "kiko-doc-"));
  const documentsDir = join(sandbox, "documents");
  const workspaceRoot = join(sandbox, "documents", "workspace");
  const userDataDir = join(sandbox, "user-data");
  const requestedPort = 28000 + Math.floor(Math.random() * 10000);
  const headlessEnv = {
    KIKO_WS_PORT: String(requestedPort),
    KIKO_DOCUMENTS_DIR: documentsDir,
    KIKO_WORKSPACE_ROOT: workspaceRoot,
    KIKO_USER_DATA_DIR: userDataDir,
    KIKO_DB_PATH: join(sandbox, "kiko.db"),
    KIKO_SETTINGS_PATH: join(sandbox, "settings.json"),
    KIKO_NO_AUTH: "1",
  };
  console.log(`[doc] 沙箱=${sandbox}`);

  const headless = startHeadless(headlessEnv, "headless");
  let port = 0;
  const docDir = join(workspaceRoot, "document");

  await step("启动：document 插件加载成功（document.create 可发现）", async () => {
    port = await resolveWsPort(headless);
    check(port > 0, "headless 启动失败（未见 WS 端点日志）");
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    const discovered = await client.request("discover", { query: "Document" });
    const ids = (discovered.result?.capabilities ?? []).map((c) => c.id);
    check(ids.includes("document.create"), "discover 应包含 document.create", ids);
    client.close();
  });

  /** 两次调用的登记信息（断言共享） */
  const writes = [];

  await step(
    "PRD 12 场景：document.create → 落盘 document/ 子目录 + result/artifacts 同源",
    async () => {
      const client = new SmokeClient(`ws://127.0.0.1:${port}`);
      await client.opened();
      const res = await client.request("invoke", {
        capability_id: "document.create",
        input: { content: scenarioContent("初版"), filename: "青岛旅行计划.docx" },
      });
      const result = res.result;
      check(result?.status === "completed", "document.create 应 completed", result);
      check(result?.error === undefined, "不应有错误", result);

      // result 三字段（8.3 output_schema）：file 绝对路径 / filename / mime_type
      check(result.result?.filename === "青岛旅行计划.docx", "filename 应原样", result.result);
      check(
        String(result.result?.file).replace(/\\/g, "/").startsWith(docDir.replace(/\\/g, "/")),
        "file 应位于 workspace/document/ 子目录",
        result.result?.file,
      );
      check(
        result.result?.mime_type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "mime_type 应为 docx 全称",
        result.result?.mime_type,
      );
      // M2-04 填充的 artifacts 与 result 同源（同一产物登记）
      check(result.artifacts?.length === 1, "应携带 1 条 artifacts", result.artifacts);
      check(
        result.artifacts?.[0]?.filename === result.result?.filename,
        "artifacts.filename 应与 result 一致",
      );
      writes.push({ invocationId: result.invocation_id, artifact: result.artifacts[0] });
      client.close();
    },
  );

  await step("R2 深验：docx 内 XML 显式东亚字体 + 中文标题/粗体/列表齐备", async () => {
    const docXml = await extractXml(writes[0].artifact.file, sandbox, "document.xml");
    // R2 核心：eastAsia 字体槽位显式设置（不依赖 Word 回退链）
    check(docXml.includes('w:eastAsia="Microsoft YaHei"'), "XML 应含 eastAsia 显式字体");
    // 中文标题（h1 段落文本）
    check(docXml.includes("青岛三日旅行计划"), "XML 应含中文标题文本");
    // 粗体 run（**必去** → <w:b/>）
    check(docXml.includes("<w:b/>"), "XML 应含粗体标记 <w:b/>");
    // 列表段落（有序与无序均经 numPr/numId 引用编号定义）
    check(docXml.includes("numPr"), "XML 应含列表段落属性 numPr");

    // 有序 / 无序在 numbering.xml 的 numFmt 区分（decimal / bullet）
    const numberingXml = await extractXml(writes[0].artifact.file, sandbox, "numbering.xml");
    check(numberingXml.includes('w:val="decimal"'), "numbering.xml 应含 decimal（有序列表）");
    check(numberingXml.includes('w:val="bullet"'), "numbering.xml 应含 bullet（无序列表）");
    console.log(`[doc]   document.xml ${docXml.length} 字符，eastAsia/中文/粗体/双列表齐备`);
  });

  await step("同名第二次：自动改名 (2) 且首份未被覆盖（字节差异佐证）", async () => {
    const firstSize = (await stat(writes[0].artifact.file)).size;
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    const res = await client.request("invoke", {
      capability_id: "document.create",
      input: { content: scenarioContent("加长版"), filename: "青岛旅行计划.docx" },
    });
    const result = res.result;
    check(result?.status === "completed", "第二次调用应 completed", result);
    // 7.4.2：同名冲突自动追加序号，永不静默覆盖
    check(result.result?.filename === "青岛旅行计划 (2).docx", "应自动改名 (2)", result.result);
    check(result.artifacts?.[0]?.filename === "青岛旅行计划 (2).docx", "artifacts 应同步改名");
    writes.push({ invocationId: result.invocation_id, artifact: result.artifacts[0] });
    client.close();

    // 首份未被覆盖：初版字节仍为原 size；(2) 版内容更长 size 更大
    const firstStill = (await stat(writes[0].artifact.file)).size;
    const secondSize = (await stat(writes[1].artifact.file)).size;
    check(firstStill === firstSize, "首份文件不应被覆盖", { firstSize, firstStill });
    check(secondSize > firstSize, "第二份（更长内容）应更大", { firstSize, secondSize });
    console.log(`[doc]   两份共存：初版 ${firstSize}B / (2) 版 ${secondSize}B`);
  });

  await step("两条 invocation 各自可追溯（get_execution artifacts 分立）", async () => {
    const client = new SmokeClient(`ws://127.0.0.1:${port}`);
    await client.opened();
    const names = [];
    for (const w of writes) {
      const detail = await client.request("get_execution", { invocation_id: w.invocationId });
      const execution = detail.result;
      check(execution?.status === "completed", "应 completed", execution?.status);
      check(execution?.artifacts?.length === 1, "应各含 1 条 artifacts", execution?.artifacts);
      names.push(execution.artifacts[0].filename);
    }
    check(
      names[0] === "青岛旅行计划.docx" && names[1] === "青岛旅行计划 (2).docx",
      "两条记录应各自登记改名前后的文件名",
      names,
    );
    client.close();
  });

  await killTree(headless.pid);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  // --- 汇总 ---
  console.log("\n[doc] ======== 冒烟结果 ========");
  for (const s of steps) {
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : `（${s.error}）`}`);
  }
  console.log(`[doc] ${steps.filter((s) => s.ok).length}/${steps.length} 步通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[doc] 冒烟脚本自身异常：", e);
  process.exit(1);
});
