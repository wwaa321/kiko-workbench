/**
 * 插件包导入 / 导出单测（第三方插件管理）
 *
 * 验收锚点：
 *   - 导入 happy path（zip 根 manifest + 唯一顶层目录兜底两种格式）
 *   - zip slip 防护（`..` 穿越 / 绝对路径 / 盘符段 → -32602 + 部署回滚）
 *   - manifest 校验（缺失 / 损坏 JSON / 非法 id 目录名）
 *   - ID 冲突排查（内置 / 已注册第三方 / 未注册残留目录 → 40008）
 *   - 导出 → 卸载 → 再导入 roundtrip（分享分发生命周期闭环）
 *   - rmWithRetry（正常删除 / 不存在目录 force 语义）
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { CapabilityRegistry } from "./registry.js";
import { exportPluginToZip, importPluginFromZip, rmWithRetry } from "./plugin-package.js";
import { PluginConfigStore, type ConfigurationSchema } from "./config-store.js";
import { ERROR_CODES, type CapabilityDefinition } from "@kiko-workbench/protocol";

/** 含 secret 的基准配置 schema（P-002 导出隔离用例；与 config-store 基准同构） */
const SCHEMA: ConfigurationSchema = {
  type: "object",
  properties: {
    api_key: { type: "string", title: "API Key", "x-kiko-secret": true },
  },
  required: ["api_key"],
};

/** 测试根目录（每个用例独立临时目录） */
let root: string;
/** 内置插件根（roots[0]） */
let builtinRoot: string;
/** 第三方插件根（roots[1]，导入部署目标） */
let userRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kiko-plugin-pkg-"));
  builtinRoot = join(root, "builtin");
  userRoot = join(root, "user");
  await mkdir(builtinRoot, { recursive: true });
  await mkdir(userRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 基准能力定义工厂 */
function cap(id: string, name: string, description: string): CapabilityDefinition {
  return {
    id,
    name,
    description,
    input_schema: { type: "object", properties: {} },
    output_schema: { type: "object", properties: {} },
  };
}

/**
 * 写一个完整插件目录（manifest + capabilities + dist 产物）。
 * @param dir 目标目录（已含插件名的父目录 + id 由调用方决定）
 */
async function writePluginFiles(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: id.toUpperCase(),
      description: `${id} plugin`,
      version: "1.0.0",
      entry: "dist/index.js",
      permissions: [],
    }),
    "utf-8",
  );
  await writeFile(
    join(dir, "capabilities.json"),
    JSON.stringify([cap(`${id}.run`, "Run", `run ${id}`)]),
    "utf-8",
  );
  await writeFile(join(dir, "dist", "index.js"), "// bundled", "utf-8");
}

/** 双根注册表（内置 + 第三方）+ 完成初始扫描 */
async function makeRegistry(): Promise<CapabilityRegistry> {
  const registry = new CapabilityRegistry(builtinRoot, userRoot);
  await registry.scan();
  return registry;
}

/** 把目录内容打包为 zip（目录内容置于 zip 根——导出同款格式） */
function zipDirContents(dir: string, zipPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  zip.writeZip(zipPath);
}

describe("importPluginFromZip：导入校验与部署", () => {
  it("zip 根 manifest（导出格式）→ 部署 + rescan 注册为第三方插件", async () => {
    // 在 userRoot 外准备插件目录（模拟分享者机器上的插件），打包
    const srcDir = join(root, "src-plugin");
    await writePluginFiles(srcDir, "shared-tool");
    const zipPath = join(root, "shared-tool.zip");
    zipDirContents(srcDir, zipPath);

    const registry = await makeRegistry();
    const outcome = await importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath);

    expect(outcome.plugin_id).toBe("shared-tool");
    expect(outcome.rescan.added).toContain("shared-tool");
    // 注册为 enabled 第三方插件
    expect(registry.getPluginSource("shared-tool")).toBe("third_party");
    expect(registry.getPlugin("shared-tool")?.status).toBe("enabled");
    // 文件落盘（含子目录 dist/）
    expect(existsSync(join(userRoot, "shared-tool", "dist", "index.js"))).toBe(true);
  });

  it("唯一顶层目录 zip（用户手工打包形态）→ 前缀剥离后正常部署", async () => {
    // 手工 zip 常见形态：压缩的是"插件文件夹"而非其内容
    const pkgDir = join(root, "pkg");
    await writePluginFiles(join(pkgDir, "shared-tool"), "shared-tool");
    const zipPath = join(root, "folder-zip.zip");
    zipDirContents(pkgDir, zipPath);

    const registry = await makeRegistry();
    const outcome = await importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath);

    expect(outcome.plugin_id).toBe("shared-tool");
    // manifest 落在 userRoot/shared-tool/manifest.json（前缀已剥）
    expect(existsSync(join(userRoot, "shared-tool", "manifest.json"))).toBe(true);
    expect(registry.getPlugin("shared-tool")?.status).toBe("enabled");
  });

  it("zip slip：entry 含 `..` 穿越 → -32602 拒绝 + 目标目录回滚 + 无越界文件", async () => {
    const srcDir = join(root, "evil-src");
    await writePluginFiles(srcDir, "evil");
    const zipPath = join(root, "evil.zip");
    zipDirContents(srcDir, zipPath);
    // 注入穿越 entry：adm-zip 的 addFile 会净化 `../` 前缀（写入侧安全），
    // 恶意包来自外部工具时无此净化——直接改 entry 名模拟野包（读取侧
    // entryName 原样保留，解包校验是唯一防线）
    const zip = new AdmZip(zipPath);
    zip.addFile("escape.txt", Buffer.from("pwned", "utf-8"));
    zip.getEntries().find((e) => e.entryName === "escape.txt")!.entryName = "../escape.txt";
    zip.writeZip(zipPath);

    const registry = await makeRegistry();
    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("非法路径") });

    // 部署回滚：目标目录不残留（否则阻塞同 id 重试）
    expect(existsSync(join(userRoot, "evil"))).toBe(false);
    // 越界文件未写出（root 下无 escape.txt）
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
    expect(existsSync(join(userRoot, "..", "escape.txt"))).toBe(false);
    // 注册表未受污染
    expect(registry.getPlugin("evil")).toBeUndefined();
  });

  it("manifest 缺失 / 损坏 / 缺必填字段 → -32602", async () => {
    const registry = await makeRegistry();

    // 无 manifest 的 zip
    const noManifest = join(root, "no-manifest.zip");
    new AdmZip().writeZip(noManifest);
    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, noManifest),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("manifest") });

    // manifest 损坏 JSON
    const badJson = join(root, "bad-json.zip");
    const z1 = new AdmZip();
    z1.addFile("manifest.json", Buffer.from("{oops", "utf-8"));
    z1.writeZip(badJson);
    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, badJson),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("JSON") });

    // 缺 version 字段
    const noVersion = join(root, "no-version.zip");
    const z2 = new AdmZip();
    z2.addFile(
      "manifest.json",
      Buffer.from(JSON.stringify({ id: "nv", name: "NV" }), "utf-8"),
    );
    z2.writeZip(noVersion);
    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, noVersion),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("manifest.id 非法目录名（路径分隔符 / 盘符）→ -32602；`a..b` 合法单段名放行", async () => {
    const registry = await makeRegistry();

    for (const badId of ["../escape", "a/b", "a\\b", "C:evil"]) {
      const zipPath = join(root, `bad-${badId.replace(/[^a-z.]/gi, "_")}.zip`);
      const z = new AdmZip();
      z.addFile(
        "manifest.json",
        Buffer.from(JSON.stringify({ id: badId, name: "X", version: "1.0.0" }), "utf-8"),
      );
      z.writeZip(zipPath);
      await expect(
        importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("目录名") });
    }

    // 单段名 a..b 合法（与项目"目录名单段校验"约定一致——允许多个点）
    const okZip = join(root, "ok.zip");
    const srcDir = join(root, "dotted-src");
    await writePluginFiles(srcDir, "a..b");
    zipDirContents(srcDir, okZip);
    const outcome = await importPluginFromZip({ registry, userPluginsRoot: userRoot }, okZip);
    expect(outcome.plugin_id).toBe("a..b");
    expect(registry.getPlugin("a..b")?.status).toBe("enabled");
  });

  it("ID 与内置插件冲突 → 40008（明确提示内置来源）", async () => {
    // 内置根注册一个 document 插件
    await writePluginFiles(join(builtinRoot, "document"), "document");
    const registry = await makeRegistry();
    expect(registry.getPluginSource("document")).toBe("builtin");

    // 同 id 的第三方 zip
    const srcDir = join(root, "dup-src");
    await writePluginFiles(srcDir, "document");
    const zipPath = join(root, "dup.zip");
    zipDirContents(srcDir, zipPath);

    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PLUGIN_ID_CONFLICT,
      message: expect.stringContaining("内置插件"),
    });
  });

  it("ID 与已注册第三方插件冲突 → 40008", async () => {
    const srcDir = join(root, "src-plugin");
    await writePluginFiles(srcDir, "shared-tool");
    const zipPath = join(root, "shared-tool.zip");
    zipDirContents(srcDir, zipPath);

    const registry = await makeRegistry();
    await importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath);
    // 同 id 二次导入 → 冲突拒绝
    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PLUGIN_ID_CONFLICT,
      message: expect.stringContaining("第三方插件"),
    });
  });

  it("未注册的同名残留目录（部署中断现场）→ 40008 拒绝", async () => {
    // 残留目录须在 scan 之后出现——scan 会把磁盘目录注册为 error 态插件
    // （哪怕没有 manifest），那走的是"已注册第三方冲突"路径；真正的残留
    // 现场是：上次导入在 mkdir 与 rescan 之间中断（进程崩溃等）
    const srcDir = join(root, "src-plugin");
    await writePluginFiles(srcDir, "leftover");
    const zipPath = join(root, "leftover.zip");
    zipDirContents(srcDir, zipPath);

    const registry = await makeRegistry();
    // scan 后模拟中断现场：目录存在但未注册
    await mkdir(join(userRoot, "leftover"));
    await writeFile(join(userRoot, "leftover", "anything.txt"), "x", "utf-8");
    expect(registry.getPlugin("leftover")).toBeUndefined();

    await expect(
      importPluginFromZip({ registry, userPluginsRoot: userRoot }, zipPath),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PLUGIN_ID_CONFLICT,
      message: expect.stringContaining("残留"),
    });
  });
});

describe("导出 / 卸载生命周期 roundtrip", () => {
  it("导入 → 导出 → 卸载（rm + unregister）→ 再导入导出包 → 注册成功", async () => {
    // 1. 导入
    const srcDir = join(root, "src-plugin");
    await writePluginFiles(srcDir, "shared-tool");
    const importZip = join(root, "import.zip");
    zipDirContents(srcDir, importZip);
    const registry = await makeRegistry();
    await importPluginFromZip({ registry, userPluginsRoot: userRoot }, importZip);
    expect(registry.getPlugin("shared-tool")?.status).toBe("enabled");

    // 2. 导出（分享包）
    const exportZip = join(root, "shared-tool-1.0.0.zip");
    exportPluginToZip(join(userRoot, "shared-tool"), exportZip);
    // 导出格式：manifest 在 zip 根
    const exported = new AdmZip(exportZip);
    expect(
      exported.getEntries().some((e) => e.entryName === "manifest.json"),
    ).toBe(true);

    // 3. 卸载：删目录 + 移除注册（ipc uninstall 的核心两步，进程 dispose 由宿主接）
    expect(await rmWithRetry(join(userRoot, "shared-tool"))).toBeNull();
    registry.unregisterPlugin("shared-tool");
    expect(registry.getPlugin("shared-tool")).toBeUndefined();

    // 4. 再导入导出包（他人收到分享包的场景）
    const outcome = await importPluginFromZip(
      { registry, userPluginsRoot: userRoot },
      exportZip,
    );
    expect(outcome.plugin_id).toBe("shared-tool");
    expect(registry.getPlugin("shared-tool")?.status).toBe("enabled");
    // 内容一致（dist 产物随包往返）
    const dist = readFileSync(join(userRoot, "shared-tool", "dist", "index.js"), "utf-8");
    expect(dist).toBe("// bundled");
  });

  it("已保存配置的插件导出 → zip 不含任何配置内容（P-002：配置与插件目录解耦锁定）", async () => {
    // 场景：宿主已在独立配置根保存含 secret 的配置（真实 PluginConfigStore
    // 写盘，路径 <configRoot>/<pluginId>.json）。锁定导出语义：分享包只含
    // 插件本体——secret 不随包泄露、接收方从零配置（方案草案 §3.2）。
    const srcDir = join(root, "src-plugin");
    await writePluginFiles(srcDir, "shared-tool");
    const importZip = join(root, "import.zip");
    zipDirContents(srcDir, importZip);
    const registry = await makeRegistry();
    await importPluginFromZip({ registry, userPluginsRoot: userRoot }, importZip);

    // 独立配置根（模拟 userData/plugin-config，与 userRoot 平级互不包含）
    const configRoot = join(root, "plugin-config");
    const store = new PluginConfigStore(configRoot);
    const saved = await store.save("shared-tool", SCHEMA, { api_key: "test-key-123" });
    expect(saved.ok).toBe(true); // 前置：配置确已落盘（圆点应亮的现场）

    const exportZip = join(root, "shared-tool-configured.zip");
    exportPluginToZip(join(userRoot, "shared-tool"), exportZip);

    // 断言 1：zip entry 精确等于插件文件集（无任何配置文件混入）
    // （isDirectory 是 adm-zip 0.6 的 entry 属性而非方法，与源码 178 行同用法）
    const entryNames = new AdmZip(exportZip)
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName.replace(/\\/g, "/"));
    expect(entryNames.sort()).toEqual(
      ["manifest.json", "capabilities.json", "dist/index.js"].sort(),
    );
    // 断言 2：全 entry 内容不含 secret 值（防内容级泄露）
    const leaked = new AdmZip(exportZip)
      .getEntries()
      .filter((e) => !e.isDirectory)
      .some((e) => e.getData().toString("utf-8").includes("sk-secret-123"));
    expect(leaked).toBe(false);
  });

  it("微应用插件导出含 web/ 前端资产 + 再导入 uiEntry 注册成功（P-003）", async () => {
    // 场景：声明 contributes.ui 的微应用插件分享分发——web/ 静态资产
    // （HTML/CSS/JS，不参与 bundle）必须随包往返，否则接收方注册期
    // assertUiEntry 校验文件不存在 → 插件直接 error 态（P-003 缺陷现场）
    const srcDir = join(root, "src-micro");
    await writePluginFiles(srcDir, "micro-tool");
    // 微应用三件套（dev 插件同款形态）
    await mkdir(join(srcDir, "web"), { recursive: true });
    await writeFile(
      join(srcDir, "web", "index.html"),
      "<!doctype html><html><body>micro</body></html>",
      "utf-8",
    );
    await writeFile(join(srcDir, "web", "app.js"), "console.log('micro');", "utf-8");
    // manifest 补 contributes.ui 声明（writePluginFiles 基线不含）
    const manifestPath = join(srcDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.contributes = { ui: { entry: "web/index.html" } };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

    // 1. 导入 → uiEntry 注册（web/ 随包落盘，注册期存在性校验通过）
    const importZip = join(root, "micro-import.zip");
    zipDirContents(srcDir, importZip);
    const registry = await makeRegistry();
    await importPluginFromZip({ registry, userPluginsRoot: userRoot }, importZip);
    expect(registry.getPlugin("micro-tool")?.uiEntry).toBe("web/index.html");

    // 2. 导出 → zip 含全部 web/ 资产（分享包可运行微应用的完整性锁定）
    const exportZip = join(root, "micro-export.zip");
    exportPluginToZip(join(userRoot, "micro-tool"), exportZip);
    const entryNames = new AdmZip(exportZip)
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName.replace(/\\/g, "/"));
    expect(entryNames.sort()).toEqual(
      [
        "manifest.json",
        "capabilities.json",
        "dist/index.js",
        "web/index.html",
        "web/app.js",
      ].sort(),
    );

    // 3. 卸载 → 再导入导出包 → uiEntry 仍注册（微应用生命周期闭环）
    expect(await rmWithRetry(join(userRoot, "micro-tool"))).toBeNull();
    registry.unregisterPlugin("micro-tool");
    const outcome = await importPluginFromZip(
      { registry, userPluginsRoot: userRoot },
      exportZip,
    );
    expect(outcome.plugin_id).toBe("micro-tool");
    expect(registry.getPlugin("micro-tool")?.uiEntry).toBe("web/index.html");
  });
});

describe("rmWithRetry：删除重试", () => {
  it("存在目录 → 删除成功返回 null", async () => {
    const dir = join(root, "to-delete");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "f.txt"), "x", "utf-8");
    expect(await rmWithRetry(dir)).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("不存在目录 → force 语义静默成功（幂等）", async () => {
    expect(await rmWithRetry(join(root, "never-existed"))).toBeNull();
  });
});

describe("getPluginSource：来源判定（UI 卸载保护数据源）", () => {
  it("内置根 → builtin；第三方根 → third_party；未注册 → undefined", async () => {
    await writePluginFiles(join(builtinRoot, "document"), "document");
    await writePluginFiles(join(userRoot, "shared-tool"), "shared-tool");
    const registry = await makeRegistry();

    expect(registry.getPluginSource("document")).toBe("builtin");
    expect(registry.getPluginSource("shared-tool")).toBe("third_party");
    expect(registry.getPluginSource("ghost")).toBeUndefined();
  });
});
