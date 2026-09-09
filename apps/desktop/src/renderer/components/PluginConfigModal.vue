<script setup lang="ts">
/**
 * 插件设置模态（P-002 Phase 1，方案草案 §3.6 保存流）
 *
 * 组合 SchemaForm 渲染器 + IPC 保存链路（渲染器保持纯受控，本组件是
 * 配置面唯一的数据出口）：
 *   open(plugin) → config:get（schema + 合并值回显）→ 用户编辑 →
 *   required 前置阻断（SchemaForm 内）→ config:save → 主进程 Ajv 兜底
 *   → 成功：关闭 + 卡片刷新（config_saved 圆点）+ 主进程已终止插件进程
 *   （下次调用懒启动注入新配置）；失败：errors 回流表单内联展示。
 */
import { onMounted, onUnmounted, ref } from "vue";
import { getApi } from "../api.js";
import { actionError, actionNotice, loadPlugins } from "../stores/plugins.js";
import SchemaForm from "./SchemaForm.vue";
import type { ConfigFieldError, PluginCard, PluginConfigView } from "../../shared.js";

/** 设置弹窗开关 */
const configOpen = ref(false);
/** 目标插件卡片（弹窗标题 + 保存归属） */
const target = ref<PluginCard | null>(null);
/** 配置视图（schema + 合并值；null = 加载中或不可用） */
const view = ref<PluginConfigView | null>(null);
/** 加载失败信息（模态内展示；与全局 actionError 分离） */
const loadError = ref<string | null>(null);
/** 保存进行中（表单与按钮禁用防连点） */
const saving = ref(false);
/** 上次保存失败的字段错误（回流 SchemaForm 内联展示） */
const saveErrors = ref<ConfigFieldError[]>([]);

/**
 * 打开设置弹窗（PluginPanel 卡片"设置"按钮唤起）。
 * defineExpose 供父组件调用；加载失败模态内展示可重试（重新 open）。
 */
async function open(plugin: PluginCard): Promise<void> {
  target.value = plugin;
  configOpen.value = true;
  view.value = null;
  loadError.value = null;
  saveErrors.value = [];
  try {
    const result = await getApi().getPluginConfig(plugin.id);
    if (result === null) {
      // 防御：未声明配置的插件（卡片入口已隐藏，理论不可达）——明示并关闭
      loadError.value = "该插件未声明配置";
      return;
    }
    view.value = result;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

/** 关闭弹窗（状态复位；无写入副作用——未保存的编辑自然丢弃） */
function close(): void {
  configOpen.value = false;
  target.value = null;
  view.value = null;
  loadError.value = null;
  saveErrors.value = [];
}

/** 保存配置（SchemaForm save 事件；payload 全字段，空值为 null） */
async function onSave(values: Record<string, unknown>): Promise<void> {
  const plugin = target.value;
  if (plugin === null || saving.value) return;
  saving.value = true;
  saveErrors.value = [];
  try {
    const result = await getApi().savePluginConfig(plugin.id, values);
    if (result.ok) {
      // 成功：关闭 + 卡片刷新（"已配置"圆点）+ 轻提示
      close();
      await loadPlugins();
      actionNotice.value = `配置已保存：${plugin.name}（下次调用生效）`;
      actionError.value = null;
    } else {
      // 校验失败：errors 回流表单内联展示（弹窗保持打开）
      saveErrors.value = result.errors;
    }
  } catch (e) {
    // IPC 层异常（插件被卸载等竞态）：模态内展示，用户可取消
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/** Escape 关闭模态（全局监听，open 态才响应；保存中不响应防误触） */
function onKeydown(e: KeyboardEvent): void {
  if (configOpen.value && e.key === "Escape" && !saving.value) close();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

defineExpose({ open });
</script>

<template>
  <!-- 插件设置模态（复用 guide-* 模态骨架样式，同 McpGuideModal 惯例） -->
  <div v-if="configOpen" class="guide-overlay" @click.self="!saving && close()">
    <div class="guide-modal config-modal" role="dialog" aria-label="插件设置">
      <div class="guide-head">
        <h3>设置 · {{ target?.name }}</h3>
        <button class="guide-close" :disabled="saving" @click="close">关闭</button>
      </div>

      <p class="guide-hint">
        配置保存在本机（与插件目录分离，卸载重装不丢失），仅用于该插件的
        本地运行。秘密字段以遮蔽方式展示，值不会出现在对话与调用日志中。
        保存后插件进程将重启，下次调用即使用新配置。
      </p>

      <p v-if="loadError !== null" class="guide-error">配置加载失败：{{ loadError }}</p>

      <!-- 表单区（加载完成才渲染；滚动容器与 guide-text 同高度策略） -->
      <div v-if="view !== null" class="config-body">
        <SchemaForm
          :schema="view.schema"
          :values="view.values"
          :errors="saveErrors"
          :saving="saving"
          @save="onSave"
          @cancel="close"
        />
      </div>
    </div>
  </div>
</template>
