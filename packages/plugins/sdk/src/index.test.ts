/**
 * SDK 分发插件单测（S2 验收锚点）
 *
 * 验收锚点（《Kiko 插件 SDK 分发与 Agent 自举开发方案.md》4.3 / 4.4）：
 *   - 插件契约：未经 setup 防御 50005；未知能力 50001
 *   - sdk.install_guide：user_plugins_root 注入、restart_required=true、
 *     8 步序列、步骤 3 两包同一条命令（npm 依赖去重关键）
 *   - sdk.manifest：vendor fixture 统计（name/version/file_count/total_bytes）；
 *     vendor 缺失 → 可修复提示（不裸抛 ENOENT）
 *   - sdk.files：正常读取；package 白名单外的值拒绝；".."/绝对路径越界拒绝（50001）
 *
 * 测试策略：三能力实现经 _internal 参数化注入临时 vendor fixture，
 * 不依赖真实 vendor 物料（.gitignore 忽略、CI 克隆后不存在）；
 * install_guide 为纯字符串生成，走 handle 全链路验证注入链。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkPlugin, _internal } from "./index.js";
import {
  ERROR_CODES,
  RpcError,
  type InvocationContext,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/** 临时 vendor fixture 根（模拟 vendor/@kiko-workbench/ 结构） */
let fixtureVendor: string;
/** 主进程注入的第三方插件根（install_guide 部署目标） */
const USER_PLUGINS_ROOT = "D:/userData/plugins";

beforeEach(async () => {
  fixtureVendor = await mkdtemp(join(tmpdir(), "kiko-sdk-vendor-"));
  // 造最小物料：两包各 package.json + dist 两文件（口径断言用已知内容）
  await mkdir(join(fixtureVendor, "plugin-sdk", "dist"), { recursive: true });
  await mkdir(join(fixtureVendor, "protocol", "dist"), { recursive: true });
  await writeFile(
    join(fixtureVendor, "plugin-sdk", "package.json"),
    JSON.stringify({
      name: "@kiko-workbench/plugin-sdk",
      version: "0.1.0",
      dependencies: { "@kiko-workbench/protocol": "0.1.0" },
    }),
    "utf-8",
  );
  await writeFile(join(fixtureVendor, "plugin-sdk", "dist", "index.js"), "// sdk", "utf-8");
  await writeFile(join(fixtureVendor, "plugin-sdk", "dist", "index.d.ts"), "export {};", "utf-8");
  await writeFile(
    join(fixtureVendor, "protocol", "package.json"),
    JSON.stringify({ name: "@kiko-workbench/protocol", version: "0.1.0" }),
    "utf-8",
  );
  await writeFile(join(fixtureVendor, "protocol", "dist", "index.js"), "// protocol", "utf-8");
});

afterEach(async () => {
  await rm(fixtureVendor, { recursive: true, force: true });
});

/** fake InvocationContext（sdk 插件三能力均为快操作，不消费执行上下文） */
function makeCtx(): InvocationContext {
  return {
    progress: () => undefined,
    log: () => undefined,
    isCancelled: () => false,
    artifacts: {
      save: () => {
        throw new Error("sdk 插件不应调用 artifacts.save");
      },
      register: () => undefined,
    },
  };
}

/** 组装已 setup 的插件 + PluginContext（S2 起含 userPluginsRoot） */
async function makePlugin() {
  const plugin = createSdkPlugin();
  const pluginCtx: PluginContext = {
    pluginId: "sdk",
    workspaceRoot: "D:/unused-workspace",
    documentsDir: "D:/unused-documents",
    userPluginsRoot: USER_PLUGINS_ROOT,
  };
  await plugin.setup?.(pluginCtx);
  return plugin;
}

/** 断言 promise 抛 RpcError 且 code 匹配（与 file 插件测试同构） */
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

// ---------------------------------------------------------------------------

describe("插件契约（8.4 KikoPlugin）", () => {
  it("未经 setup 直接 handle → 50005 防御（host 协议违例不可达路径）", async () => {
    const plugin = createSdkPlugin(); // 干净实例：未 setup
    await expectRpcError(
      plugin.handle("sdk.manifest", {}, makeCtx()),
      ERROR_CODES.PLUGIN_UNAVAILABLE,
    );
  });

  it("不支持的能力 → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("sdk.unknown", {}, makeCtx()),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });
});

describe("sdk.spec（规范文档分发，_internal 参数化注入 fixture）", () => {
  /** 临时 spec fixture 根（模拟 vendor/spec/） */
  let fixtureSpec: string;
  /** 最小规范 fixture：前导 + 两个二级标题章节 */
  const SPEC_FIXTURE = [
    "# Kiko Workbench 插件开发规范",
    "",
    "> 前导说明（无二级标题，不进目录）",
    "",
    "## 7. 错误处理",
    "",
    "统一用 RpcError（内容甲）。",
    "",
    "## 8. 长任务",
    "",
    "必须实现协作取消（内容乙）。",
    "",
  ].join("\n");

  beforeEach(async () => {
    fixtureSpec = await mkdtemp(join(tmpdir(), "kiko-sdk-spec-"));
    await writeFile(join(fixtureSpec, "Kiko 插件开发规范.md"), SPEC_FIXTURE, "utf-8");
  });

  afterEach(async () => {
    await rm(fixtureSpec, { recursive: true, force: true });
  });

  it("section 缺省 → 全文 + 章节目录（Agent 先拿目录再按需拉取）", async () => {
    const result = (await _internal.getSpecDoc({}, fixtureSpec)) as {
      name: string;
      sections: string[];
      content: string;
    };
    expect(result.name).toBe("Kiko 插件开发规范.md");
    expect(result.sections).toEqual(["7. 错误处理", "8. 长任务"]);
    expect(result.content).toBe(SPEC_FIXTURE);
  });

  it("section 命中：编号与中文关键词均可（包含式匹配），仅返回该章节", async () => {
    // 编号命中
    const byNumber = (await _internal.getSpecDoc({ section: "7" }, fixtureSpec)) as {
      section: string;
      content: string;
    };
    expect(byNumber.section).toBe("7. 错误处理");
    expect(byNumber.content).toContain("内容甲");
    expect(byNumber.content).not.toContain("内容乙");

    // 中文关键词命中
    const byKeyword = (await _internal.getSpecDoc({ section: "长任务" }, fixtureSpec)) as {
      section: string;
      content: string;
    };
    expect(byKeyword.section).toBe("8. 长任务");
    expect(byKeyword.content).toContain("内容乙");
    expect(byKeyword.content).not.toContain("内容甲");
  });

  it("section 未命中 → 50001 且附可用章节列表（Agent 可自纠）", async () => {
    const e = await expectRpcError(
      _internal.getSpecDoc({ section: "不存在的章节" }, fixtureSpec),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("7. 错误处理");
    expect(e.message).toContain("8. 长任务");
  });

  it("规范文件缺失 → 50001 可修复提示（不裸抛 ENOENT）", async () => {
    const empty = await mkdtemp(join(tmpdir(), "kiko-sdk-spec-empty-"));
    try {
      const e = await expectRpcError(
        _internal.getSpecDoc({}, empty),
        ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      );
      expect(e.message).toContain("vendor:sdk");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("sdk.install_guide v2（双轨，走 handle 全链路）", () => {
  it("mode 缺省 / 显式 agent → 零 shell 五步 + rescan_required（零重启）", async () => {
    const plugin = await makePlugin();
    // 缺省即 agent 轨（方案 3.5：零 shell 轨为新缺省）
    const result = (await plugin.handle("sdk.install_guide", {}, makeCtx())) as {
      mode: string;
      node_requirement: string;
      sdk_root: string;
      user_plugins_root: string;
      steps: Array<{ title: string; command: string; explanation: string }>;
      restart_required?: boolean;
      rescan_required: boolean;
      spec_doc: string;
    };

    expect(result.mode).toBe("agent");
    // 部署目标 = 主进程注入的第三方插件根（S2 注入链的出口断言）
    expect(result.user_plugins_root).toBe(USER_PLUGINS_ROOT);
    // agent 轨零重启：rescan 即生效（S11），不再输出 restart_required
    expect(result.rescan_required).toBe(true);
    expect(result.restart_required).toBeUndefined();
    expect(result.node_requirement).toBe(">=18");
    expect(result.spec_doc).toBe("Kiko 插件开发规范.md");
    // 规范获取方式可行动（Agent 读不到外部 md → 指向 sdk.spec 能力）
    expect(String(result.spec_read_via)).toContain("sdk.spec");
    // 方案 3.5 agent 轨：固定五步（write → build → deploy → rescan → 验证）
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]?.title).toBe("写五件套源码");
    expect(result.steps[0]?.command).toContain("file.write");
    expect(result.steps[1]?.command).toContain("sdk.build");
    expect(result.steps[2]?.command).toContain("sdk.deploy");
    expect(result.steps[3]?.command).toContain("plugins.rescan");
    expect(result.steps[4]?.title).toBe("验证");
    // sdk_root 指向本插件 vendor（模块常量自解析，含 vendor 目录片段）
    expect(result.sdk_root).toContain("vendor");

    // 显式 mode: "agent" 与缺省等价
    const explicit = (await plugin.handle(
      "sdk.install_guide",
      { mode: "agent" },
      makeCtx(),
    )) as { mode: string; steps: unknown[] };
    expect(explicit.mode).toBe("agent");
    expect(explicit.steps).toHaveLength(5);
  });

  it("mode human → v1 人类轨 8 步 + restart_required（回归不受影响）", async () => {
    const plugin = await makePlugin();
    const result = (await plugin.handle(
      "sdk.install_guide",
      { mode: "human" },
      makeCtx(),
    )) as {
      mode: string;
      node_requirement: string;
      sdk_root: string;
      user_plugins_root: string;
      steps: Array<{ title: string; command: string; explanation: string }>;
      restart_required: boolean;
      rescan_required?: boolean;
      spec_doc: string;
    };

    expect(result.mode).toBe("human");
    expect(result.user_plugins_root).toBe(USER_PLUGINS_ROOT);
    // M2：Registry 仅启动时扫描，人类轨 Agent 须提示用户重启
    expect(result.restart_required).toBe(true);
    expect(result.rescan_required).toBeUndefined();
    expect(result.node_requirement).toBe(">=18");
    expect(result.spec_doc).toBe("Kiko 插件开发规范.md");
    expect(String(result.spec_read_via)).toContain("sdk.spec");
    // 方案 4.3 步骤表：固定 8 步
    expect(result.steps).toHaveLength(8);
    expect(result.steps[0]?.title).toBe("检查 Node 环境");
    expect(result.steps[7]?.title).toBe("重启验证");
    expect(result.sdk_root).toContain("vendor");
  });

  it("人类轨步骤 3 两包同一条 npm install 命令（依赖去重关键，方案 5 阶段 3）", async () => {
    const plugin = await makePlugin();
    const result = (await plugin.handle(
      "sdk.install_guide",
      { mode: "human" },
      makeCtx(),
    )) as {
      steps: Array<{ command: string }>;
    };
    const installCmd = result.steps[2]?.command ?? "";
    // 单条命令同时含两包路径：分开安装会让 npm 去 registry 搜 404
    expect(installCmd).toMatch(/^npm install /);
    expect(installCmd).toContain("/plugin-sdk");
    expect(installCmd).toContain("/protocol");
    expect(installCmd).not.toContain("&&"); // 无命令拼接 = 同一条安装
    // --install-links 强制复制（S4 实测）：npm 默认对目录源建 junction，
    // esbuild 沿真实路径解析将找不到 protocol
    expect(installCmd).toContain("--install-links");
  });

  it("project_dir 缺省用占位符；传入则命令含精确目录（双轨同规则）", async () => {
    const plugin = await makePlugin();
    const withDefault = (await plugin.handle("sdk.install_guide", {}, makeCtx())) as {
      steps: Array<{ command: string }>;
    };
    expect(withDefault.steps[0]?.command).toContain("<project_dir>");

    const withDir = (await plugin.handle(
      "sdk.install_guide",
      { project_dir: "my-plugin" },
      makeCtx(),
    )) as { steps: Array<{ command: string }>; user_plugins_root: string };
    // agent 轨：五步命令均携带精确 project_dir（file.write / build / deploy）
    expect(withDir.steps[0]?.command).toContain("my-plugin");
    expect(withDir.steps[1]?.command).toContain("my-plugin");
    expect(withDir.steps[2]?.command).toContain("my-plugin");
    expect(withDir.steps[0]?.command).not.toContain("<project_dir>");
  });
});

describe("sdk.manifest（_internal + vendor fixture）", () => {
  it("返回两包完整 scope 名、版本与递归统计", async () => {
    const result = (await _internal.getSdkManifest(fixtureVendor)) as {
      sdk_root: string;
      packages: Array<{ name: string; version: string; file_count: number; total_bytes: number }>;
    };
    expect(result.sdk_root).toBe(fixtureVendor);
    expect(result.packages).toHaveLength(2);
    const sdkPkg = result.packages.find((p) => p.name === "@kiko-workbench/plugin-sdk");
    expect(sdkPkg?.version).toBe("0.1.0");
    // fixture：plugin-sdk = package.json + dist/index.js + dist/index.d.ts
    expect(sdkPkg?.file_count).toBe(3);
    // 口径断言：字节数 = 三文件 UTF-8 字节数之和（与 vendor-sdk.mjs 一致）
    const expectedBytes =
      Buffer.byteLength(
        JSON.stringify({
          name: "@kiko-workbench/plugin-sdk",
          version: "0.1.0",
          dependencies: { "@kiko-workbench/protocol": "0.1.0" },
        }),
        "utf-8",
      ) +
      Buffer.byteLength("// sdk", "utf-8") +
      Buffer.byteLength("export {};", "utf-8");
    expect(sdkPkg?.total_bytes).toBe(expectedBytes);
    const protocolPkg = result.packages.find((p) => p.name === "@kiko-workbench/protocol");
    expect(protocolPkg?.file_count).toBe(2);
  });

  it("vendor 缺失 → 50001 且提示修复命令（不裸抛 ENOENT）", async () => {
    const missingRoot = join(fixtureVendor, "no-such-dir");
    const err = await expectRpcError(
      _internal.getSdkManifest(missingRoot) as Promise<unknown>,
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(err.message).toContain("vendor:sdk");
  });
});

describe("sdk.files（_internal + vendor fixture）", () => {
  it("按包内相对路径读取文件，返回内容与字节数", async () => {
    const result = (await _internal.readVendorFile(
      { package: "plugin-sdk", path: "dist/index.d.ts" },
      fixtureVendor,
    )) as { content: string; size: number };
    expect(result.content).toBe("export {};");
    expect(result.size).toBe(Buffer.byteLength("export {};", "utf-8"));
  });

  it("package 白名单外的值 → 50001（路径拼接源必须白名单）", async () => {
    await expectRpcError(
      _internal.readVendorFile(
        { package: "evil", path: "package.json" },
        fixtureVendor,
      ) as Promise<unknown>,
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("path 为空或非字符串 → 50001", async () => {
    await expectRpcError(
      _internal.readVendorFile({ package: "protocol", path: "" }, fixtureVendor) as Promise<unknown>,
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    await expectRpcError(
      _internal.readVendorFile(
        { package: "protocol", path: undefined as unknown as string },
        fixtureVendor,
      ) as Promise<unknown>,
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("'..' 越界路径 → 50001（resolveSafe 拦截）", async () => {
    await expectRpcError(
      _internal.readVendorFile(
        { package: "plugin-sdk", path: "../../secret.txt" },
        fixtureVendor,
      ) as Promise<unknown>,
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("文件不存在 → 50001（IO 异常包装）", async () => {
    await expectRpcError(
      _internal.readVendorFile(
        { package: "protocol", path: "dist/nope.js" },
        fixtureVendor,
      ) as Promise<unknown>,
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });
});
