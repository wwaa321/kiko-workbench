/**
 * @kiko-workbench/plugin-sdk-distributor —— SDK 分发内置插件
 *（《Kiko 插件 SDK 分发与 Agent 自举开发方案.md》4 节）
 *
 * 能力清单：
 *   - sdk.manifest     —— 版本与物料清单（Agent 校验环境用）
 *                         输入 {} → 输出 { sdk_root, packages[] }
 *   - sdk.install_guide—— 安装指引（Agent 主入口，v2 双轨）：mode=agent
 *                         （缺省）零 shell 五步（file.write → build →
 *                         deploy → rescan → 验证）；mode=human 保留 v1
 *                         人类轨 8 步（npm 命令，需终端与重启）
 *   - sdk.spec         —— 开发规范文档内容（Agent 读不到外部 md，规范
 *                         随物料落盘 vendor/spec/；section 参数分章节拉取）
 *   - sdk.files        —— 按相对路径返回物料单文件内容（远程 Agent
 *                         场景 / 物料一致性校验），路径经 resolveSafe
 *                         校验防越界（规范 6.1 同款约束）
 *
 * 定位（方案 4.1）：不执行业务逻辑，职责是把插件开发物料与安装知识
 * 暴露为能力——插件模型的新语义（能力 = 吐开发物料）。
 *
 * 物料来源：本插件目录下 vendor/@kiko-workbench/（由 apps/desktop 的
 * vendor-sdk.mjs 构建脚本落盘，随 bundle 复制进安装包 extraResources）。
 *
 * 约束：仅依赖 plugin-sdk（设计文档第 4 节依赖方向）；零 electron / core。
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES,
  RpcError,
  resolveSafe,
  type InvocationContext,
  type KikoPlugin,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/**
 * 本插件根目录（manifest.json / vendor/ 所在层）。
 * import.meta.url 自解析（方案 4.4 要点 1），两种形态统一：
 *   - 开发态（tsc 产物）：packages/plugins/sdk/dist/index.js → 上一级
 *   - 安装版：resources/plugins/sdk/dist/index.js → 上一级
 * 不依赖 PluginContext 提供安装路径。
 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SDK 物料根目录（npm install 的本地目录源，sdk_root 字段值） */
const VENDOR_ROOT = join(PLUGIN_ROOT, "vendor", "@kiko-workbench");

/**
 * vendor 内的物料包清单（与 vendor-sdk.mjs 的 VENDOR_PACKAGES 同源约定：
 * plugin-sdk 开发者直接消费；protocol 被 plugin-sdk re-export，必须连带分发）。
 * 同时是 sdk.files 的 package 入参白名单。
 */
const VENDOR_PACKAGES = ["plugin-sdk", "protocol"] as const;

/** sdk.install_guide 入参形状（ajv 主进程侧已校验，此处防御性复检） */
interface InstallGuideInput {
  /** 可选：Agent 的插件项目目录，用于生成精确命令；缺省用占位符 */
  project_dir?: string;
  /** 可选：指引轨道——"agent"（零 shell 轨，缺省）| "human"（v1 人类轨，需终端） */
  mode?: "agent" | "human";
}

/** sdk.files 入参形状 */
interface FilesInput {
  package: string;
  path: string;
}

/** 安装指引单步（方案 4.3 output_schema steps item） */
interface GuideStep {
  title: string;
  command: string;
  explanation: string;
}

/** Node 版本要求（方案 4.3 步骤 1：≥18；esbuild target=node22 建议 20+） */
const NODE_REQUIREMENT = ">=18";

/** 插件接口规范文档名（Agent 开发五件套时遵循，方案 4.3 spec_doc） */
const SPEC_DOC = "Kiko 插件开发规范.md";

/** IO 异常 → RpcError(50001)（与 file 插件 toIoError 同构） */
function toIoError(e: unknown, action: string): RpcError {
  const detail = e instanceof Error ? `${e.message}` : String(e);
  return new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `${action}失败：${detail}`);
}

/** 路径统一正斜杠输出（命令嵌入用：跨 shell 兼容，npm 接受正斜杠） */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * 统计目录内文件数与总字节数（与 vendor-sdk.mjs 的 summarizeDir 口径
 * 一致：递归 readdir，文件计 1、字节累加 stat.size；目录不计入）。
 */
async function summarizeDir(dir: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else {
        fileCount += 1;
        totalBytes += (await stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { fileCount, totalBytes };
}

/**
 * 前置校验：vendor 物料目录必须存在。
 * 缺失场景：开发态未跑 vendor:sdk / 安装包缺物料——直接报可修复的错，
 * 避免后续 readdir 抛出难排障的 ENOENT。
 */
async function assertVendorReady(vendorRoot: string): Promise<void> {
  try {
    const s = await stat(vendorRoot);
    if (!s.isDirectory()) {
      throw new Error("不是目录");
    }
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `SDK 物料缺失（${vendorRoot} 不存在或不可访问）：` +
        `开发态请先在 apps/desktop 执行 pnpm run vendor:sdk 生成物料；` +
        `安装版出现此错误说明安装包不完整，请重新安装`,
    );
  }
}

// ---------------------------------------------------------------------------
// sdk.manifest：版本与物料清单
// ---------------------------------------------------------------------------

/**
 * 返回物料根路径与两包的 { name, version, file_count, total_bytes }。
 * vendorRoot 参数化（测试注入 fixture；工厂调用传模块常量 VENDOR_ROOT）。
 */
async function getSdkManifest(vendorRoot: string): Promise<unknown> {
  await assertVendorReady(vendorRoot);
  // 逐包统计：name/version 读 vendor package.json（源头唯一，与实际
  // 分发物料一致）；文件数/字节数实时递归统计（与 vendor-sdk.mjs 摘要口径一致）
  const packages = await Promise.all(
    VENDOR_PACKAGES.map(async (pkgName) => {
      const pkgDir = join(vendorRoot, pkgName);
      try {
        const pkgJson = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf-8"));
        const { fileCount, totalBytes } = await summarizeDir(pkgDir);
        return {
          name: pkgJson.name as string,
          version: pkgJson.version as string,
          // 协议字段统一 snake_case（方案 4.3 output_schema）
          file_count: fileCount,
          total_bytes: totalBytes,
        };
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw toIoError(e, `统计物料包 ${pkgName}`);
      }
    }),
  );
  return { sdk_root: vendorRoot, packages };
}

// ---------------------------------------------------------------------------
// sdk.install_guide v2：双轨安装指引（S12，零 Shell 自举方案 3.5）
// ---------------------------------------------------------------------------

/**
 * agent 轨五步序列（零 shell 轨，缺省）：不依赖终端 / npm / 重启——
 * 全程 WS 能力调用：file.write 五件套 → sdk.build → sdk.deploy →
 * plugins.rescan → discover/invoke 验证。command 字段承载能力调用
 * 形状（JSON-RPC params 伪代码），Agent 据此构造请求。
 */
function buildAgentSteps(projectDir: string): GuideStep[] {
  return [
    {
      title: "写五件套源码",
      command: `invoke("file.write", { path: "${projectDir}/src/index.ts", content: "..." }) × 5`,
      explanation:
        `先 invoke("sdk.spec") 拿《${SPEC_DOC}》（或传 section 分章节拉取），按其第 2-9 节 ` +
        "编写 manifest.json / capabilities.json / package.json / tsconfig.json / " +
        "src/index.ts 五个文件，逐一调用 file.write 写入（父目录自动创建，覆盖写幂等）。" +
        "要点：capabilities.json 的 description 面向 Agent 认真写；长任务实现 " +
        "isCancelled 检查点；文件操作走 resolveSafe + ctx.artifacts。零 shell 轨" +
        "无需 npm install——SDK 依赖由下一步 sdk.build 的 alias 表改道 vendor " +
        "物料直接内联。",
    },
    {
      title: "构建",
      command: `invoke("sdk.build", { project_dir: "${projectDir}" })`,
      explanation:
        "工作台内 esbuild 打包为自包含单文件（dist/index.js）：SDK 依赖经 " +
        "alias 表从 vendor 物料内联，无需 node_modules。esbuild 输出转发执行" +
        "日志（ctx.log），构建失败（非零退出 / 越界 project_dir / 入口缺失 / " +
        "产物含裸包名 import）返回 50001 附明细。",
    },
    {
      title: "部署",
      command: `invoke("sdk.deploy", { project_dir: "${projectDir}" })`,
      explanation:
        "三件套（manifest.json / capabilities.json / dist/index.js）复制到 " +
        "user_plugins_root/<manifest.id>（源与目标双向沙箱校验；同 id 重复部署 " +
        "覆盖幂等）。微应用插件（contributes.ui 声明）的 web/ 前端资产随部署" +
        "整体复制（entry 缺失则部署前拦截）。返回 deployed_to 与 rescan_hint。",
    },
    {
      title: "重扫插件目录",
      command: `WS JSON-RPC: { "method": "plugins.rescan", "params": {} }`,
      explanation:
        "触发第三方插件根重扫（无需重启工作台）：新部署插件进 added，本輪 " +
        "discover 即可见。已注册插件的文件变更进 skipped（重启生效——首版不做热重载）。",
    },
    {
      title: "验证",
      command: `discover({ query: "<你的能力关键词>" }) → describe → invoke`,
      explanation:
        "discover 确认新能力出现 → describe 拿 input/output schema → invoke 实测。" +
        "排障：invoke 返回 40002 = input_schema 与实际入参不符（ajv 明细在 data）；" +
        "rescan 的 skipped 含冲突 / 校验失败明细；第三方插件 id 与内置相同则不注册" +
        "（内置优先）。",
    },
  ];
}

/**
 * 生成安装指引（双轨）：
 *   - mode "agent"（缺省）：零 shell 五步，全程 WS 能力调用；
 *     输出 rescan_required（部署后调 plugins.rescan 即生效，零重启）
 *   - mode "human"：v1 人类轨 8 步（需终端 + npm + 重启）；
 *     输出 restart_required（Registry 仅启动时扫描）
 * command 含绝对路径（正斜杠），Agent / 开发者可直接逐条执行；
 * project_dir 缺省时用 <project_dir> 占位符（自行替换）。
 * 不触碰文件系统——纯字符串生成，任何环境下可调用。
 */
function getInstallGuide(ctx: PluginContext, input: InstallGuideInput, vendorRoot: string): unknown {
  // 防御性复检（正常链路 ajv 已拦）：非法类型按缺省处理而非报错——
  // 指引是纯文本输出，宽容降级优于阻断
  const projectDir =
    typeof input.project_dir === "string" && input.project_dir.trim() !== ""
      ? input.project_dir
      : "<project_dir>";
  // mode 缺省 agent（零 shell 轨为新缺省，方案 3.5；非法值宽容降级）
  const mode = input.mode === "human" ? "human" : "agent";
  if (mode === "agent") {
    return {
      mode,
      node_requirement: NODE_REQUIREMENT,
      sdk_root: vendorRoot,
      user_plugins_root: ctx.userPluginsRoot,
      steps: buildAgentSteps(toPosix(projectDir)),
      // agent 轨零重启：部署后调 plugins.rescan 即生效（S11）
      rescan_required: true,
      spec_doc: SPEC_DOC,
      // 规范获取方式（Agent 读不到外部 md）：invoke sdk.spec（可传 section 分段）
      spec_read_via: `invoke("sdk.spec", { section?: "<章节关键词>" })`,
    };
  }
  const sdkRoot = toPosix(vendorRoot);
  const deployTarget = `${toPosix(ctx.userPluginsRoot)}/<plugin-id>`;

  const steps: GuideStep[] = [
    {
      title: "检查 Node 环境",
      command: "node -v",
      explanation:
        `要求 ${NODE_REQUIREMENT}（esbuild target=node22 建议 20+）。` +
        `输出 v18.x / v20.x / v22.x 均可继续；版本过低请先升级 Node。`,
    },
    {
      title: "初始化项目",
      command: `mkdir "${projectDir}" && cd "${projectDir}" && npm init -y`,
      explanation:
        "创建插件项目目录并生成 package.json。目录已存在时 mkdir 可能报错，" +
        "忽略该错误直接 cd 进入即可。",
    },
    {
      title: "安装 SDK",
      command: `npm install --install-links "${sdkRoot}/plugin-sdk" "${sdkRoot}/protocol"`,
      explanation:
        "本地目录安装（两包未发布公共 npm，registry 必 404）。" +
        "两包必须同一条命令安装：npm 才能把 plugin-sdk 对 @kiko-workbench/protocol " +
        "的依赖去重为本地目录；分开安装会导致 npm 去 registry 搜索而失败。" +
        "--install-links 必须携带：npm 对目录源默认创建符号链接（junction）而非复制，" +
        "esbuild 解析符号链接为真实路径后将从 vendor 目录向上找不到 " +
        "@kiko-workbench/protocol（S4 实测复现）；--install-links 强制复制到 " +
        "node_modules，tsc 与 esbuild 均从项目 node_modules 正常解析。",
    },
    {
      title: "安装构建工具",
      command: "npm install -D esbuild typescript",
      explanation:
        "esbuild 把源码与依赖打包为自包含单文件（工作台运行插件不装 node_modules）；" +
        "typescript 提供开发期类型检查（可选但推荐）。",
    },
    {
      title: "编写五件套",
      command: "",
      explanation:
        `按《${SPEC_DOC}》第 2-8 节编写 manifest.json / capabilities.json / ` +
        "package.json / tsconfig.json / src/index.ts。要点：capabilities.json 的 " +
        "description 面向 Agent 认真写；长任务实现 isCancelled 检查点；" +
        "文件操作走 resolveSafe + ctx.artifacts。",
    },
    {
      title: "构建",
      command:
        "npx esbuild src/index.ts --bundle --format=esm --platform=node " +
        "--target=node22 --outfile=dist/index.js",
      explanation:
        "产出 dist/index.js。自包含校验：构建后检查产物无裸包名 import " +
        "（依赖已内联；node: 内置模块除外）。",
    },
    {
      title: "部署",
      command:
        `New-Item -ItemType Directory -Force "${deployTarget}"; ` +
        `Copy-Item manifest.json,capabilities.json,dist/index.js "${deployTarget}/" -Force; ` +
        `if (Test-Path web) { Copy-Item web "${deployTarget}/" -Recurse -Force }`,
      explanation:
        "在项目目录内执行（PowerShell 命令；工作台仅 Windows 分发）。" +
        "Unix 等价：mkdir -p <目标> && cp manifest.json capabilities.json " +
        "dist/index.js <目标>/ && [ -d web ] && cp -r web <目标>/。" +
        "<plugin-id> 替换为 manifest.json 的 id 字段值。" +
        "微应用插件（contributes.ui 声明）的 web/ 前端资产必须随部署复制" +
        "（Test-Path 守卫：非微应用项目无此目录自动跳过）——缺资产则注册期" +
        "uiEntry 校验失败（error 态）。" +
        "必须部署到 user_plugins_root（userData 第三方根）——覆盖安装不丢失；" +
        "不要放安装目录内的假插件目录（升级被清空且只读）。",
    },
    {
      title: "重启验证",
      command: "",
      explanation:
        "重启 Kiko Workbench（Registry 仅启动时扫描插件目录）。启动后：" +
        "discover 确认新能力出现 → describe 拿 input/output schema → invoke 实测。" +
        "排障：invoke 返回 40002 = input_schema 与实际入参不符（ajv 明细在 data）；" +
        "插件卡片异常 = manifest 解析失败 / capability id 冲突 / entry 缺 default 导出；" +
        "第三方插件 id 与内置相同则不注册（内置优先，日志告警）。",
    },
  ];

  return {
    mode,
    node_requirement: NODE_REQUIREMENT,
    sdk_root: vendorRoot,
    // 部署目标：主进程注入的第三方插件根（PluginContext.userPluginsRoot，S2 扩展字段）
    user_plugins_root: ctx.userPluginsRoot,
    steps,
    // M2（方案 7 节）：Registry 仅启动时扫描，部署后必须重启生效；
    // Agent 拿到此标记应明确提示用户重启（仅 human 轨；agent 轨 rescan 即生效）
    restart_required: true,
    spec_doc: SPEC_DOC,
    // 规范获取方式（Agent 读不到外部 md）：invoke sdk.spec（可传 section 分段）
    spec_read_via: `invoke("sdk.spec", { section?: "<章节关键词>" })`,
  };
}

// ---------------------------------------------------------------------------
// sdk.files：物料文件内容（按需拉取）
// ---------------------------------------------------------------------------

/**
 * 读 vendor 内单文件：package 白名单校验 → resolveSafe 防越界 →
 * 读 UTF-8 文本返回。物料均为文本（.js/.d.ts/.json），无需 base64 分支。
 */
async function readVendorFile(input: FilesInput, vendorRoot: string): Promise<unknown> {
  // 防御复检（正常链路 ajv enum 已拦）：package 是路径拼接源，必须白名单
  if (!(VENDOR_PACKAGES as readonly string[]).includes(input.package)) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `未知物料包：${input.package}（允许：${VENDOR_PACKAGES.join(" / ")}）`,
    );
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, "path 必须为非空字符串");
  }
  // 沙箱校验（方案 4.3 实现要点）：package + "/" + path 整体经 resolveSafe
  // 校验，防 ".." 越界读任意文件（越界抛 50001）
  const file = resolveSafe(vendorRoot, `${input.package}/${input.path}`);
  let s;
  let content: string;
  try {
    s = await stat(file);
    if (!s.isFile()) {
      throw new RpcError(
        ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        `不是文件：${input.package}/${input.path}`,
      );
    }
    content = await readFile(file, "utf-8");
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw toIoError(e, `读取物料文件 ${input.package}/${input.path}`);
  }
  return { content, size: s.size };
}

// ---------------------------------------------------------------------------
// sdk.spec：开发规范文档内容（Agent 读不到外部 md，规范随物料分发）
// ---------------------------------------------------------------------------

/** sdk.spec 入参形状 */
interface SpecInput {
  /** 可选章节过滤（对二级标题包含式匹配，如 "7" / "错误处理"）；缺省返回全文 */
  section?: string;
}

/** 规范文档在 vendor 内的落盘位置（vendor-sdk.mjs 从 repo 根复制） */
const SPEC_ROOT = join(PLUGIN_ROOT, "vendor", "spec");

/**
 * 返回插件开发规范全文或指定章节。
 *
 * 背景：install_guide 引用的《Kiko 插件开发规范.md》是 repo 内的外部
 * 文档，Agent 无文件系统渠道获取——vendor-sdk.mjs 把它随 SDK 物料
 * 落盘到 vendor/spec/，本能力按二级标题（`## `）切分返回：
 *   - section 缺省 → 全文 content + sections 章节目录
 *   - section 命中（标题包含式匹配，首个命中） → 仅该章节内容
 * Agent 可先拿目录再按需拉章节，控制自身 context 占用。
 */
async function getSpecDoc(input: SpecInput, specRoot: string): Promise<unknown> {
  const docPath = join(specRoot, SPEC_DOC);
  let content: string;
  try {
    content = await readFile(docPath, "utf-8");
  } catch (e) {
    throw toIoError(
      e,
      `读取开发规范（${docPath}；开发态请先在 apps/desktop 执行 pnpm run vendor:sdk 生成物料；安装版出现此错误说明安装包不完整）`,
    );
  }

  // 按"行首 ## "切分章节（含"附："级）：[全文前导, 章节1, 章节2, ...]
  const parts = content.split(/^(?=## )/m);
  // 章节目录：每个片段的首行去掉 "## " 前缀
  const sections = parts.slice(1).map((p) => p.split("\n", 1)[0]?.replace(/^##\s*/, "") ?? "");

  const section = input.section;
  if (section === undefined || section === "") {
    return { name: SPEC_DOC, sections, content };
  }
  // 包含式匹配（大小写不敏感）：Agent 给 "7" 或 "错误处理" 均可命中
  const idx = sections.findIndex((t) => t.toLowerCase().includes(section.toLowerCase()));
  if (idx === -1) {
    // 未命中：附可用章节列表，Agent 可自纠（50001 业务错误）
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `规范章节未命中：${section}（可用章节：${sections.join(" / ")}）`,
    );
  }
  return { name: SPEC_DOC, section: sections[idx], sections, content: parts[idx + 1] ?? "" };
}

// ---------------------------------------------------------------------------
// sdk.build：零 shell 构建（S9，零 Shell 自举方案 3.1）
// ---------------------------------------------------------------------------

/** sdk.build 入参形状 */
interface BuildInput {
  /** workspace 内的插件项目目录相对路径（file.write 写源码处） */
  project_dir: string;
}

/** 构建超时（方案 3.1：esbuild 快但冷启动/杀软扫描可能拖秒级，给足余量） */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * alias 表：裸包名 → vendor 物料 dist 入口（固定双包，硬编码——
 * 输入不可扩展，免 npm install 的机制核心：import 直接改道 vendor）。
 */
const SDK_ALIASES: ReadonlyArray<[string, string]> = [
  ["@kiko-workbench/plugin-sdk", "plugin-sdk"],
  ["@kiko-workbench/protocol", "protocol"],
];

/**
 * spawn esbuild CLI 完成自包含 bundle（S8 spike 实证路线）：
 *   <entry> --bundle --format=esm --platform=node --target=node22
 *     --alias:<sdk 包>=<vendor>/dist/index.js ×2 --outdir=<project>/dist
 *
 * 安全要点（方案 3.1）：命令行参数全部由本函数内部构造，project_dir
 * 仅经 resolveSafe 校验后进入路径位置——无 shell 拼接、无注入面。
 * stdout/stderr（esbuild 告警/报错）逐段转发 ctx.log（Agent 可在
 * Trace 日志排障）；非零退出码 → 50001 附 stderr 尾部。
 */
async function buildProject(
  ctx: PluginContext,
  input: BuildInput,
  vendorRoot: string,
  log: (message: string) => void,
): Promise<unknown> {
  const { esbuildBinaryPath } = ctx;
  if (esbuildBinaryPath === undefined || esbuildBinaryPath === "") {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      "esbuild 二进制不可用（esbuildBinaryPath 未注入或未分发）：" +
        "开发态请确认 @esbuild/win32-x64 依赖存在；安装版请联系维护者",
    );
  }
  if (typeof input.project_dir !== "string" || input.project_dir.trim() === "") {
    throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, "project_dir 必须为非空字符串");
  }
  // 沙箱校验：project_dir 必须落在 workspaceRoot 内（file.write 同款基座）
  const projectDir = resolveSafe(ctx.workspaceRoot, input.project_dir);
  const entry = join(projectDir, "src", "index.ts");
  try {
    await stat(entry);
  } catch (e) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `构建入口缺失：${input.project_dir}/src/index.ts（先经 file.write 写入源码五件套）`,
    );
  }

  // 参数全部内部构造（alias 表硬编码双包；输入只进入已校验的路径位置）
  const args: string[] = [
    entry,
    "--bundle",
    "--format=esm",
    "--platform=node",
    "--target=node22",
    ...SDK_ALIASES.flatMap(([pkg, vendorDir]) =>
      // alias 值用 vendor 物料 dist 入口（spike 实测形态）
      [`--alias:${pkg}=${toPosix(join(vendorRoot, vendorDir, "dist", "index.js"))}`],
    ),
    `--outdir=${toPosix(join(projectDir, "dist"))}`,
    "--log-level=warning",
  ];

  // spawn 兜底：命令不存在 / 被杀软拦截等 spawn 级错误同步抛出
  const child = spawn(esbuildBinaryPath, args, { windowsHide: true });

  // stdout/stderr 逐段转发执行日志（esbuild 报错走 stderr，Agent 排障入口）
  child.stdout.on("data", (chunk: Buffer) => {
    const text = String(chunk).trim();
    if (text !== "") log(`[esbuild] ${text}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = String(chunk).trim();
    if (text !== "") log(`[esbuild-err] ${text}`);
  });

  // 退出码等待 + 超时强杀（超时也走 RpcError 而非协议级超时——构建时长
  // 不可预估，协议 timeout_ms 默认 30s 会误杀长构建，故能力内置宽限）
  const exitCode = await new Promise<number>((settleExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(
        new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `构建超时（${BUILD_TIMEOUT_MS / 1000}s）`),
      );
    }, BUILD_TIMEOUT_MS);
    child.once("error", (e: Error) => {
      clearTimeout(timer);
      rejectExit(
        new RpcError(
          ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          `esbuild 启动失败（${esbuildBinaryPath}）：${e.message}`,
        ),
      );
    });
    child.once("exit", (code: number | null) => {
      clearTimeout(timer);
      settleExit(code ?? -1);
    });
  });

  const output = join(projectDir, "dist", "index.js");
  if (exitCode !== 0) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `esbuild 构建失败（退出码 ${exitCode}）——详见执行日志 [esbuild-err] 段`,
    );
  }
  try {
    // 产物自包含校验：零裸包名 import（node: 前缀除外，规范 9 节契约）
    const bundle = await readFile(output, "utf-8");
    const bare = bundle.match(/(?:from\s+|require\()["'][^"'.][^"']*["']/g) ?? [];
    const offending = bare.filter(
      (m) => !m.includes('"node:') && !m.includes("'node:"),
    );
    if (offending.length > 0) {
      throw new RpcError(
        ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        `产物含裸包名 import（${offending.join(", ")}）——运行时无 node_modules 解析链`,
      );
    }
    const size = (await stat(output)).size;
    return { entry: output, size };
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw toIoError(e, "读取构建产物");
  }
}

// ---------------------------------------------------------------------------
// sdk.deploy：零 shell 部署（S10，零 Shell 自举方案 3.2）
// ---------------------------------------------------------------------------

/** sdk.deploy 入参形状 */
interface DeployInput {
  /** workspace 内的插件项目目录相对路径（sdk.build 产物所在） */
  project_dir: string;
}

/** 部署的三件套（registry 扫描 + host 加载的最小集合，方案 3.2） */
const DEPLOY_FILES = ["manifest.json", "capabilities.json", "dist/index.js"] as const;

/**
 * 微应用前端资产部署源解析（P-003 对齐）：
 * manifest.contributes.ui.entry 声明存在时，返回应随插件复制的资产路径
 * （entry 所在目录——静态资产整体分发，HTML/CSS/JS 相互引用不可拆）。
 * 校验规则与 registry assertUiEntry 逐条对齐（分段安全 + 文件存在），
 * 部署前拦截——避免部署出缺资产的半成品目录被 registry 扫成 error 态。
 * @returns null = 非微应用插件（无 ui 声明）
 */
async function resolveUiAssetDir(
  projectDir: string,
  manifest: { contributes?: { ui?: { entry?: unknown } } },
): Promise<string | null> {
  const entry = manifest.contributes?.ui?.entry;
  if (entry === undefined) return null;

  // ---- 与 registry assertUiEntry 同款校验（分段安全） ----
  if (typeof entry !== "string" || entry.length === 0) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      'contributes.ui 声明存在但 entry 缺失或非字符串（须为相对插件目录的 HTML 入口，如 "web/index.html"）',
    );
  }
  const segments = entry.replace(/\\/g, "/").split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes(":"))) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `contributes.ui.entry 非法相对路径（禁止绝对路径 / 穿越段 / 盘符）：${entry}`,
    );
  }
  // ---- 文件存在性（部署前拦截，与 dist/index.js 校验同款模式） ----
  try {
    const info = await stat(join(projectDir, ...segments));
    if (!info.isFile()) {
      throw new Error("非常规文件");
    }
  } catch {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `contributes.ui.entry 文件不存在：${entry}（微应用前端资产须随插件项目分发，部署时整体复制）`,
    );
  }
  // entry 所在目录（如 "web/index.html" → "web"；根目录 entry → "." 单文件语义由调用方处理）
  return segments.length > 1 ? segments.slice(0, -1).join("/") : ".";
}

/** 部署目标目录安全名约束（与 host load 的 pluginId 校验同款规则） */
function assertSafePluginId(id: string): void {
  if (
    id.length === 0 ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..")
  ) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `非法 plugin id（禁止路径分隔符与 ..）：${id}`,
    );
  }
}

/**
 * 复制三件套到 user_plugins_root/<plugin_id>（方案 3.2 实现要点）：
 *   - 源经 resolveSafe(workspaceRoot) 校验（project_dir 不可越界）
 *   - 目标 userPluginsRoot/<manifest.id>（id 取自 manifest——目标路径
 *     注入的源头被封死：manifest.id 经 assertSafePluginId 单段校验）
 *   - manifest 预校验（对齐 registry assertManifest：id/name/version；
 *     capabilities 预校验：可解析且为数组；dist/index.js 存在）
 *   - 覆盖语义：同 id 已部署则覆盖（迭代部署幂等）；已注册运行中的
 *     插件覆盖后内存态未变 → rescan_hint 提示（rescan 语义见方案 3.3）
 */
async function deployProject(
  ctx: PluginContext,
  input: DeployInput,
): Promise<unknown> {
  if (typeof input.project_dir !== "string" || input.project_dir.trim() === "") {
    throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, "project_dir 必须为非空字符串");
  }
  // 源沙箱校验：project_dir 必须落在 workspaceRoot 内
  const projectDir = resolveSafe(ctx.workspaceRoot, input.project_dir);

  // manifest 预校验（部署前拦截，避免半成品目录被 registry 扫到报错态）
  let manifest: {
    id?: unknown;
    name?: unknown;
    version?: unknown;
    contributes?: { ui?: { entry?: unknown } };
  };
  try {
    manifest = JSON.parse(await readFile(join(projectDir, "manifest.json"), "utf-8"));
  } catch (e) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `manifest.json 缺失或不可解析（${input.project_dir}/manifest.json）：` +
        `部署中止——请先补齐五件套`,
    );
  }
  if (
    typeof manifest.id !== "string" ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      "manifest 校验失败：id / name / version 均为必填字符串（对齐 registry assertManifest）",
    );
  }
  assertSafePluginId(manifest.id);

  // capabilities 预校验：可解析且为数组（元素结构留给 registry 深度校验）
  try {
    const capabilities = JSON.parse(await readFile(join(projectDir, "capabilities.json"), "utf-8"));
    if (!Array.isArray(capabilities)) {
      throw new Error("顶层不是数组");
    }
  } catch (e) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `capabilities.json 缺失或不可解析（${input.project_dir}/capabilities.json）：部署中止`,
    );
  }
  // 构建产物存在性（build 前置；缺产物提示先 sdk.build）
  try {
    await stat(join(projectDir, "dist", "index.js"));
  } catch (e) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `构建产物缺失：${input.project_dir}/dist/index.js——请先调用 sdk.build`,
    );
  }

  // P-003：微应用资产源解析（manifest 声明驱动；缺 entry 文件部署前拦截）
  const uiAssetDir = await resolveUiAssetDir(projectDir, manifest);

  // 目标目录：userPluginsRoot/<manifest.id>（createSafeJoin 语义经
  // assertSafePluginId + join 构成；不存在则递归创建）
  const target = join(ctx.userPluginsRoot, manifest.id);
  const deployedFiles: string[] = [...DEPLOY_FILES];
  try {
    await mkdir(target, { recursive: true });
    // 三件套逐一复制（cp 保留内容；目标已存在即覆盖——迭代幂等）
    for (const file of DEPLOY_FILES) {
      await cp(join(projectDir, file), join(target, file));
    }
    // P-003：微应用前端资产整体复制（entry 所在目录；registry 注册期
    // 校验 uiEntry 存在性——不复制则插件直接 error 态）。根目录 entry
    // （单文件语义）复制 entry 本身，避免把项目源码整目录带进插件
    if (uiAssetDir !== null) {
      if (uiAssetDir === ".") {
        const entryFile = String(manifest.contributes?.ui?.entry).replace(/\\/g, "/");
        await cp(join(projectDir, entryFile), join(target, entryFile));
        deployedFiles.push(entryFile);
      } else {
        await cp(join(projectDir, uiAssetDir), join(target, uiAssetDir), {
          recursive: true,
        });
        deployedFiles.push(`${uiAssetDir}/`);
      }
    }
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw toIoError(e, "复制部署文件");
  }
  return {
    deployed_to: target,
    files: deployedFiles,
    // rescan_hint 恒 true：Agent 部署后应调 plugins.rescan（方案 3.3）
    rescan_hint: true,
  };
}

// ---------------------------------------------------------------------------
// 插件工厂（与 file 插件同构：闭包隔离内部状态）
// ---------------------------------------------------------------------------

/**
 * SDK 分发插件工厂：返回全新 KikoPlugin 实例（内部状态闭包隔离）。
 * host 经 manifest.entry 动态加载 default 导出（单例，每进程一次 setup）；
 * 单测可调工厂取干净实例（免受模块级状态污染）。
 */
export function createSdkPlugin(): KikoPlugin {
  /** 宿主注入的初始化上下文（setup 后可用；install_guide 消费 userPluginsRoot） */
  let pluginCtx: PluginContext | undefined;
  return {
    /** load 后调用一次：保存上下文（S2 扩展的 userPluginsRoot 在此注入） */
    async setup(ctx: PluginContext): Promise<void> {
      pluginCtx = ctx;
    },

    /** 能力执行入口：按 capabilityId 分发能力（sdk.build 消费 ctx.log 转发 esbuild 输出） */
    async handle(
      capabilityId: string,
      input: unknown,
      ctx: InvocationContext,
    ): Promise<unknown> {
      if (pluginCtx === undefined) {
        // 防御：未经 setup 即 invoke 属 host 协议违例（正常链路不可达）
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "sdk 插件未初始化（setup 未调用）");
      }
      switch (capabilityId) {
        case "sdk.manifest":
          return getSdkManifest(VENDOR_ROOT);
        case "sdk.install_guide":
          return getInstallGuide(pluginCtx, (input ?? {}) as InstallGuideInput, VENDOR_ROOT);
        case "sdk.files":
          return readVendorFile(input as FilesInput, VENDOR_ROOT);
        case "sdk.spec":
          return getSpecDoc((input ?? {}) as SpecInput, SPEC_ROOT);
        case "sdk.build":
          // log 桥接 InvocationContext（esbuild 输出转发执行日志，Agent 排障）
          return buildProject(pluginCtx, (input ?? {}) as BuildInput, VENDOR_ROOT, (m) =>
            ctx.log(m),
          );
        case "sdk.deploy":
          return deployProject(pluginCtx, (input ?? {}) as DeployInput);
        default:
          throw new RpcError(
            ERROR_CODES.PLUGIN_EXECUTION_ERROR,
            `sdk 插件不支持能力：${capabilityId}`,
          );
      }
    },
  };
}

/**
 * 仅供测试使用的辅助（paths.ts 的 _internal 先例）：三能力实现均参数化
 * vendorRoot，单测注入临时 fixture 目录——不依赖真实 vendor 物料
 * （.gitignore 忽略，CI 克隆后不存在），避免测试随构建状态抖动。
 */
export const _internal = {
  getSdkManifest,
  getInstallGuide,
  readVendorFile,
  getSpecDoc,
  summarizeDir,
  buildProject,
  deployProject,
  SDK_ALIASES,
};

// host 经 manifest.entry 动态加载：default 导出插件单例
export default createSdkPlugin();
