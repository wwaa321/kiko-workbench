/**
 * CapabilityRegistry 单测（M1-05 验收锚点）
 *
 * 验收锚点：
 *   - discover 分词匹配 + 评分排序（5.3.1）
 *   - describe 返回完整 schema（5.3.2）
 *   - **契约测试锁定 discover 响应无 schema 字段**（防 R4 Context 膨胀回归）
 *   - 插件状态维护（enabled / disabled / error，6.1）
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "./registry.js";
import { ERROR_CODES, RpcError, type CapabilityDefinition } from "@kiko-workbench/protocol";

/** 测试根目录（每个用例独立临时目录） */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kiko-registry-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写一个插件目录（manifest + capabilities） */
async function makePlugin(
  id: string,
  capabilities: CapabilityDefinition[],
  manifestOverrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: id.toUpperCase(),
      description: `${id} plugin`,
      version: "1.0.0",
      entry: "index.js",
      permissions: [],
      ...manifestOverrides,
    }),
    "utf-8",
  );
  await writeFile(join(dir, "capabilities.json"), JSON.stringify(capabilities), "utf-8");
}

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

/** 基准双插件：document（两能力）+ file（一能力） */
async function makeStandardPlugins(): Promise<void> {
  await makePlugin("document", [
    cap("document.create", "Create Document", "Create a docx document from Markdown content"),
    cap("document.convert", "Convert Document", "Convert document formats"),
  ]);
  await makePlugin("file", [
    cap("file.read", "Read File", "Read file content from documents directory"),
  ]);
}

describe("scan：插件扫描与注册", () => {
  it("合法插件目录 → enabled 注册，能力索引建立", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const plugins = registry.listPlugins();
    expect(plugins.map((p) => p.id).sort()).toEqual(["document", "file"]);
    expect(plugins.every((p) => p.status === "enabled")).toBe(true);
    expect(registry.discover()).toHaveLength(3);
  });

  it("manifest JSON 损坏 → 插件 error（目录名兜底标识），不影响其他插件", async () => {
    await makeStandardPlugins();
    // 追加一个 manifest 损坏的插件目录
    const broken = join(root, "broken");
    await mkdir(broken);
    await writeFile(join(broken, "manifest.json"), "{oops", "utf-8");

    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const brokenPlugin = registry.listPlugins().find((p) => p.id === "broken");
    expect(brokenPlugin?.status).toBe("error");
    expect(brokenPlugin?.errorReason).toBeTruthy();
    // 其他插件不受影响
    expect(registry.discover()).toHaveLength(3);
  });

  it("capabilities 缺 output_schema → 插件 error", async () => {
    await makePlugin("bad", [
      { id: "bad.x", name: "X", description: "x", input_schema: { type: "object" } },
    ] as unknown as CapabilityDefinition[]);
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.listPlugins()[0]?.status).toBe("error");
    expect(registry.discover()).toEqual([]);
  });

  it("capability id 跨插件冲突 → 后注册插件 error", async () => {
    await makePlugin("a", [cap("dup.capability", "A", "a desc")]);
    await makePlugin("b", [cap("dup.capability", "B", "b desc")]);
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    // a 先注册成功；b 冲突置 error
    const pluginB = registry.listPlugins().find((p) => p.id === "b");
    expect(pluginB?.status).toBe("error");
    expect(pluginB?.errorReason).toContain("冲突");
    // 冲突能力仍归属先注册者
    expect(registry.describe("dup.capability").name).toBe("A");
  });

  it("插件根目录不存在 → 空 Registry 不抛错", async () => {
    const registry = new CapabilityRegistry(join(root, "not-exists"));
    await expect(registry.scan()).resolves.toBeUndefined();
    expect(registry.listPlugins()).toEqual([]);
    expect(registry.discover()).toEqual([]);
  });
});

describe("contributes.configuration 注册期校验（P-002 Phase 1）", () => {
  /** 合法配置 schema（weather 式：string + enum + secret + required） */
  const validSchema = {
    type: "object",
    properties: {
      api_key: { type: "string", "x-kiko-secret": true, title: "API Key" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" },
    },
    required: ["api_key"],
  };

  it("合法 schema → configSchema 进 PluginRecord（UI 与 IPC 的唯一来源）", async () => {
    await makePlugin("weather", [cap("weather.now", "Now", "Current weather")], {
      contributes: { configuration: validSchema },
    });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const record = registry.getPlugin("weather");
    expect(record?.status).toBe("enabled");
    expect(record?.configSchema).toEqual(validSchema);
  });

  it("未声明 contributes → configSchema 为 undefined（现有插件零影响）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    for (const p of registry.listPlugins()) {
      expect(p.configSchema).toBeUndefined();
    }
  });

  it("非法 schema（array 属性）→ 插件 error 态，原因指明 v1 不支持", async () => {
    await makePlugin("bad", [cap("bad.x", "X", "x desc")], {
      contributes: {
        configuration: {
          type: "object",
          properties: { tags: { type: "array" } },
        },
      },
    });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const record = registry.getPlugin("bad");
    expect(record?.status).toBe("error");
    expect(record?.errorReason).toMatch(/v1 不支持的配置 schema 特性/);
    // 能力不注册（error 插件语义）
    expect(registry.discover()).toEqual([]);
  });

  it("非法 schema（顶层非 object）→ 插件 error 态，不影响其余插件", async () => {
    await makeStandardPlugins();
    await makePlugin("bad", [cap("bad.x", "X", "x desc")], {
      contributes: { configuration: { type: "string" } },
    });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("bad")?.status).toBe("error");
    expect(registry.getPlugin("bad")?.errorReason).toMatch(/顶层 type 必须为 "object"/);
    // 其余插件不受影响
    expect(registry.discover()).toHaveLength(3);
  });
});

describe("contributes.ui 注册期校验（P-003 v1）", () => {
  /** 写一个合法的 web 前端入口（web/index.html）到指定插件目录 */
  async function makeWebEntry(pluginId: string): Promise<void> {
    await mkdir(join(root, pluginId, "web"), { recursive: true });
    await writeFile(join(root, pluginId, "web", "index.html"), "<!doctype html>", "utf-8");
  }

  it("合法 entry（文件存在）→ uiEntry 进 PluginRecord", async () => {
    await makePlugin("dashboard", [cap("dashboard.show", "Show", "Show dashboard")], {
      contributes: { ui: { entry: "web/index.html" } },
    });
    await makeWebEntry("dashboard");
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const record = registry.getPlugin("dashboard");
    expect(record?.status).toBe("enabled");
    expect(record?.uiEntry).toBe("web/index.html");
  });

  it("未声明 contributes.ui → uiEntry 为 undefined（现有插件零影响）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    for (const p of registry.listPlugins()) {
      expect(p.uiEntry).toBeUndefined();
    }
  });

  it("entry 文件不存在 → 插件 error 态（防「声明了界面却打不开」）", async () => {
    await makePlugin("ghost-ui", [cap("ghost-ui.x", "X", "x desc")], {
      contributes: { ui: { entry: "web/index.html" } },
    }); // 故意不写 web/index.html
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const record = registry.getPlugin("ghost-ui");
    expect(record?.status).toBe("error");
    expect(record?.errorReason).toMatch(/contributes\.ui\.entry 文件不存在/);
    expect(record?.uiEntry).toBeUndefined();
  });

  it("entry 穿越段（../）→ error（防越出插件目录）", async () => {
    await makePlugin("traversal", [cap("traversal.x", "X", "x desc")], {
      contributes: { ui: { entry: "../neighbor/index.html" } },
    });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("traversal")?.status).toBe("error");
    expect(registry.getPlugin("traversal")?.errorReason).toMatch(/非法相对路径/);
  });

  it("entry 绝对路径 / 盘符 → error", async () => {
    await makePlugin("absolute", [cap("absolute.x", "X", "x desc")], {
      contributes: { ui: { entry: "C:/evil/index.html" } },
    });
    await makePlugin("rooted", [cap("rooted.x", "X", "x desc")], {
      contributes: { ui: { entry: "/etc/passwd" } },
    });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("absolute")?.status).toBe("error");
    expect(registry.getPlugin("rooted")?.status).toBe("error");
  });

  it("entry 指向目录 → error（入口必须是常规文件）", async () => {
    await makePlugin("dir-entry", [cap("dir-entry.x", "X", "x desc")], {
      contributes: { ui: { entry: "web" } },
    });
    await mkdir(join(root, "dir-entry", "web"), { recursive: true });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("dir-entry")?.status).toBe("error");
    expect(registry.getPlugin("dir-entry")?.errorReason).toMatch(/不是常规文件/);
  });

  it("声明 ui 但 entry 缺失 / 非字符串 → error", async () => {
    await makePlugin("no-entry", [cap("no-entry.x", "X", "x desc")], {
      contributes: { ui: {} },
    });
    await makePlugin("bad-type", [cap("bad-type.x", "X", "x desc")], {
      contributes: { ui: { entry: 123 } },
    });
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("no-entry")?.status).toBe("error");
    expect(registry.getPlugin("bad-type")?.status).toBe("error");
  });

  it("反斜杠 entry（web\\index.html）→ 按分隔符解析通过（跨平台兼容）", async () => {
    await makePlugin("win-style", [cap("win-style.x", "X", "x desc")], {
      contributes: { ui: { entry: "web\\index.html" } },
    });
    await makeWebEntry("win-style");
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("win-style")?.uiEntry).toBe("web\\index.html");
  });
});

describe("discover：分词匹配 + 评分排序（5.3.1）", () => {
  it("query 省略 → 全部能力摘要，按 id 字典序稳定排序", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const all = registry.discover();
    expect(all.map((c) => c.id)).toEqual(["document.convert", "document.create", "file.read"]);
  });

  it("空字符串 query 等同省略", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    expect(registry.discover("   ")).toHaveLength(3);
  });

  it("关键词命中 → 仅返回匹配能力", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const results = registry.discover("file");
    expect(results.map((c) => c.id)).toEqual(["file.read"]);
    // 摘要含所属插件 id
    expect(results[0]?.plugin).toBe("file");
  });

  it("评分排序：全命中 > 部分命中 > 仅 desc 命中（markdown document 用例）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    // "markdown document" 三档得分：
    //   create 7（markdown desc 1 + document id3/name2/desc1）
    //   convert 6（document id3/name2/desc1）
    //   file.read 1（desc "documents" 子串包含 document）
    const results = registry.discover("markdown document");
    expect(results.map((c) => c.id)).toEqual(["document.create", "document.convert", "file.read"]);
  });

  it("无匹配 → 空数组", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    expect(registry.discover("calendar")).toEqual([]);
  });

  it("disabled 插件的能力不出现在 discover 结果（协议细化，偏差表 2026-08-19）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    registry.setPluginStatus("document", "disabled");

    expect(registry.discover().map((c) => c.id)).toEqual(["file.read"]);
  });

  it("【R4 契约锁定】discover 摘要仅含 id/name/description/plugin，绝无 schema 字段", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    for (const summary of registry.discover()) {
      // 键集合精确锁定四字段
      expect(Object.keys(summary).sort()).toEqual(["description", "id", "name", "plugin"]);
    }
    // 序列化产物整体不含 schema 字样（双保险：防未来加字段时绕过键检查）
    const serialized = JSON.stringify(registry.discover());
    expect(serialized).not.toContain("schema");
    expect(serialized).not.toContain("timeout_ms");
  });
});

describe("describe / resolveCapability（5.3.2 / 40001）", () => {
  it("describe 返回完整能力定义（含 input/output schema）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const definition = registry.describe("document.create");
    expect(definition.id).toBe("document.create");
    expect(definition.input_schema).toEqual({ type: "object", properties: {} });
    expect(definition.output_schema).toEqual({ type: "object", properties: {} });
  });

  it("describe 未注册能力 → 40001", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(() => registry.describe("nope.x")).toThrow(RpcError);
    try {
      registry.describe("nope.x");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
    }
  });

  it("describe disabled 插件的能力 → 40001", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    registry.setPluginStatus("document", "disabled");

    try {
      registry.describe("document.create");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
    }
  });

  it("resolveCapability 返回插件记录 + 定义（InvocationManager resolve 消费）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const resolved = registry.resolveCapability("file.read");
    expect(resolved.plugin.id).toBe("file");
    expect(resolved.plugin.rootDir).toBe(join(root, "file"));
    expect(resolved.plugin.entry).toBe("index.js");
    expect(resolved.definition.id).toBe("file.read");
  });

  it("error 插件（运行时置 error）的能力 → resolve 40005（5.5 插件不可用，M1-09 拆分）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    // 模拟 M1-09 崩溃熔断：运行时置 error（携带原因）
    registry.setPluginStatus("file", "error", "连续崩溃 3 次（熔断）");

    try {
      registry.resolveCapability("file.read");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.PLUGIN_UNAVAILABLE);
      expect((e as RpcError).message).toContain("连续崩溃 3 次");
    }
  });
});

describe("插件启停与查询（供 IPC / M2 UI 消费）", () => {
  it("setPluginStatus：enable ↔ disable 切换即时生效", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    registry.setPluginStatus("file", "disabled");
    expect(registry.getPlugin("file")?.status).toBe("disabled");

    registry.setPluginStatus("file", "enabled");
    expect(registry.getPlugin("file")?.status).toBe("enabled");
    expect(registry.discover("file")).toHaveLength(1);
  });

  it('重新启用清除 errorReason（UI"重新启用"路径）', async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    registry.setPluginStatus("file", "error");
    expect(registry.getPlugin("file")?.errorReason).toBeUndefined();

    // error 原因由注册时 scan 失败写入；此处验证 enabled 切换后清除逻辑
    registry.setPluginStatus("file", "enabled");
    expect("errorReason" in (registry.getPlugin("file") ?? {})).toBe(false);
  });

  it("setPluginStatus 未知插件 → 40005", async () => {
    const registry = new CapabilityRegistry(root);
    await registry.scan();
    try {
      registry.setPluginStatus("ghost", "disabled");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.PLUGIN_UNAVAILABLE);
    }
  });

  it("getPlugin / listPlugins 返回拷贝，外部篡改不污染内部状态", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    const plugin = registry.getPlugin("file");
    plugin!.status = "disabled";
    expect(registry.getPlugin("file")?.status).toBe("enabled");
  });

  it("capabilityCounts：按插件聚合计数，disabled 插件不过滤（M2-06 UI 卡片）", async () => {
    await makeStandardPlugins();
    const registry = new CapabilityRegistry(root);
    await registry.scan();

    // 基准：document 2 能力 / file 1 能力
    const before = registry.capabilityCounts();
    expect(before.get("document")).toBe(2);
    expect(before.get("file")).toBe(1);

    // disabled 不影响计数（discover 会过滤，UI 统计不过滤——两语义分立）
    registry.setPluginStatus("file", "disabled");
    const after = registry.capabilityCounts();
    expect(after.get("file")).toBe(1);
    expect(registry.discover()).toHaveLength(2);
  });

  it("capabilityCounts：scan 失败的 error 插件能力不计入（未注册成功）", async () => {
    await makeStandardPlugins();
    // capabilities.json 损坏 → 该插件 error 且无能力注册
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(
      join(root, "broken", "manifest.json"),
      JSON.stringify({
        id: "broken",
        name: "Broken",
        description: "broken",
        version: "1.0.0",
        entry: "index.js",
        permissions: [],
      }),
      "utf-8",
    );
    await writeFile(join(root, "broken", "capabilities.json"), "{ not json", "utf-8");

    const registry = new CapabilityRegistry(root);
    await registry.scan();

    expect(registry.getPlugin("broken")?.status).toBe("error");
    expect(registry.capabilityCounts().get("broken")).toBeUndefined();
  });
});

describe("多根目录扫描（内置 + 第三方分离）", () => {
  /** 第三方插件根目录（每个用例独立，与 root（内置根）平级） */
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "kiko-registry-user-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  /** 向指定根写一个插件目录（多根版本：makePlugin 固定写 root，此处显式传根） */
  async function makePluginAt(
    pluginsRoot: string,
    id: string,
    capabilities: CapabilityDefinition[],
  ): Promise<void> {
    const dir = join(pluginsRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id.toUpperCase(),
        description: `${id} plugin`,
        version: "1.0.0",
        entry: "index.js",
        permissions: [],
      }),
      "utf-8",
    );
    await writeFile(join(dir, "capabilities.json"), JSON.stringify(capabilities), "utf-8");
  }

  it("双根目录：内置 + 第三方插件全部注册（第三方目录 userData 场景）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    await makePluginAt(userRoot, "third-party", [
      cap("third-party.greet", "Greet", "Third party greeting"),
    ]);

    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    expect(registry.listPlugins().map((p) => p.id).sort()).toEqual(["file", "third-party"]);
    // 第三方能力可被 discover（根目录来源对索引透明）
    expect(registry.discover("greet").map((s) => s.id)).toEqual(["third-party.greet"]);
  });

  it("id 冲突：第三方与内置同 id → 内置保留，第三方不进注册表（防替换产品能力）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    await makePluginAt(userRoot, "file", [
      cap("file.malicious", "Malicious", "Should not be registered"),
    ]);

    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    // 内置 file 保持 enabled，能力与目录均来自内置根
    const file = registry.getPlugin("file");
    expect(file?.status).toBe("enabled");
    expect(file?.rootDir).toBe(join(root, "file"));

    // 第三方同 id 插件被整体拒绝：能力未注册，注册表无重复条目
    expect(registry.discover("malicious")).toHaveLength(0);
    expect(registry.listPlugins().filter((p) => p.id === "file")).toHaveLength(1);
  });

  it("第三方根目录不存在 → 静默跳过（首次使用前正常态）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);

    const registry = new CapabilityRegistry(root, join(userRoot, "not-exists"));
    await registry.scan();

    expect(registry.listPlugins().map((p) => p.id)).toEqual(["file"]);
  });

  it("capability id 跨根冲突：后扫描插件整体置 error（能力索引不污染）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    // 第三方插件 id 不同，但注册了与内置重复的 capability id
    await makePluginAt(userRoot, "imposter", [
      cap("file.read", "File Read Fake", "Duplicate capability id across roots"),
    ]);

    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    // imposter 置 error（capability id 冲突 → 拒绝整个插件），内置 file.read 不受影响
    expect(registry.getPlugin("imposter")?.status).toBe("error");
    expect(registry.discover("file.read").map((s) => s.id)).toEqual(["file.read"]);
    expect(registry.getPlugin("imposter")?.rootDir).toBe(join(userRoot, "imposter"));
  });
});

describe("rescan：第三方根重扫（S11 零 Shell 自举方案 3.3）", () => {
  /** 第三方插件根目录（每个用例独立，与 root（内置根）平级） */
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "kiko-registry-rescan-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  /** 向指定根写一个插件目录（复用多根 describe 的工厂形状） */
  async function makePluginAt(
    pluginsRoot: string,
    id: string,
    capabilities: CapabilityDefinition[],
  ): Promise<void> {
    const dir = join(pluginsRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id.toUpperCase(),
        description: `${id} plugin`,
        version: "1.0.0",
        entry: "index.js",
        permissions: [],
      }),
      "utf-8",
    );
    await writeFile(join(dir, "capabilities.json"), JSON.stringify(capabilities), "utf-8");
  }

  it("磁盘新增第三方插件 → added 注册，能力即刻可 discover（部署后免重启）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    // Agent 部署新插件到 userRoot（模拟 sdk.deploy 产物落盘）
    await makePluginAt(userRoot, "agent-tool", [
      cap("agent-tool.run", "Run Tool", "Agent generated tool"),
    ]);

    const result = await registry.rescan();
    expect(result.added).toEqual(["agent-tool"]);
    expect(result.removed).toEqual([]);
    expect(registry.getPlugin("agent-tool")?.status).toBe("enabled");
    expect(registry.discover("agent-tool").map((s) => s.id)).toEqual(["agent-tool.run"]);
  });

  it("磁盘第三方插件目录消失 → removed 卸载，能力索引同步清除", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    await makePluginAt(userRoot, "legacy", [
      cap("legacy.x", "Legacy", "Legacy third party capability"),
    ]);
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();
    expect(registry.discover("legacy")).toHaveLength(1);

    // 用户删除插件目录（或 Agent 卸载）
    await rm(join(userRoot, "legacy"), { recursive: true, force: true });

    const result = await registry.rescan();
    expect(result.removed).toEqual(["legacy"]);
    expect(result.added).toEqual([]);
    // 注册表与能力索引同步清除：插件记录消失，能力解析 40001
    expect(registry.getPlugin("legacy")).toBeUndefined();
    expect(() => registry.describe("legacy.x")).toThrow(RpcError);
    try {
      registry.describe("legacy.x");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
    }
  });

  it("已注册插件目录仍在磁盘 → skipped（文件变更不重载，重启生效）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    await makePluginAt(userRoot, "stable", [
      cap("stable.tick", "Stable", "Stable third party capability"),
    ]);
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    const result = await registry.rescan();
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "stable", reason: expect.stringContaining("不重载") },
    ]);
  });

  it("rescan 仅管辖第三方根：内置根的新增目录不进 added（内置随安装包不可变）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    // 内置根被外部写入新目录（非常规操作，rescan 应当无视）
    await makePluginAt(root, "sneaky", [cap("sneaky.x", "Sneaky", "Should be ignored")]);

    const result = await registry.rescan();
    expect(result.added).toEqual([]);
    expect(result.skipped.filter((s) => s.id === "sneaky")).toHaveLength(0);
    expect(registry.getPlugin("sneaky")).toBeUndefined();
  });

  it("rescan 新目录 manifest id 与已注册插件冲突 → skipped（先注册者优先，防替换）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    // 目录名不同但 manifest.id 撞内置插件：registerPlugin 已占用告警路径 → skipped
    await makePluginAt(userRoot, "file-clone", [
      cap("file.malicious", "Malicious", "Should not be registered"),
    ]);
    // 改写 manifest id 为内置已占用的 "file"（makePluginAt 默认用目录名做 id）
    await writeFile(
      join(userRoot, "file-clone", "manifest.json"),
      JSON.stringify({
        id: "file",
        name: "FILE CLONE",
        description: "imposter",
        version: "1.0.0",
        entry: "index.js",
        permissions: [],
      }),
      "utf-8",
    );

    const result = await registry.rescan();
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "file-clone", reason: expect.stringContaining("冲突") },
    ]);
    // 内置 file 保持原样（rootDir 不被第三方覆盖）
    expect(registry.getPlugin("file")?.rootDir).toBe(join(root, "file"));
    expect(registry.discover("malicious")).toHaveLength(0);
  });

  it("rescan 新目录 manifest 损坏 → 仍算 added（error 态，Agent 可查失败原因排障）", async () => {
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    // 损坏的部署产物（半成品 / 写盘中断）：注册进 map 但置 error
    const broken = join(userRoot, "half-written");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "manifest.json"), "{oops", "utf-8");

    const result = await registry.rescan();
    expect(result.added).toEqual(["half-written"]);
    const plugin = registry.getPlugin("half-written");
    expect(plugin?.status).toBe("error");
    expect(plugin?.errorReason).toBeTruthy();
  });

  it("第三方根不存在 → rescan 空结果不抛错（与 scan 同语义）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    const registry = new CapabilityRegistry(root, join(userRoot, "not-exists"));
    await registry.scan();

    await expect(registry.rescan()).resolves.toEqual({
      added: [],
      removed: [],
      skipped: [],
    });
  });

  it("并发 rescan 重入 → 返回同一结果（互斥的最简形态）", async () => {
    await makePluginAt(root, "file", [cap("file.read", "Read File", "Read file content")]);
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();

    await makePluginAt(userRoot, "concurrent", [
      cap("concurrent.x", "Concurrent", "Concurrent registration"),
    ]);

    // 两次并发调用：第二次命中 rescanInFlight 返回同一 promise
    const [first, second] = await Promise.all([registry.rescan(), registry.rescan()]);
    expect(second).toEqual(first);
    expect(first.added).toEqual(["concurrent"]);
    // 能力索引仅注册一次（无重复条目）
    expect(registry.discover("concurrent")).toHaveLength(1);
  });

  it("unregisterPlugin 幂等：未注册 id 静默返回（rescan 移除路径的安全网）", async () => {
    const registry = new CapabilityRegistry(root, userRoot);
    await registry.scan();
    expect(() => registry.unregisterPlugin("ghost")).not.toThrow();
  });
});
