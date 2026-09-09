/**
 * 插件配置存储单测（P-002 Phase 1 验收锚点，方案草案 §5 测试计划）
 *
 * 验收锚点：
 *   - assertConfigurationSchema：合法 schema 通过；非法（非 object / array /
 *     嵌套 object / oneOf / enum 配非 string / required 引用未声明字段）→
 *     抛错且原因可查（registry 置 error 态的错误信息来源）
 *   - read：已保存值优先 + schema default 合并 + 未知字段透传；
 *     未声明配置 → {}；损坏 JSON → {}（不抛错）
 *   - save：表单值覆盖合并（未知字段保留）+ Ajv 校验 + 原子写回；
 *     校验失败返回 errors 列表（path 供表单内联定位）
 *   - hasSavedValues：已配置圆点判定
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertConfigurationSchema,
  validateConfigValues,
  PluginConfigStore,
  type ConfigurationSchema,
} from "./config-store.js";

/** 测试配置根（每个用例独立临时目录） */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kiko-config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 基准 schema：weather 式（string + enum + number + boolean + secret + required） */
const SCHEMA: ConfigurationSchema = {
  type: "object",
  properties: {
    api_key: { type: "string", title: "API Key", "x-kiko-secret": true },
    unit: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" },
    timeout_ms: { type: "number", default: 10000, minimum: 1000 },
    auto_refresh: { type: "boolean", default: false },
  },
  required: ["api_key"],
};

// ---------------------------------------------------------------------------
// assertConfigurationSchema（注册期结构校验）
// ---------------------------------------------------------------------------

describe("assertConfigurationSchema：v1 能力边界校验", () => {
  it("合法 schema（全部标量类型 + x-kiko-secret + enum + required）→ 通过", () => {
    expect(() => assertConfigurationSchema(SCHEMA, "weather")).not.toThrow();
  });

  it("无 properties 的空配置 schema → 合法（空表单）", () => {
    expect(() => assertConfigurationSchema({ type: "object" }, "p")).not.toThrow();
  });

  it("非对象 / 顶层非 object → 抛错且原因可查", () => {
    expect(() => assertConfigurationSchema("nope", "p")).toThrow(/必须为 JSON Schema 对象/);
    expect(() => assertConfigurationSchema({ type: "array" }, "p")).toThrow(
      /顶层 type 必须为 "object"/,
    );
    expect(() => assertConfigurationSchema({ type: "string" }, "p")).toThrow(
      /顶层 type 必须为 "object"/,
    );
  });

  it("property 含 array / 嵌套 object / 非法类型 → 抛错（指明 v1 不支持）", () => {
    expect(() =>
      assertConfigurationSchema(
        { type: "object", properties: { tags: { type: "array" } } },
        "p",
      ),
    ).toThrow(/v1 不支持的配置 schema 特性.*"array"/);
    expect(() =>
      assertConfigurationSchema(
        { type: "object", properties: { nested: { type: "object" } } },
        "p",
      ),
    ).toThrow(/v1 不支持的配置 schema 特性.*"object"/);
  });

  it("顶层 / property 级 oneOf / anyOf / allOf → 抛错", () => {
    for (const kw of ["oneOf", "anyOf", "allOf"]) {
      expect(() => assertConfigurationSchema({ type: "object", [kw]: [] }, "p")).toThrow(
        new RegExp(`v1 不支持的配置 schema 特性：${kw}`),
      );
      expect(() =>
        assertConfigurationSchema(
          { type: "object", properties: { x: { type: "string", [kw]: [] } } },
          "p",
        ),
      ).toThrow(new RegExp(`v1 不支持的配置 schema 特性：${kw}`));
    }
  });

  it("enum 配非 string 字段 → 抛错", () => {
    expect(() =>
      assertConfigurationSchema(
        { type: "object", properties: { n: { type: "number", enum: [1, 2] } } },
        "p",
      ),
    ).toThrow(/enum 仅支持 string/);
  });

  it("required 引用未声明字段 / 非字符串数组 → 抛错", () => {
    expect(() =>
      assertConfigurationSchema(
        { type: "object", properties: { a: { type: "string" } }, required: ["b"] },
        "p",
      ),
    ).toThrow(/required 引用了未声明字段：b/);
    expect(() =>
      assertConfigurationSchema({ type: "object", required: "a" }, "p"),
    ).toThrow(/required 必须为字符串数组/);
  });
});

// ---------------------------------------------------------------------------
// validateConfigValues（值校验）
// ---------------------------------------------------------------------------

describe("validateConfigValues：Ajv 校验错误列表", () => {
  it("合法值（含未知字段透传）→ 空数组", () => {
    const errors = validateConfigValues(SCHEMA, {
      api_key: "k-1",
      unit: "fahrenheit",
      legacy_field: "unknown-but-kept",
    });
    expect(errors).toEqual([]);
  });

  it("required 缺失 → path 定位到字段", () => {
    const errors = validateConfigValues(SCHEMA, { unit: "celsius" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("api_key");
  });

  it("类型错误 / enum 越界 / minimum 越界 → 全量收集（allErrors）", () => {
    const errors = validateConfigValues(SCHEMA, {
      api_key: "k",
      unit: "kelvin",
      timeout_ms: 100,
      auto_refresh: "yes",
    });
    const paths = errors.map((e) => e.path).sort();
    expect(paths).toEqual(["auto_refresh", "timeout_ms", "unit"]);
  });
});

// ---------------------------------------------------------------------------
// PluginConfigStore：read / save / hasSavedValues
// ---------------------------------------------------------------------------

describe("PluginConfigStore：读取注入值", () => {
  it("已保存值优先，未保存字段合并 schema default，未知字段透传", async () => {
    const store = new PluginConfigStore(root);
    await writeFile(
      join(root, "weather.json"),
      JSON.stringify({ api_key: "k-1", unit: "fahrenheit", legacy: "old" }),
      "utf-8",
    );

    const config = store.read("weather", SCHEMA);
    // 已保存值优先（default 不覆盖已保存的 fahrenheit）
    expect(config).toEqual({
      api_key: "k-1",
      unit: "fahrenheit",
      timeout_ms: 10000, // 未保存 → default
      auto_refresh: false, // 未保存 → default
      legacy: "old", // schema 外未知字段透传（迁移数据来源）
    });
  });

  it("未声明配置（schema undefined）→ {}（即使磁盘有残留值）", async () => {
    const store = new PluginConfigStore(root);
    await writeFile(join(root, "p.json"), JSON.stringify({ a: 1 }), "utf-8");
    expect(store.read("p")).toEqual({});
  });

  it("文件不存在 / 目录不存在 → {} 不抛错", () => {
    const store = new PluginConfigStore(join(root, "no-such-dir"));
    expect(store.read("weather", SCHEMA)).toEqual({
      unit: "celsius",
      timeout_ms: 10000,
      auto_refresh: false,
    });
  });

  it("JSON 损坏 → {} 不抛错（损坏容错，不阻断插件加载）", async () => {
    await writeFile(join(root, "broken.json"), "{oops", "utf-8");
    const store = new PluginConfigStore(root);
    expect(store.read("broken", SCHEMA)).toEqual({
      unit: "celsius",
      timeout_ms: 10000,
      auto_refresh: false,
    });
  });

  it("顶层非对象（数组）→ 按损坏处理返回 {}", async () => {
    await writeFile(join(root, "arr.json"), "[1,2]", "utf-8");
    expect(new PluginConfigStore(root).read("arr", SCHEMA)).toEqual({
      unit: "celsius",
      timeout_ms: 10000,
      auto_refresh: false,
    });
  });

  it("非法 pluginId（路径分隔符 / .. / 盘符）→ 抛错（文件名安全前提）", () => {
    const store = new PluginConfigStore(root);
    expect(() => store.read("../evil")).toThrow(/非法 pluginId/);
    expect(() => store.read("a/b")).toThrow(/非法 pluginId/);
    expect(() => store.read("a:b")).toThrow(/非法 pluginId/);
  });
});

describe("PluginConfigStore：保存", () => {
  it("表单值覆盖合并 + 未知字段保留 + 原子写回（临时文件不残留）", async () => {
    const store = new PluginConfigStore(root);
    // 预置旧值（含一个 schema 外的未知字段）
    await writeFile(
      join(root, "weather.json"),
      JSON.stringify({ api_key: "old", legacy: "keep-me" }),
      "utf-8",
    );

    const result = await store.save("weather", SCHEMA, {
      api_key: "new-key",
      unit: "celsius",
      timeout_ms: 5000,
      auto_refresh: true,
    });
    expect(result).toEqual({ ok: true });

    const saved = JSON.parse(readFileSync(join(root, "weather.json"), "utf-8"));
    expect(saved).toEqual({
      api_key: "new-key",
      unit: "celsius",
      timeout_ms: 5000,
      auto_refresh: true,
      legacy: "keep-me", // 不在表单里的未知字段保留
    });
    // 原子写：临时文件已 rename 消费，无 .tmp 残留
    expect(existsSync(join(root, "weather.tmp"))).toBe(false);
  });

  it("目录不存在 → 保存时创建（懒建目录）", async () => {
    const store = new PluginConfigStore(join(root, "fresh", "nested"));
    const result = await store.save("p", SCHEMA, { api_key: "k" });
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(root, "fresh", "nested", "p.json"), "utf-8"))).toEqual({
      api_key: "k",
    });
  });

  it("required 缺失 → 保存拒绝（主进程 Ajv 兜底），errors 供表单内联展示", async () => {
    const store = new PluginConfigStore(root);
    const result = await store.save("weather", SCHEMA, { unit: "celsius" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "api_key")).toBe(true);
    }
    // 校验失败不落盘（无半份配置）
    expect(existsSync(join(root, "weather.json"))).toBe(false);
  });

  it("类型不合法 → 保存拒绝且不落盘", async () => {
    const store = new PluginConfigStore(root);
    const result = await store.save("weather", SCHEMA, {
      api_key: "k",
      timeout_ms: "slow",
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "weather.json"))).toBe(false);
  });

  it("空 schema（无 required / 无 properties）→ 任意对象保存通过", async () => {
    const store = new PluginConfigStore(root);
    const empty: ConfigurationSchema = { type: "object" };
    const result = await store.save("p", empty, {});
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(root, "p.json"), "utf-8"))).toEqual({});
  });

  it("null 值剥离 = 清除已保存字段（表单清空语义，读取时回落 default）", async () => {
    const store = new PluginConfigStore(root);
    // 预置旧值（timeout_ms 已保存 2000）
    await store.save("weather", SCHEMA, {
      api_key: "k-1",
      unit: "celsius",
      timeout_ms: 2000,
      auto_refresh: true,
    });

    // 表单清空 timeout_ms（数值输入空 → null 上送）→ 键被清除
    const result = await store.save("weather", SCHEMA, {
      api_key: "k-1",
      unit: "celsius",
      timeout_ms: null,
      auto_refresh: true,
    });
    expect(result).toEqual({ ok: true });
    // 落盘无 timeout_ms 键（而非 null 残留）
    expect(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(readFileSync(join(root, "weather.json"), "utf-8")),
        "timeout_ms",
      ),
    ).toBe(false);
    // read 回落 default（10000）
    expect(store.read("weather", SCHEMA)["timeout_ms"]).toBe(10000);
  });
});

describe("PluginConfigStore：hasSavedValues（已配置圆点判定）", () => {
  it("无文件 / 空对象 → false；有值 → true；损坏 → false", async () => {
    const store = new PluginConfigStore(root);
    expect(store.hasSavedValues("weather")).toBe(false);

    await writeFile(join(root, "weather.json"), JSON.stringify({ api_key: "k" }), "utf-8");
    expect(store.hasSavedValues("weather")).toBe(true);

    await writeFile(join(root, "weather.json"), "{}", "utf-8");
    expect(store.hasSavedValues("weather")).toBe(false);

    await writeFile(join(root, "weather.json"), "{oops", "utf-8");
    expect(store.hasSavedValues("weather")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 文件内容持久化语义（读改写链路整体）
// ---------------------------------------------------------------------------

describe("读改写链路：保存后 read 注入合并结果", () => {
  it("save → read：default 只补未保存字段，已保存值原样注入", async () => {
    const store = new PluginConfigStore(root);
    await store.save("weather", SCHEMA, {
      api_key: "k-1",
      unit: "celsius",
      timeout_ms: 2000,
      auto_refresh: true,
    });

    const config = store.read("weather", SCHEMA);
    expect(config).toEqual({
      api_key: "k-1",
      unit: "celsius",
      timeout_ms: 2000,
      auto_refresh: true,
    });

    // 二次保存部分字段：其余字段保留（读改写，非整文件覆盖）
    await store.save("weather", SCHEMA, {
      api_key: "k-2",
      unit: "celsius",
      timeout_ms: 3000,
      auto_refresh: true,
    });
    expect(store.read("weather", SCHEMA)["api_key"]).toBe("k-2");
    expect(store.read("weather", SCHEMA)["timeout_ms"]).toBe(3000);
  });

  it("手工编辑后的合法 JSON 直接生效（文件是唯一事实源）", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "weather.json"),
      JSON.stringify({ api_key: "manual", unit: "fahrenheit", extra: 1 }),
      "utf-8",
    );
    const store = new PluginConfigStore(root);
    const config = store.read("weather", SCHEMA);
    expect(config["api_key"]).toBe("manual");
    expect(config["extra"]).toBe(1);
    expect(config["timeout_ms"]).toBe(10000); // default 补齐
    // 落盘内容核对（换行结尾的规范化 JSON）
    const raw = await readFile(join(root, "weather.json"), "utf-8");
    expect(raw.trim()).toBe(JSON.stringify({ api_key: "manual", unit: "fahrenheit", extra: 1 }));
  });
});
