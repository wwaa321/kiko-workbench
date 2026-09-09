<script setup lang="ts">
/**
 * 声明式配置表单渲染器（P-002 Phase 1，方案草案 §3.6）
 *
 * 纯受控组件：输入 schema + values，输出表单事件——IPC 保存链路归父级
 * （PluginConfigModal），本组件零 API 依赖、可复用（Phase 2/3 的 L2
 * 数据视图复用同一渲染机器）。
 *
 * 控件映射（§3.1 表格，v1 能力边界与注册期校验对齐）：
 *   string          → 文本输入（x-kiko-secret → 密码型遮蔽）
 *   string + enum   → 下拉选择（未选时占位项，required 阻断兜底）
 *   number/integer  → 数值输入（integer 步进 1；min/max 提示）
 *   boolean         → 开关（复用卡片 .switch 纯 CSS 指示器）
 *
 * required 阻断（决策 §7.5）：缺失时保存按钮禁用——不产生半份配置；
 * 主进程 Ajv 校验兜底（绕过前端的异常流量），错误经 errors prop 回流
 * 按字段内联展示。
 *
 * 清空语义：数值 / 枚举字段未填或清空 → 上送 null（主进程合并后剥离
 * = 清除已保存值，读取时回落 default）；字符串空串原样保存（"" 是
 * 合法 string 值）。
 */
import { computed, reactive, watch } from "vue";
import type {
  ConfigFieldError,
  ConfigurationProperty,
  ConfigurationSchema,
} from "../../shared.js";

const props = defineProps<{
  /** manifest 声明的配置 schema（经注册期结构校验，形状可信） */
  schema: ConfigurationSchema;
  /** 初始值（config:get 的合并结果：已保存 + default + 未知字段透传） */
  values: Record<string, unknown>;
  /** 上次保存失败的错误列表（path → 字段名，字段下方内联展示） */
  errors?: ConfigFieldError[];
  /** 保存进行中（按钮禁用防连点） */
  saving?: boolean;
}>();

const emit = defineEmits<{
  /** 保存请求（payload 含全部 schema 字段；清空的数值 / 枚举为 null） */
  save: [values: Record<string, unknown>];
  /** 取消 / 关闭（父级关闭弹窗，不产生任何写入） */
  cancel: [];
}>();

/** 字段视图模型（Object.entries 保持 schema 声明顺序，表单呈现稳定） */
interface FieldView {
  key: string;
  prop: ConfigurationProperty;
  /** 展示标签（title 缺省回退字段名） */
  label: string;
  required: boolean;
  /** x-kiko-secret → 密码型遮蔽输入（§3.5） */
  isSecret: boolean;
  /** string + enum → 下拉选择 */
  isEnum: boolean;
  /** 数值步进（integer 严格整数；number 任意精度） */
  step: string;
}

/** 字段列表（schema / values 更新时重算——弹窗复用同一组件实例） */
const fields = computed<FieldView[]>(() => {
  const required = new Set(props.schema.required ?? []);
  return Object.entries(props.schema.properties ?? {}).map(([key, prop]) => ({
    key,
    prop,
    label: prop.title ?? key,
    required: required.has(key),
    isSecret: prop["x-kiko-secret"] === true,
    isEnum: Array.isArray(prop.enum) && prop.enum.length > 0,
    step: prop.type === "integer" ? "1" : "any",
  }));
});

/** 可编辑副本（props 只读；watch 重置以支持弹窗内切换插件配置） */
const form = reactive<Record<string, unknown>>({});

watch(
  [() => props.schema, () => props.values],
  () => resetForm(),
  { immediate: true },
);

/** 按字段类型归一初始值（输入控件需要确定的绑定类型） */
function resetForm(): void {
  for (const f of fields.value) {
    const raw = props.values[f.key];
    switch (f.prop.type) {
      case "boolean":
        form[f.key] = raw === undefined ? false : Boolean(raw);
        break;
      case "number":
      case "integer":
        form[f.key] = typeof raw === "number" ? raw : null;
        break;
      default:
        form[f.key] = typeof raw === "string" ? raw : "";
    }
  }
}

/** required 完整性判定（空串 / 非有限数值 / null = 未填） */
function isMissing(f: FieldView): boolean {
  const v = form[f.key];
  if (!f.required) return false;
  if (f.prop.type === "number" || f.prop.type === "integer") {
    return typeof v !== "number" || !Number.isFinite(v);
  }
  return typeof v !== "string" || v.trim() === "";
}

/** 缺失的必填字段标签（保存按钮禁用 + 顶部缺失提示共用） */
const missingLabels = computed(() =>
  fields.value.filter((f) => isMissing(f)).map((f) => f.label),
);

/** 保存可用（required 阻断语义，决策 §7.5） */
const canSave = computed(
  () => missingLabels.value.length === 0 && props.saving !== true,
);

/** 错误按字段名分组（Ajv path 已归一为裸字段名，见 config-store） */
const errorsByPath = computed(() => {
  const map = new Map<string, ConfigFieldError[]>();
  for (const e of props.errors ?? []) {
    const list = map.get(e.path);
    if (list === undefined) map.set(e.path, [e]);
    else list.push(e);
  }
  return map;
});

/** 数值边界提示（minimum / maximum 拼接；仅展示，校验归主进程 Ajv） */
function rangeHint(f: FieldView): string {
  const parts: string[] = [];
  if (typeof f.prop.minimum === "number") parts.push(`最小 ${f.prop.minimum}`);
  if (typeof f.prop.maximum === "number") parts.push(`最大 ${f.prop.maximum}`);
  return parts.join("，");
}

/** 保存：组装全字段 payload（数值 / 枚举空值 → null 清空语义） */
function onSave(): void {
  if (!canSave.value) return;
  const payload: Record<string, unknown> = {};
  for (const f of fields.value) {
    const v = form[f.key];
    if ((f.prop.type === "number" || f.prop.type === "integer" || f.isEnum) && v === "") {
      payload[f.key] = null; // 空数值 / 未选枚举 → 清除（主进程剥离 null 键）
    } else {
      payload[f.key] = v;
    }
  }
  emit("save", payload);
}
</script>

<template>
  <form class="schema-form" @submit.prevent="onSave">
    <!-- 必填缺失提示（保存阻断的明示，避免"按钮为何禁用"困惑） -->
    <p v-if="missingLabels.length > 0" class="schema-form-missing">
      必填项未填写：{{ missingLabels.join("、") }}
    </p>

    <div v-for="f in fields" :key="f.key" class="schema-field">
      <label class="schema-field-label" :for="`cfg-${f.key}`">
        {{ f.label }}<span v-if="f.required" class="schema-required-mark">*</span>
      </label>
      <p v-if="f.prop.description !== undefined" class="schema-field-desc">
        {{ f.prop.description }}
      </p>

      <!-- string + enum → 下拉选择（未选占位；required 未选走阻断） -->
      <select
        v-if="f.isEnum"
        :id="`cfg-${f.key}`"
        v-model="form[f.key]"
        class="schema-input"
        :disabled="props.saving"
      >
        <option value="" disabled>请选择</option>
        <option
          v-for="opt in (f.prop.enum as unknown[])"
          :key="String(opt)"
          :value="opt"
        >
          {{ String(opt) }}
        </option>
      </select>

      <!-- boolean → 开关（复用卡片 .switch 纯 CSS 指示器） -->
      <label v-else-if="f.prop.type === 'boolean'" class="switch schema-switch">
        <input
          :id="`cfg-${f.key}`"
          type="checkbox"
          :checked="form[f.key] === true"
          :disabled="props.saving"
          @change="form[f.key] = ($event.target as HTMLInputElement).checked"
        />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </label>

      <!-- number / integer → 数值输入（integer 步进 1） -->
      <input
        v-else-if="f.prop.type === 'number' || f.prop.type === 'integer'"
        :id="`cfg-${f.key}`"
        v-model.number="form[f.key]"
        class="schema-input"
        type="number"
        :step="f.step"
        :min="f.prop.minimum"
        :max="f.prop.maximum"
        :disabled="props.saving"
        :placeholder="f.prop.default !== undefined ? String(f.prop.default) : ''"
      />

      <!-- string → 文本输入（secret → 密码型遮蔽，§3.5） -->
      <input
        v-else
        :id="`cfg-${f.key}`"
        v-model="form[f.key]"
        class="schema-input"
        :type="f.isSecret ? 'password' : 'text'"
        :disabled="props.saving"
        :placeholder="f.prop.default !== undefined ? String(f.prop.default) : ''"
        :autocomplete="f.isSecret ? 'new-password' : 'off'"
      />

      <!-- 数值边界提示（前端提示，校验归主进程） -->
      <p v-if="rangeHint(f) !== ''" class="schema-field-hint">{{ rangeHint(f) }}</p>

      <!-- 保存失败的内联错误（path 定位到本字段） -->
      <p
        v-for="(err, i) in errorsByPath.get(f.key) ?? []"
        :key="i"
        class="schema-field-error"
      >
        {{ err.message }}
      </p>
    </div>

    <div class="schema-form-actions">
      <button type="submit" class="schema-save" :disabled="!canSave">
        {{ props.saving ? "保存中…" : "保存" }}
      </button>
      <button type="button" class="schema-cancel" :disabled="props.saving" @click="emit('cancel')">
        取消
      </button>
    </div>
  </form>
</template>
