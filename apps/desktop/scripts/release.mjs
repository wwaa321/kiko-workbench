/**
 * electron-builder 包装脚本（M2-10a 打包链末段；dist 命令入口）
 *
 * 为什么不直接调 electron-builder：打包需要两类网络下载，本机环境
 * 均有坑——
 *   1. Electron 发行包 zip 默认从 GitHub Releases 拉取，直连超时；
 *      经 ELECTRON_MIRROR 走 npmmirror 镜像。
 *   2. electron-builder 工具链（NSIS / winCodeSign）与 Electron zip
 *      的缓存缺省位于 %LOCALAPPDATA%（AppData 写受限的沙箱会失败）；
 *      经 ELECTRON_CACHE / ELECTRON_BUILDER_CACHE 重定向到项目内
 *      .cache/（已 gitignore，且首次下载后跨次构建复用、离线可用）。
 *
 * 这三个变量在 M2-10a 打包时是手工注入的会话环境变量，未固化导致
 * 后续 dist 重新回源下载（用户实测暴露）；本脚本以绝对路径固化
 * （相对 cwd 的写法在 --filter / -C 两种调用形态下不可靠）。
 *
 * 用法：node scripts/release.mjs（经 pnpm dist 触发；参数原样转发）。
 */
import { spawn } from "node:child_process";
import { readdir, rm, mkdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// 本脚本位于 apps/desktop/scripts/ → desktop 是上一层，repoRoot 再上两层
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");

/** electron-builder 可执行入口（devDependency bin，不经 shell 直接定位） */
const requireFromDesktop = createRequire(resolve(desktopDir, "package.json"));
const builderBin = requireFromDesktop.resolve("electron-builder/cli.js");

/**
 * 预置 winCodeSign 缓存（rcedit 图标嵌入的依赖；electron-builder#4299 规避）
 *
 * 背景：electron-builder.json 启用图标嵌入后，rcedit 从 winCodeSign
 * 工具包取用；app-builder 下载该包后用 7za 解压，包内 darwin/ 有两个
 * symlink（libcrypto.dylib / libssl.dylib），普通权限 Windows 解压必
 * 失败（7za exit 2 → 构建失败且每次重试都重新下载 5.6MB）。
 *
 * 规避原理（app-builder pkg/download/artifactDownloader.go）：
 * 缓存判定 CheckCache 仅检查最终目录是否存在、无内容校验 → 抢先把
 * 「排除 darwin/ 的解压结果」落位到缓存路径，electron-builder 直接
 * 复用。darwin/ 仅 macOS 打包使用，Windows 构建不依赖。
 *
 * @param {string} cacheRoot ELECTRON_BUILDER_CACHE 根目录（项目内 .cache）
 */
const WIN_CODE_SIGN_VERSION = "2.6.0";

async function ensureWinCodeSignCache(cacheRoot) {
  const finalDir = resolve(cacheRoot, "winCodeSign", `winCodeSign-${WIN_CODE_SIGN_VERSION}`);
  // 缓存命中：直接复用（含历史构建解压成功或手动修复过的目录）
  if (existsSync(finalDir)) return;

  // 7zip-bin 是 electron-builder 的传递依赖，位于 pnpm 隔离目录内，
  // 版本号会随 lockfile 变化 → 按目录前缀动态定位而非硬编码
  const pnpmDir = resolve(repoRoot, "node_modules", ".pnpm");
  const sevenZipEntry = (await readdir(pnpmDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("7zip-bin@"))
    .map((e) => e.name)
    .sort()
    .at(-1);
  if (sevenZipEntry == null) {
    throw new Error("[release] 未找到 7zip-bin（electron-builder 传递依赖），无法预置 winCodeSign 缓存");
  }
  const sevenZip = resolve(pnpmDir, sevenZipEntry, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  if (!existsSync(sevenZip)) {
    throw new Error(`[release] 7za.exe 不存在：${sevenZip}`);
  }

  // 从 npmmirror 镜像下载压缩包（GitHub 直连超时的既定绕行方案）
  // createWriteStream 不会自动创建父目录，须先 mkdir（缓存根可能首次构建）
  await mkdir(dirname(finalDir), { recursive: true });
  const archive = `${finalDir}.7z`;
  const url = `https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-${WIN_CODE_SIGN_VERSION}/winCodeSign-${WIN_CODE_SIGN_VERSION}.7z`;
  const res = await fetch(url);
  if (!res.ok || res.body == null) {
    throw new Error(`[release] winCodeSign 下载失败：HTTP ${res.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));

  // 解压直接落位最终缓存目录；-x!darwin 排除含 symlink 的目录（失败根源）
  const exitCode = await new Promise((onClose, onError) => {
    const child = spawn(sevenZip, ["x", "-bd", archive, `-o${finalDir}`, "-x!darwin"], { stdio: "inherit" });
    child.on("error", onError);
    child.on("close", onClose);
  }).catch((e) => {
    throw new Error(`[release] 7za 启动失败：${e.message}`);
  });
  // 解压失败时清理半成品（目录已删除可安全重建），下次构建重试
  await rm(archive, { force: true }).catch(() => {});
  if (exitCode !== 0) {
    await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`[release] winCodeSign 解压失败：7za exit ${exitCode}`);
  }
  console.log(`[release] winCodeSign-${WIN_CODE_SIGN_VERSION} 缓存已预置（排除 darwin/，#4299 规避）：${finalDir}`);
}

async function main() {
  // 图标嵌入依赖 winCodeSign：构建前确保缓存就位（幂等，命中即跳过）
  await ensureWinCodeSignCache(resolve(repoRoot, ".cache", "electron-builder"));

  const child = spawn(process.execPath, [builderBin, ...process.argv.slice(2)], {
    cwd: desktopDir, // electron-builder 要求在应用目录运行（读 electron-builder.json）
    stdio: "inherit",
    env: {
      ...process.env,
      // Electron 发行包镜像：npmmirror（GitHub 直连超时的既定绕行方案）
      ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
      // Electron zip 缓存（@electron/get）：项目内 .cache/electron
      ELECTRON_CACHE: resolve(repoRoot, ".cache", "electron"),
      // electron-builder 工具链缓存（NSIS / winCodeSign）：项目内 .cache/electron-builder
      ELECTRON_BUILDER_CACHE: resolve(repoRoot, ".cache", "electron-builder"),
      // 工具链下载镜像：同 GitHub 直连超时问题；启用图标嵌入（rcedit）
      // 后 winCodeSign 为必下载项，缺省源同样走 GitHub Releases
      ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
    },
  });

  // 信号转发：Ctrl+C / 终止时同步击穿子进程，防孤儿构建进程
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }

  child.on("error", (e) => {
    // spawn 层失败（如 builderBin 解析异常导致无法启动）：快死并给出定位线索
    console.error(`[release] electron-builder 启动失败：${e.message}`);
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code ?? 1);
  });
}

// async 入口兜底：缓存预置 / spawn 失败时快死并给出定位线索
main().catch((e) => {
  console.error(`[release] 构建前置步骤失败：${e.message}`);
  process.exit(1);
});
