/**
 * SDK 物料落盘脚本（S1 —— 《Kiko 插件 SDK 分发与 Agent 自举开发方案.md》3.2）
 *
 * 背景：@kiko-workbench/plugin-sdk 与 @kiko-workbench/protocol 从未发布
 * 公共 npm（registry 404），monorepo 之外的开发者（人类与 Agent）执行
 * `npm install @kiko-workbench/plugin-sdk` 必然失败——插件开发规范第 2 节
 * 的快速开始对外部环境走不通。
 *
 * 方案：把两包构建产物（package.json + dist/）落盘到 sdk 分发插件的
 * vendor/ 目录，随安装包分发（extraResources）；sdk 插件再把物料位置 /
 * 版本 / 安装步骤暴露为能力（sdk.manifest / sdk.install_guide / sdk.files），
 * 使工作台自身成为插件开发物料的分发渠道。
 *
 * 产物布局（packages/plugins/sdk/vendor/@kiko-workbench/）：
 *   plugin-sdk/package.json   ← workspace: 协议已改写为实际版本（见下）
 *   plugin-sdk/dist/          ← tsc 产物（index / host-entry / errors …）
 *   protocol/package.json
 *   protocol/dist/
 *
 * 关键改写：plugin-sdk 声明 "@kiko-workbench/protocol": "workspace:*"，
 * workspace 协议在 monorepo 外无法解析（直接复制即废包）——落盘前把
 * 依赖字段中的 workspace: 协议统一改写为对应 workspace 包的实际版本号。
 *
 * 前置依赖：`pnpm -r build` 已产出两包 dist/（本脚本只搬运，不构建）。
 * 幂等：整体 rm 后重建，重复执行覆盖旧物料；版本源头唯一（workspace
 * 包本身），无独立版本线，不存在 tarball 方案的漂移风险。
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本位于 apps/desktop/scripts/ → desktop 上一层，repoRoot 再上两层
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const packagesRoot = join(repoRoot, "packages");

/**
 * 需要落盘的 workspace 包：
 * - plugin-sdk：插件开发者直接消费（类型 + host 运行时）
 * - protocol：plugin-sdk 运行时 re-export RpcError / ERROR_CODES，
 *   必须连带分发，否则 npm install 后解析链断裂
 */
const VENDOR_PACKAGES = ["plugin-sdk", "protocol"];

/**
 * 随物料分发的插件开发规范文档（repo 根唯一源头 → vendor/spec/）：
 * Agent 无文件系统外的文档获取渠道——install_guide 引用的规范必须
 * 落盘进安装包，经 sdk.spec 能力按章节返回（防 Agent context 膨胀）。
 */
const SPEC_DOC_NAME = "Kiko 插件开发规范.md";
const specDocSource = join(repoRoot, SPEC_DOC_NAME);
const specDocOut = join(packagesRoot, "plugins", "sdk", "vendor", "spec", SPEC_DOC_NAME);

/** vendor 物料落盘根目录（位于 sdk 分发插件目录内，随 bundle 复制进安装包） */
const vendorRoot = join(packagesRoot, "plugins", "sdk", "vendor", "@kiko-workbench");

/** vendor 顶层目录（清理范围：@kiko-workbench 包物料 + spec/ 规范文档整体重建） */
const vendorParent = join(packagesRoot, "plugins", "sdk", "vendor");

/** 依赖字段全集（npm 规范定义，改写时逐一扫描） */
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** workspace 协议匹配：workspace:* / workspace: / workspace:^ / workspace:~ / workspace:^1.2.3 */
const WORKSPACE_SPEC_RE = /^workspace:(.*)$/;

/** workspace 包版本缓存（name → version），改写 workspace: 协议时的版本来源 */
const workspaceVersions = new Map();

/**
 * 读入并解析 JSON 文件（统一异常包装：读坏 / JSON 非法时报出哪个文件出的问题）
 */
async function readJson(filePath, what) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (e) {
    throw new Error(`读取 ${what} 失败（${filePath}）：${e.message}`);
  }
}

/**
 * 前置校验：目标包的 package.json 与 dist/index.js（main 入口）必须存在。
 * 缺失说明未构建，直接失败并给出修复命令，避免产出半成品物料。
 */
async function assertBuildReady(pkgDir, name) {
  const manifestPath = join(pkgDir, "package.json");
  const distEntry = join(pkgDir, "dist", "index.js");
  try {
    await stat(manifestPath);
    await stat(distEntry);
  } catch {
    throw new Error(
      `包 @kiko-workbench/${name} 构建产物缺失（${distEntry} 不存在）。\n` +
        `请先在仓库根执行 pnpm -r build，再运行本脚本。`,
    );
  }
}

/**
 * 预扫描 packages/* 下所有包，建立 name → version 映射。
 * 未来 plugin-sdk 若新增其他 workspace 依赖（如 core），改写逻辑无需变更。
 */
async function scanWorkspaceVersions() {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const pkgJson = await readJson(
        join(packagesRoot, entry.name, "package.json"),
        `packages/${entry.name}/package.json`,
      );
      if (typeof pkgJson.name === "string" && typeof pkgJson.version === "string") {
        workspaceVersions.set(pkgJson.name, pkgJson.version);
      }
    } catch {
      // 目录无 package.json（非 npm 包，如 plugins/ 子目录）：跳过，不中断
    }
  }
}

/**
 * 改写 package.json 中所有依赖字段的 workspace: 协议为实际版本：
 * - workspace:* / workspace: / workspace:^ / workspace:~ → 实际版本号（精确锁定）
 * - workspace:^1.2.3 等显式 range → 保留 range 语义（^1.2.3）
 * 找不到对应 workspace 包时抛错（宁可失败，不出废包）。
 */
function rewriteWorkspaceDeps(pkgJson, sourceLabel) {
  for (const field of DEP_FIELDS) {
    const deps = pkgJson[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      const match = WORKSPACE_SPEC_RE.exec(spec);
      if (!match) continue;
      const version = workspaceVersions.get(depName);
      if (!version) {
        throw new Error(
          `${sourceLabel} 依赖 ${depName} 使用 ${spec}，但 workspace 中找不到该包，无法改写`,
        );
      }
      const range = match[1];
      deps[depName] = range === "*" || range === "" || range === "^" || range === "~" ? version : range;
      console.log(`[vendor-sdk] 改写 ${sourceLabel}: ${depName} ${spec} → ${deps[depName]}`);
    }
  }
  return pkgJson;
}

/**
 * 统计目录内文件数与总字节数（摘要输出用，与 sdk.manifest 能力的口径一致）
 */
async function summarizeDir(dir) {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (d) => {
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
 * 清理 vendor 目录（幂等前提：先清空再落盘，防旧版本残留文件混入安装包）。
 *
 * Windows 下刚写入的文件可能被 IDE 索引 / 杀毒实时扫描短锁（EBUSY /
 * EPERM，实测锁为秒级释放）——启用 Node rm 内置重试（最多 10 次 ×
 * 500ms ≈ 5 秒窗口）。重试窗口耗尽仍失败时降级为覆盖模式：不删目录、
 * 直接覆盖写入（仅当上游包删除过文件时才可能残留旧文件，风险可接受）。
 */
async function cleanVendorDir() {
  try {
    await rm(vendorParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return;
  } catch (e) {
    console.warn(
      `[vendor-sdk] 警告：vendor 目录清理失败（${e.code ?? e.message}），` +
        `降级为覆盖模式——若上游包或规范文档删除过文件，旧文件可能残留，建议稍后重跑本脚本`,
    );
  }
}

async function main() {
  // 0. 前置校验：两包构建产物就位（防误跑 / 产出半成品物料）
  for (const name of VENDOR_PACKAGES) {
    await assertBuildReady(join(packagesRoot, name), name);
  }
  // 1. 建立 workspace 版本映射（改写 workspace: 协议的版本来源）
  await scanWorkspaceVersions();

  // 2. 清理重建（见 cleanVendorDir 注释：重试 + 降级覆盖双保险）
  await cleanVendorDir();
  await mkdir(vendorRoot, { recursive: true });

  // 3. 逐包落盘：package.json（改写后写入）+ dist/ 整体复制
  for (const name of VENDOR_PACKAGES) {
    const pkgDir = join(packagesRoot, name);
    const outDir = join(vendorRoot, name);
    await mkdir(outDir, { recursive: true });

    const pkgJson = await readJson(join(pkgDir, "package.json"), `packages/${name}/package.json`);
    rewriteWorkspaceDeps(pkgJson, `@kiko-workbench/${name}`);
    await writeFile(
      join(outDir, "package.json"),
      JSON.stringify(pkgJson, null, 2) + "\n",
      "utf8",
    );

    await cp(join(pkgDir, "dist"), join(outDir, "dist"), { recursive: true });
    console.log(`[vendor-sdk] ${name}: package.json + dist/ → ${outDir}`);
  }

  // 3.5 规范文档落盘（vendor/spec/）：Agent 经 sdk.spec 能力消费。
  // 源文件缺失直接失败（宁缺毋滥：落盘半套物料会让 sdk.spec 在安装版
  // 环境静默不可用，Agent 拿不到排障线索）。
  try {
    await stat(specDocSource);
  } catch {
    throw new Error(`插件开发规范源文件缺失（${specDocSource} 不存在），无法落盘物料`);
  }
  await mkdir(dirname(specDocOut), { recursive: true });
  await cp(specDocSource, specDocOut);
  console.log(`[vendor-sdk] spec: ${SPEC_DOC_NAME} → ${specDocOut}`);

  // 4. vendor/.gitignore：物料为构建产物，整体不入库（源头是 workspace 包，
  //    入库必然与源漂移）；保留 .gitignore 自身使目录结构可追溯
  await writeFile(join(vendorRoot, ".gitignore"), "*\n!.gitignore\n", "utf8");

  // 5. 摘要输出（人工核对版本同步；运行时由 sdk.manifest 能力动态统计）
  for (const name of VENDOR_PACKAGES) {
    const pkgJson = await readJson(join(vendorRoot, name, "package.json"), `vendor ${name}`);
    const { fileCount, totalBytes } = await summarizeDir(join(vendorRoot, name));
    console.log(
      `[vendor-sdk] 摘要 @kiko-workbench/${name}@${pkgJson.version}: ${fileCount} 文件 / ${totalBytes} 字节`,
    );
  }
  console.log(`[vendor-sdk] 完成：${VENDOR_PACKAGES.length} 个包 → ${vendorRoot}`);
}

main().catch((e) => {
  console.error("[vendor-sdk] 失败：", e.message);
  process.exit(1);
});
