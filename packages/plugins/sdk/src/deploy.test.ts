/**
 * sdk.deploy 能力单测（S10 验收锚点，零 Shell 自举方案 3.2）
 *
 * 验收锚点：
 *   - happy path：三件套复制到 user_plugins_root/<id> + 输出契约
 *   - 幂等覆盖：同 id 重复部署覆盖（迭代场景）
 *   - project_dir 越界 → 50001（resolveSafe 拦截）
 *   - manifest 缺失 / 缺 id 字段 → 50001
 *   - manifest.id 含路径分隔符 → 50001（目标路径注入封死）
 *   - capabilities 不可解析 → 50001
 *   - 构建产物缺失 → 50001 提示先 sdk.build
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkPlugin, _internal } from "./index.js";
import {
  ERROR_CODES,
  RpcError,
  type InvocationContext,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

let workspaceRoot: string;
let userPluginsRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "kiko-deploy-ws-"));
  userPluginsRoot = await mkdtemp(join(tmpdir(), "kiko-deploy-user-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(userPluginsRoot, { recursive: true, force: true });
});

/** fake InvocationContext（deploy 不消费执行上下文） */
function makeCtx(): InvocationContext {
  return {
    progress: () => undefined,
    log: () => undefined,
    isCancelled: () => false,
    artifacts: { save: () => undefined, register: () => undefined },
  };
}

/** 组装已 setup 的插件（workspaceRoot + userPluginsRoot 注入 fixture） */
async function makePlugin() {
  const plugin = createSdkPlugin();
  const pluginCtx: PluginContext = {
    pluginId: "sdk",
    workspaceRoot,
    documentsDir: join(workspaceRoot, "..", "documents"),
    userPluginsRoot,
    esbuildBinaryPath: "",
  };
  await plugin.setup?.(pluginCtx);
  return plugin;
}

/** 预置完整项目目录（manifest/capabilities/dist 三件套就绪） */
async function writeProject(
  manifest = { id: "my-plugin", name: "My Plugin", version: "1.0.0" },
): Promise<void> {
  const projectDir = join(workspaceRoot, "my-plugin");
  await mkdir(join(projectDir, "dist"), { recursive: true });
  await writeFile(join(projectDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
  await writeFile(
    join(projectDir, "capabilities.json"),
    JSON.stringify([
      { id: "my-plugin.echo", input_schema: { type: "object" }, output_schema: { type: "object" } },
    ]),
    "utf-8",
  );
  await writeFile(join(projectDir, "dist", "index.js"), "export default {};", "utf-8");
}

/** 断言 promise 抛 RpcError 且 code 匹配 */
async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcError> {
  try {
    await promise;
    expect.unreachable("应当抛出 RpcError");
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
}

describe("sdk.deploy（S10，零 shell 部署）", () => {
  it("happy path：三件套部署到 user_plugins_root/<id> + 输出契约", async () => {
    await writeProject();
    const plugin = await makePlugin();
    const result = (await plugin.handle(
      "sdk.deploy",
      { project_dir: "my-plugin" },
      makeCtx(),
    )) as { deployed_to: string; files: string[]; rescan_hint: boolean };

    expect(result.deployed_to).toBe(join(userPluginsRoot, "my-plugin"));
    expect(result.files).toEqual(["manifest.json", "capabilities.json", "dist/index.js"]);
    expect(result.rescan_hint).toBe(true);
    // 三件套落位（磁盘形态与 S4 人类轨部署一致）
    for (const f of result.files) {
      const content = await readFile(join(userPluginsRoot, "my-plugin", f), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("幂等覆盖：同 id 重复部署覆盖旧文件", async () => {
    await writeProject();
    const plugin = await makePlugin();
    await plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx());
    // 迭代：改 manifest version 后重部署 → 覆盖生效
    await writeProject({ id: "my-plugin", name: "My Plugin", version: "2.0.0" });
    await plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx());
    const manifest = JSON.parse(
      await readFile(join(userPluginsRoot, "my-plugin", "manifest.json"), "utf-8"),
    );
    expect(manifest.version).toBe("2.0.0");
  });

  it("project_dir 越界（../..） → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "../../evil" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("manifest 缺失 → 50001 带修复提示", async () => {
    const projectDir = join(workspaceRoot, "no-manifest");
    await mkdir(join(projectDir, "dist"), { recursive: true });
    await writeFile(join(projectDir, "capabilities.json"), "[]", "utf-8");
    await writeFile(join(projectDir, "dist", "index.js"), "export default {};", "utf-8");
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "no-manifest" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("manifest.json");
  });

  it("manifest 缺 id 字段 → 50001", async () => {
    await writeProject({ name: "No Id", version: "1.0.0" } as { name: string; version: string });
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("manifest.id 含路径分隔符 → 50001（目标路径注入封死）", async () => {
    await writeProject({ id: "evil/../evil2", name: "Evil", version: "1.0.0" });
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("非法 plugin id");
  });

  it("capabilities 不可解析 → 50001", async () => {
    const projectDir = join(workspaceRoot, "my-plugin");
    await mkdir(join(projectDir, "dist"), { recursive: true });
    await writeFile(
      join(projectDir, "manifest.json"),
      JSON.stringify({ id: "my-plugin", name: "My Plugin", version: "1.0.0" }),
      "utf-8",
    );
    await writeFile(join(projectDir, "capabilities.json"), "not json", "utf-8");
    await writeFile(join(projectDir, "dist", "index.js"), "export default {};", "utf-8");
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("capabilities.json");
  });

  it("构建产物缺失 → 50001 提示先 sdk.build", async () => {
    const projectDir = join(workspaceRoot, "no-dist");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "manifest.json"),
      JSON.stringify({ id: "no-dist", name: "No Dist", version: "1.0.0" }),
      "utf-8",
    );
    await writeFile(join(projectDir, "capabilities.json"), "[]", "utf-8");
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "no-dist" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("sdk.build");
  });
});

describe("sdk.deploy 微应用资产（P-003 对齐：contributes.ui 声明驱动）", () => {
  /** 预置微应用项目（三件套 + web/ 前端资产 + manifest.ui 声明） */
  async function writeMicroProject(
    manifestExtra: Record<string, unknown> = {},
  ): Promise<void> {
    await writeProject({
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      contributes: { ui: { entry: "web/index.html" } },
      ...manifestExtra,
    } as Parameters<typeof writeProject>[0]);
    await mkdir(join(workspaceRoot, "my-plugin", "web"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "my-plugin", "web", "index.html"),
      "<!doctype html><html><body>micro</body></html>",
      "utf-8",
    );
    await writeFile(
      join(workspaceRoot, "my-plugin", "web", "app.js"),
      "console.log('micro');",
      "utf-8",
    );
  }

  it("声明 ui + web/ 就绪 → 三件套 + web/ 整体复制（registry uiEntry 校验可过）", async () => {
    await writeMicroProject();
    const plugin = await makePlugin();
    const result = (await plugin.handle(
      "sdk.deploy",
      { project_dir: "my-plugin" },
      makeCtx(),
    )) as { files: string[] };

    // 输出契约：files 体现 web/ 目录（Agent 核对部署完整性锚点）
    expect(result.files).toEqual([
      "manifest.json",
      "capabilities.json",
      "dist/index.js",
      "web/",
    ]);
    // 磁盘形态：web/ 双文件落位（入口 + 外链脚本——CSP 禁内联的布局）
    const html = await readFile(
      join(userPluginsRoot, "my-plugin", "web", "index.html"),
      "utf-8",
    );
    expect(html).toContain("micro");
    expect(
      await readFile(join(userPluginsRoot, "my-plugin", "web", "app.js"), "utf-8"),
    ).toContain("micro");
  });

  it("声明 ui 但 entry 文件缺失 → 50001 部署前拦截（目标无半成品目录）", async () => {
    // manifest 声明了 ui 但 web/ 忘了写（Agent 漏 file.write 的典型现场）
    await writeProject({
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      contributes: { ui: { entry: "web/index.html" } },
    } as Parameters<typeof writeProject>[0]);
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("contributes.ui.entry 文件不存在");
    // 部署前拦截语义：目标目录不应出现（否则 rescan 扫到 error 态半成品）
    const entries = await readdir(userPluginsRoot);
    expect(entries).not.toContain("my-plugin");
  });

  it("entry 穿越路径（web/../../evil.html）→ 50001 拦截", async () => {
    await writeMicroProject({
      contributes: { ui: { entry: "web/../../evil.html" } },
    });
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.deploy", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("非法相对路径");
  });

  it("无 ui 声明 → 部署行为不变（files 恰三件套，不碰多余目录）", async () => {
    // 项目目录存在 web/ 但 manifest 未声明 ui（资产残留）→ 不复制
    await writeProject();
    await mkdir(join(workspaceRoot, "my-plugin", "web"), { recursive: true });
    await writeFile(join(workspaceRoot, "my-plugin", "web", "index.html"), "x", "utf-8");
    const plugin = await makePlugin();
    const result = (await plugin.handle(
      "sdk.deploy",
      { project_dir: "my-plugin" },
      makeCtx(),
    )) as { files: string[] };
    expect(result.files).toEqual(["manifest.json", "capabilities.json", "dist/index.js"]);
    const entries = await readdir(join(userPluginsRoot, "my-plugin"));
    expect(entries).not.toContain("web");
  });
});
