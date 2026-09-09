/**
 * 内置插件 bundle 脚本（M2-10a 打包链前置步骤）
 *
 * 为什么 bundle：插件运行时依赖 plugin-sdk（RpcError）与第三方库
 * （document → docx），而打包产物中插件目录位于 resources/plugins——
 * asar 外无 node_modules 解析链，ESM 动态 import 裸包名必然失败。
 * bundle 成自包含单文件后，host（utilityProcess）动态 import 绝对
 * 路径即可加载，resources 目录零外部依赖。
 *
 * 产物布局（electron-builder extraResources 直接整体引用）：
 *   apps/desktop/build-resources/plugins/<id>/
 *     ├── manifest.json      （原样复制）
 *     ├── capabilities.json  （原样复制）
 *     └── dist/index.js      （esbuild bundle，external 无）
 *   sdk 分发插件额外附带：
 *     └── vendor/            （整体复制：plugin-sdk + protocol 构建物料，
 *                             sdk 插件对外分发的开发物料，方案 4.4）
 *
 * 开发态不受影响：registry 开发态仍扫 packages/plugins（tsc 产物），
 * bundle 仅打包链使用。
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本位于 apps/desktop/scripts/ → desktop 是上一层，repoRoot 再上两层
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const pluginsRoot = join(repoRoot, "packages", "plugins");
const outRoot = join(desktopDir, "build-resources", "plugins");

/** 内置插件清单（与 packages/plugins 目录一一对应） */
const PLUGIN_IDS = ["file", "document", "dev", "sdk"];

/**
 * 需要附带 vendor/ 物料目录的插件（方案 4.4 要点 4：sdk 分发插件特例）。
 * sdk 的 vendor/（plugin-sdk + protocol 构建产物）是它对外分发的开发
 * 物料，必须整体复制进安装包——现有脚本仅复制单文件产物，故特例扩展。
 */
const VENDOR_PLUGIN_IDS = new Set(["sdk"]);

async function main() {
  // 清理重建（防残留旧产物混入安装包）
  await rm(outRoot, { recursive: true, force: true });

  for (const id of PLUGIN_IDS) {
    const srcDir = join(pluginsRoot, id);
    const outDir = join(outRoot, id);
    await mkdir(join(outDir, "dist"), { recursive: true });

    // bundle：ESM 输出 + platform node + 全依赖 inline（零 external）
    const result = await build({
      entryPoints: [join(srcDir, "src", "index.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22", // Electron 35 内嵌 Node 22.16（utilityProcess 子进程）
      outfile: join(outDir, "dist", "index.js"),
      // ESM 单文件注意：bundle 内含 default export 的插件实例工厂 +
      // 单例 default 导出（host 的动态 import 两种取法都要兼容——
      // esbuild 保持原模块语义，无需特殊处理）
      minify: false, // 排障友好优先（体积非当前瓶颈）
      metafile: false,
      logLevel: "info",
    });
    if (result.errors.length > 0) {
      throw new Error(`插件 ${id} bundle 失败`);
    }

    // manifest + capabilities 原样复制（registry 扫描入口）
    await cp(join(srcDir, "manifest.json"), join(outDir, "manifest.json"));
    await cp(join(srcDir, "capabilities.json"), join(outDir, "capabilities.json"));

    // P-003（微应用前端资产）：声明 contributes.ui 的插件附带 web/ 目录
    // （静态 HTML/CSS/JS，不参与 esbuild bundle）。整体复制进安装包——
    // registry 注册期校验 uiEntry 文件存在性，缺失会把插件打成 error 态
    const webSrc = join(srcDir, "web");
    if (existsSync(webSrc)) {
      await cp(webSrc, join(outDir, "web"), { recursive: true });
      console.log(`[bundle-plugins] ${id}: web/ 前端资产 → ${join(outDir, "web")}`);
    }

    // vendor 物料整体复制（sdk 特例）：bundle 产物内插件以 import.meta.url
    // 定位自身目录，dist 上一级即插件根——vendor 落在 outDir/vendor/ 与
    // 运行时 VENDOR_ROOT 解析一致（安装版 resources/plugins/sdk/vendor/…）
    if (VENDOR_PLUGIN_IDS.has(id)) {
      const vendorSrc = join(srcDir, "vendor");
      try {
        await cp(vendorSrc, join(outDir, "vendor"), { recursive: true });
      } catch (e) {
        // 物料缺失多为跳过了 vendor:sdk 步骤：给出可修复提示而非裸 ENOENT
        // （cause 保留原始错误链，preserve-caught-error）
        throw new Error(
          `插件 ${id} 的 vendor 物料缺失（${vendorSrc}）：` +
            `请先执行 pnpm run vendor:sdk（dist 链已内置该步骤）。原始错误：${e.message}`,
          { cause: e },
        );
      }
      console.log(`[bundle-plugins] ${id}: vendor/ 物料整体复制 → ${join(outDir, "vendor")}`);
    }

    console.log(`[bundle-plugins] ${id}: bundle + manifest/capabilities → ${outDir}`);
  }

  // S8（零 Shell 自举方案 3.4）：esbuild CLI 二进制复制进 build-resources
  // esbuild/——electron-builder extraResources 把它分发到安装目录
  // resources/esbuild/，bootstrap.resolveEsbuildBinary 三级解析消费。
  // sdk.build 在插件进程内 spawn 该二进制完成零 shell 构建（esbuild JS
  // API 无法被 bundle，CLI 是唯一可分发形态）。
  await mkdir(join(desktopDir, "build-resources", "esbuild"), { recursive: true });
  const esbuildBinary = createRequire(import.meta.url).resolve("@esbuild/win32-x64/esbuild.exe");
  await cp(esbuildBinary, join(desktopDir, "build-resources", "esbuild", "esbuild.exe"));
  console.log(`[bundle-plugins] esbuild CLI → build-resources/esbuild/esbuild.exe`);

  // M3（MCP 适配器自包含分发）：esbuild bundle 成单文件 → build-resources/
  // mcp-adapter/main.js——electron-builder extraResources 分发到安装目录
  // resources/mcp-adapter/，bootstrap.resolveMcpAdapterPath 解析消费。
  // bundle 动机与插件一致：安装目录无 node_modules 解析链（ws / MCP SDK /
  // protocol 全部 inline）。目标 node18 而非 node22——它由用户本机 Node
  // 运行（MCP 客户端 spawn），非 Electron 内嵌运行时，取 MCP SDK 基线。
  const adapterOut = join(desktopDir, "build-resources", "mcp-adapter");
  await mkdir(adapterOut, { recursive: true });
  const adapterResult = await build({
    entryPoints: [join(repoRoot, "packages", "mcp-adapter", "src", "main.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    outfile: join(adapterOut, "main.js"),
    // ESM bundle + CJS 依赖（ws / MCP SDK 传递）共存的关键：内建模块与
    // 可选依赖（bufferutil / utf-8-validate）的运行时 require 经
    // createRequire 委托——Node 内建正常解析，可选依赖 MODULE_NOT_FOUND
    // 由 ws 的 try/catch 吞掉（无 banner 则 esbuild shim 直接抛错崩进程）
    banner: {
      js: [
        "import { createRequire as __kikoCreateRequire } from 'node:module';",
        "const require = __kikoCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    minify: false, // 排障友好优先（体积非当前瓶颈）
    metafile: false,
    logLevel: "info",
  });
  if (adapterResult.errors.length > 0) {
    throw new Error("MCP 适配器 bundle 失败");
  }
  console.log(`[bundle-plugins] mcp-adapter → ${adapterOut}/main.js`);

  console.log(`[bundle-plugins] 完成：${PLUGIN_IDS.length} 个插件 → ${outRoot}`);
}

main().catch((e) => {
  console.error("[bundle-plugins] 失败：", e);
  process.exit(1);
});
