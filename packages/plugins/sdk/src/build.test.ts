/**
 * sdk.build 能力单测（S9 验收锚点，零 Shell 自举方案 3.1）
 *
 * 验收锚点：
 *   - happy path：真实 esbuild CLI bundle → 产物存在 / 零裸包名 import /
 *     entry+size 输出契约
 *   - esbuildBinaryPath 未注入 → 50001 明示（不裸抛 spawn ENOENT）
 *   - project_dir 越界（../..） → 50001（resolveSafe 拦截）
 *   - 入口缺失 → 50001 带修复提示
 *   - 产物裸包名 import → 50001（自包含契约）
 *
 * 测试策略：走 handle 全链路（setup 注入 fixture ctx）+ 真实开发态
 * esbuild 二进制（node_modules/.pnpm 内 @esbuild/win32-x64 包）——
 * alias 指向 fixture vendor（模拟物料），与生产仅路径差异。
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkPlugin, _internal } from "./index.js";
import {
  ERROR_CODES,
  RpcError,
  type InvocationContext,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/** 临时工作区根（buildProject 的 resolveSafe 基座） */
let workspaceRoot: string;
/** 临时 vendor fixture（alias 指向它，模拟真实 vendor 物料） */
let fixtureVendor: string;
/** 收集 esbuild 转发的执行日志（[esbuild] / [esbuild-err] 前缀） */
const collectedLogs: string[] = [];

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "kiko-build-ws-"));
  fixtureVendor = await mkdtemp(join(tmpdir(), "kiko-build-vendor-"));
  collectedLogs.length = 0;
  // fixture vendor：两包 dist/index.js 真实存在（alias 目标有效性）。
  // plugin-sdk 物料形态对齐真实产物（RpcError / ERROR_CODES 具名导出，
  // 模板 import 后被使用——避免 tree-shake 让 fixture 内容不进 bundle）
  await mkdir(join(fixtureVendor, "plugin-sdk", "dist"), { recursive: true });
  await writeFile(
    join(fixtureVendor, "plugin-sdk", "dist", "index.js"),
    'export const MARK = "plugin-sdk";\n' +
      'export const ERROR_CODES = { PLUGIN_EXECUTION_ERROR: 50001 };\n' +
      "export class RpcError extends Error {}\n",
    "utf-8",
  );
  await mkdir(join(fixtureVendor, "protocol", "dist"), { recursive: true });
  await writeFile(
    join(fixtureVendor, "protocol", "dist", "index.js"),
    'export const PROTOCOL_MARK = "protocol";\n',
    "utf-8",
  );
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(fixtureVendor, { recursive: true, force: true });
});

/** 开发态 esbuild CLI 二进制（与 bundle-plugins.mjs 同源解析方式） */
function resolveDevEsbuildBinary(): string {
  const require = createRequire(import.meta.url);
  const binary = require.resolve("@esbuild/win32-x64/esbuild.exe");
  if (!existsSync(binary)) throw new Error(`esbuild 二进制缺失：${binary}`);
  return binary;
}

/** 组装已 setup 的插件（esbuildBinaryPath + workspaceRoot 注入 fixture 值） */
async function makePlugin(overrides?: Partial<PluginContext>) {
  const plugin = createSdkPlugin();
  const pluginCtx: PluginContext = {
    pluginId: "sdk",
    workspaceRoot,
    documentsDir: join(workspaceRoot, "..", "documents"),
    userPluginsRoot: join(workspaceRoot, "..", "user-plugins"),
    esbuildBinaryPath: resolveDevEsbuildBinary(),
    ...overrides,
  };
  await plugin.setup?.(pluginCtx);
  return plugin;
}

/** fake InvocationContext（log 收集转发内容，断言排障通道可见） */
function makeCtx(): InvocationContext {
  return {
    progress: () => undefined,
    log: (message: string) => collectedLogs.push(message),
    isCancelled: () => false,
    artifacts: {
      save: () => {
        throw new Error("sdk.build 不应调用 artifacts.save");
      },
      register: () => undefined,
    },
  };
}

/** 写最小插件源码（manifest entry 合法形态：default 导出工厂） */
async function writePluginSource(
  extraImport = "",
): Promise<string> {
  const projectDir = join(workspaceRoot, "my-plugin");
  await mkdir(join(projectDir, "src"), { recursive: true });
  await writeFile(
    join(projectDir, "src", "index.ts"),
    `import { RpcError, ERROR_CODES, type KikoPlugin, type PluginContext, type InvocationContext } from "@kiko-workbench/plugin-sdk";${extraImport}
export function create(): KikoPlugin {
  return {
    async setup(_ctx: PluginContext): Promise<void> {},
    async handle(capabilityId: string, input: unknown, _ic: InvocationContext): Promise<unknown> {
      // 使用 import 的值（RpcError/ERROR_CODES）——证明 vendor 物料内容
      // 经 alias 改道进入 bundle（否则被 tree-shake）
      if (capabilityId === "boom") throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, "x");
      return { capabilityId, input };
    },
  };
}
export default create();
`,
    "utf-8",
  );
  return "my-plugin";
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

describe("sdk.build（S9，零 shell 构建）", () => {
  it("happy path：bundle 成功 → entry/size 契约 + 产物零裸包名 import", async () => {
    const projectDir = await writePluginSource();
    // buildProject 参数化 vendorRoot（handle 分发用模块常量 VENDOR_ROOT，
    // 测试注入 fixture——与三能力单测同策略，免受真实物料状态抖动）
    const result = (await _internal.buildProject(
      {
        pluginId: "sdk",
        workspaceRoot,
        documentsDir: join(workspaceRoot, "..", "documents"),
        userPluginsRoot: join(workspaceRoot, "..", "user-plugins"),
        esbuildBinaryPath: resolveDevEsbuildBinary(),
      },
      { project_dir: projectDir },
      fixtureVendor,
      (m) => collectedLogs.push(m),
    )) as { entry: string; size: number };

    // 输出契约（方案 3.1 output_schema）
    expect(result.entry).toBe(join(workspaceRoot, "my-plugin", "dist", "index.js"));
    expect(result.size).toBeGreaterThan(0);
    // 产物含 fixture vendor 代码内容（alias 改道生效的证明：模板 handle
    // 使用了 fixture 导出的 RpcError/ERROR_CODES——未被 tree-shake）
    const bundle = await readFile(result.entry, "utf-8");
    expect(bundle).toContain("PLUGIN_EXECUTION_ERROR");
    // 类结构特征（bundle 内局部名可能被 esbuild 重命名，断言结构而非名字）
    expect(bundle).toContain("extends Error");
    // 自包含：无裸包名 import（node: 前缀除外）
    expect(bundle).not.toMatch(/from\s+"@kiko-workbench/);
  });

  it("node: 内建 import 放行（自包含契约的合法例外）", async () => {
    await writePluginSource(
      '\nimport { join } from "node:path";\nexport const _p = join;\n',
    );
    const result = (await _internal.buildProject(
      {
        pluginId: "sdk",
        workspaceRoot,
        documentsDir: join(workspaceRoot, "..", "documents"),
        userPluginsRoot: join(workspaceRoot, "..", "user-plugins"),
        esbuildBinaryPath: resolveDevEsbuildBinary(),
      },
      { project_dir: "my-plugin" },
      fixtureVendor,
      () => undefined,
    )) as { entry: string };
    // node: 前缀是运行时可解析的内建模块，bundle 保留且放行
    const bundle = await readFile(result.entry, "utf-8");
    expect(bundle).toContain("node:path");
  });

  it("handle 全链路：真实 vendor 物料 bundle 成功（dispatch + 注入链）", async () => {
    const projectDir = await writePluginSource();
    const plugin = await makePlugin();
    const result = (await plugin.handle(
      "sdk.build",
      { project_dir: projectDir },
      makeCtx(),
    )) as { entry: string; size: number };
    expect(result.size).toBeGreaterThan(0);
    // 真实 vendor 的 plugin-sdk 物料内容进产物（RpcError 类等 sdk 标识）
    const bundle = await readFile(result.entry, "utf-8");
    expect(bundle).not.toMatch(/from\s+"@kiko-workbench/);
  });

  it("esbuildBinaryPath 未注入 → 50001 明示缺二进制", async () => {
    await writePluginSource();
    const plugin = await makePlugin({ esbuildBinaryPath: "" });
    const e = await expectRpcError(
      plugin.handle("sdk.build", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("esbuild 二进制不可用");
  });

  it("project_dir 越界（../..） → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("sdk.build", { project_dir: "../../evil" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("入口缺失 → 50001 带修复提示", async () => {
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.build", { project_dir: "empty-project" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("src/index.ts");
  });

  it("源码语法错误 → 50001（非零退出码路径）", async () => {
    const projectDir = join(workspaceRoot, "broken-plugin");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(join(projectDir, "src", "index.ts"), "this is not { valid", "utf-8");
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("sdk.build", { project_dir: "broken-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    // esbuild 报错经 stderr 转发执行日志（Agent 排障通道可见）
    expect(collectedLogs.some((l) => l.startsWith("[esbuild-err]"))).toBe(true);
  });

  it("源码 import 第三方裸包 → esbuild 解析失败 50001（自包含契约前置拦截）", async () => {
    await writePluginSource(
      '\nimport { x } from "lodash-es";\nvoid x;\n',
    );
    const plugin = await makePlugin();
    const e = await expectRpcError(
      plugin.handle("sdk.build", { project_dir: "my-plugin" }, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    // esbuild 无法解析未安装的裸包名 → 非零退出码（自包含契约的第一道拦截，
    // 产物级裸包名校验是防御兜底，bundle 模式下正常不可达）
    expect(e.message).toContain("esbuild 构建失败");
    expect(collectedLogs.some((l) => l.includes("lodash-es"))).toBe(true);
  });
});
