/**
 * 插件配置存储（P-002 Phase 1：声明式配置）
 *
 * 职责（方案草案 §3.2 / §3.5）：
 *   - 独立根目录存储：<configRoot>/<pluginId>.json（userData/plugin-config/，
 *     与插件目录解耦——卸载不删配置、同 id 重装自动恢复、导出 zip 不含配置）
 *   - 读取注入值：已保存值合并 schema default，未知字段（schema 已删除 /
 *     改名的旧字段）原样透传——插件做配置结构迁移的数据来源
 *   - 保存：读旧值 → 表单字段覆盖合并（保留不在表单里的未知字段）→
 *     Ajv 校验合并结果 → 原子写回（临时文件 + rename，沿用 settings.json
 *     的读改写惯例）
 *   - 损坏容错：配置文件 JSON 损坏 → 注入空对象 + 主进程日志警告，
 *     不阻断插件加载（配置缺失的后果由插件在 handle 中明确反馈）
 *
 * 注册期结构校验（assertConfigurationSchema，registry 消费）：
 * v1 渲染器能力边界——顶层必须 object、property 仅标量类型
 * （string / number / integer / boolean），array / 嵌套 object /
 * oneOf / anyOf / allOf 注册期拒绝（错误信息指明 v1 不支持）。
 *
 * 安全：pluginId 即文件名——单段校验（拒绝 `.`/`..`/路径分隔符/盘符，
 * 与 plugin-package 的 isSafeZipSegment 同策略），防越界读写。
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
// NodeNext 下 ajv（CJS）默认导入的类型解析有坑（TS2709），命名导入双端安全（invocation.ts 同款）
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

// ---------------------------------------------------------------------------
// 类型（draft-07 子集；x-kiko- 前缀为 JSON Schema 规范保留的供应商扩展位）
// ---------------------------------------------------------------------------

/** 配置 schema：v1 仅支持顶层 object + 扁平标量属性 */
export interface ConfigurationSchema {
  type: "object";
  /** 字段定义（键即字段名） */
  properties?: Record<string, ConfigurationProperty>;
  /** 必填字段名列表（表单保存层阻断语义，见方案草案 §3.6） */
  required?: string[];
  /** 展示信息与 x-kiko- 扩展关键字透传（Ajv 默认忽略未知关键字） */
  [key: string]: unknown;
}

/** 单个配置字段定义（v1 标量类型 + 表单展示/约束字段） */
export interface ConfigurationProperty {
  type: "string" | "number" | "integer" | "boolean";
  /** 表单标签（缺省回退字段名） */
  title?: string;
  /** 字段说明（表单内联提示） */
  description?: string;
  /** 缺省值（注入时合并：仅当未保存时生效） */
  default?: unknown;
  /** 枚举（仅 string：渲染为下拉选择） */
  enum?: unknown[];
  /** 数值边界（前端提示） */
  minimum?: number;
  maximum?: number;
  /** 供应商扩展：秘密字段（表单密码型遮蔽输入，方案草案 §3.5） */
  "x-kiko-secret"?: boolean;
  [key: string]: unknown;
}

/** 值校验错误（表单按 path 内联展示到对应字段下方） */
export interface ConfigFieldError {
  /** 字段名（Ajv dataPath 去前导 "."，如 "api_key"） */
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// 注册期结构校验（v1 渲染器能力边界）
// ---------------------------------------------------------------------------

/** v1 支持的标量类型集合（渲染器控件映射边界，方案草案 §3.1 表格） */
const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);

/** 结构校验中拒绝的组合关键字（v1 不支持，声明即注册期拒绝） */
const COMBINATOR_KEYWORDS = ["oneOf", "anyOf", "allOf"] as const;

/**
 * 注册期结构校验：不合法抛 Error（registry 捕获后置插件 error 态，
 * 与 manifest 损坏同路径——不影响其余插件）。
 * @param schema manifest.contributes.configuration 的值
 * @param pluginId 错误信息归属（排障定位）
 */
export function assertConfigurationSchema(schema: unknown, pluginId: string): void {
  const where = `插件 ${pluginId} 的 contributes.configuration`;
  if (typeof schema !== "object" || schema === null) {
    throw new Error(`${where} 必须为 JSON Schema 对象`);
  }
  const s = schema as Record<string, unknown>;
  if (s["type"] !== "object") {
    throw new Error(`${where} 顶层 type 必须为 "object"`);
  }
  for (const kw of COMBINATOR_KEYWORDS) {
    if (s[kw] !== undefined) {
      throw new Error(`${where} 含 v1 不支持的配置 schema 特性：${kw}`);
    }
  }
  // properties 缺省 = 空配置表单（合法），required 检查仍需执行（下方）
  const properties = s["properties"];
  if (
    properties !== undefined &&
    (typeof properties !== "object" || properties === null || Array.isArray(properties))
  ) {
    throw new Error(`${where} 的 properties 必须为对象`);
  }
  const propEntries: Array<[string, unknown]> =
    properties === undefined ? [] : Object.entries(properties);
  for (const [key, raw] of propEntries) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${where} 的属性 ${key} 必须为对象`);
    }
    const prop = raw as Record<string, unknown>;
    if (!SCALAR_TYPES.has(String(prop["type"]))) {
      throw new Error(
        `${where} 的属性 ${key} 含 v1 不支持的配置 schema 特性：type "${String(prop["type"])}"（v1 仅支持 string/number/integer/boolean）`,
      );
    }
    for (const kw of COMBINATOR_KEYWORDS) {
      if (prop[kw] !== undefined) {
        throw new Error(`${where} 的属性 ${key} 含 v1 不支持的配置 schema 特性：${kw}`);
      }
    }
    // enum 仅配 string（渲染为下拉；number enum v1 不做，需要时再扩展渲染器）
    if (prop["enum"] !== undefined && prop["type"] !== "string") {
      throw new Error(`${where} 的属性 ${key}：enum 仅支持 string 类型字段`);
    }
  }
  // required 必须是已知字段名列表（拼写错误在此暴露，而非静默失配）
  const required = s["required"];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => typeof r !== "string")) {
      throw new Error(`${where} 的 required 必须为字符串数组`);
    }
    // properties 缺省（空配置表单）时 known 为空集 → 任何 required 引用均未声明
    const known = new Set(Object.keys(properties ?? {}));
    for (const r of required) {
      if (!known.has(r)) {
        throw new Error(`${where} 的 required 引用了未声明字段：${r}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 值校验（保存路径的 Ajv 兜底；错误列表供表单内联展示）
// ---------------------------------------------------------------------------

/**
 * Ajv 单例（draft-07 默认，与 invocation.ts 同链路；allErrors 收全量错误）。
 * strictSchema 关闭：x-kiko- 前缀是 JSON Schema 规范保留的供应商扩展位，
 * Ajv 8 默认 strict 模式会拒绝未知关键字（capabilities 链路无自定义
 * 关键字未踩到；配置 schema 的 x-kiko-secret 必须放行）。
 */
const ajv = new Ajv({ allErrors: true, strictSchema: false });

/** compile 结果缓存（schema 对象引用为键——PluginRecord 生命周期内引用稳定） */
const compiledSchemas = new WeakMap<ConfigurationSchema, ValidateFunction>();

/** 取（或编译）schema 的校验函数 */
function getValidator(schema: ConfigurationSchema): ValidateFunction {
  let validate = compiledSchemas.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    compiledSchemas.set(schema, validate);
  }
  return validate;
}

/**
 * 校验配置值（合并结果整体校验；未知字段默认放行——additionalProperties
 * 缺省 true，透传语义不冲突）。返回错误列表（空数组 = 通过）。
 */
export function validateConfigValues(
  schema: ConfigurationSchema,
  values: Record<string, unknown>,
): ConfigFieldError[] {
  const validate = getValidator(schema);
  if (validate(values)) return [];
  return (validate.errors ?? []).map((e) => ({
    // 普通错误：instancePath 为 JSON Pointer 风格 "/api_key"，去前导斜杠
    // 即字段名；required 错误：instancePath 指向父对象（根级空串），
    // 字段名在 params.missingProperty——两者归一为裸字段名供表单匹配
    path:
      e.keyword === "required"
        ? String(
            (e.params as { missingProperty?: string }).missingProperty ?? "",
          )
        : e.instancePath.replace(/^\//, ""),
    message: e.message ?? "校验失败",
  }));
}

// ---------------------------------------------------------------------------
// PluginConfigStore
// ---------------------------------------------------------------------------

/** 读取依赖的最小接口（ExecutionRuntime 注入用；desktop 传本类实例） */
export interface PluginConfigReader {
  /** 读取注入值：已保存值合并 schema default + 未知字段透传；未声明配置返回 {} */
  read(pluginId: string, schema?: ConfigurationSchema): Record<string, unknown>;
}

/**
 * pluginId 单段安全校验（文件名安全前提）：拒绝 `.`/`..`/路径分隔符/盘符。
 * 与 plugin-package 的 isSafeZipSegment 同策略。
 */
function assertSafePluginId(pluginId: string): void {
  if (
    pluginId === "" ||
    pluginId === "." ||
    pluginId === ".." ||
    pluginId.includes("/") ||
    pluginId.includes("\\") ||
    pluginId.includes(":")
  ) {
    throw new Error(`非法 pluginId（禁止路径分隔符与盘符）：${pluginId}`);
  }
}

/**
 * 插件配置存储（每插件一个 JSON 文件，读改写 + 原子落盘）。
 * 损坏容错：读侧 JSON 损坏 → 空对象 + 日志警告（不抛错，不阻断加载）；
 * 写侧失败 → 抛错（保存失败必须让用户知道，静默会丢失录入）。
 */
export class PluginConfigStore implements PluginConfigReader {
  constructor(private readonly configRoot: string) {}

  /** 配置文件路径（<configRoot>/<pluginId>.json） */
  private fileOf(pluginId: string): string {
    assertSafePluginId(pluginId);
    return join(this.configRoot, `${pluginId}.json`);
  }

  /**
   * 读原始已保存值（无 default 合并）：
   * 文件不存在 / JSON 损坏 → {}（损坏时主进程日志警告）。
   */
  private readRaw(pluginId: string): Record<string, unknown> {
    const file = this.fileOf(pluginId);
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("顶层必须为对象");
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      // 损坏容错（方案草案 §3.2）：空对象 + 警告，不阻断插件加载
      console.warn(
        `[config-store] 插件 ${pluginId} 配置文件损坏，按空配置处理：${e instanceof Error ? e.message : String(e)}`,
      );
      return {};
    }
  }

  /**
   * 读取注入值（load 命令 config 字段的数据源）：
   *   - schema 未声明（undefined）→ {}（方案草案 §3.4：未声明配置的插件注入空对象）
   *   - 已保存值优先；schema 声明且未保存的字段合并 default；
   *     schema 未声明的已保存字段（未知字段）原样透传（插件迁移数据来源）
   */
  read(pluginId: string, schema?: ConfigurationSchema): Record<string, unknown> {
    const saved = this.readRaw(pluginId);
    if (schema === undefined) return {};
    const merged: Record<string, unknown> = { ...saved };
    const properties = schema.properties ?? {};
    for (const [key, prop] of Object.entries(properties)) {
      if (!(key in saved) && prop.default !== undefined) {
        merged[key] = prop.default;
      }
    }
    return merged;
  }

  /**
   * 表单保存：读旧值 → 表单字段覆盖合并（未知字段保留）→ null 剥离 →
   * Ajv 校验 → 原子写回（临时文件 + rename）。校验失败返回错误列表
   * （调用方决定表单内联展示；主进程兜底语义，正常流量下前端已做
   * required 阻断）。
   *
   * null 语义（表单"清空"约定）：数值型字段清空输入时表单上送 null，
   * 合并后剥离该键 = 清除已保存值（读取时回落 default / 视为未设置）；
   * 若直接丢弃 null 键则旧值残留（spread 合并不覆盖缺席键），故剥离
   * 必须发生在合并之后。
   */
  async save(
    pluginId: string,
    schema: ConfigurationSchema,
    formValues: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; errors: ConfigFieldError[] }> {
    // 合并：表单值覆盖同名字段；不在表单里的未知字段保留（透传语义）
    const merged: Record<string, unknown> = { ...this.readRaw(pluginId), ...formValues };
    // null 剥离（清空语义，见方法注释）
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) delete merged[key];
    }
    const errors = validateConfigValues(schema, merged);
    if (errors.length > 0) return { ok: false, errors };

    // 原子写：临时文件 + rename（沿用 settings.json 读改写惯例；Windows
    // 下 rename 支持覆盖已存在目标）
    const target = this.fileOf(pluginId);
    await mkdir(this.configRoot, { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    await rename(tmp, target);
    return { ok: true };
  }

  /**
   * 是否存在已保存配置值（UI"已配置"圆点判定）：
   * 有非空配置对象即已配置——required 阻断保存（§3.6）保证能保存成功
   * 的配置必满足必填项，无需在此重复校验 required。
   */
  hasSavedValues(pluginId: string): boolean {
    return Object.keys(this.readRaw(pluginId)).length > 0;
  }
}
