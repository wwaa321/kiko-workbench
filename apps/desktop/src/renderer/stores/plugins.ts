/**
 * 插件 store（模块级单例）：列表 + 启停 + 导入/导出/删除
 *
 * 原逻辑自 App.vue 原样迁移（零功能变更）；autopilot m2-07 的
 * setPluginEnabled / fetchPluginCard 断言锚点依赖本模块导出。
 */
import { ref } from "vue";
import { getApi } from "../api.js";
import type { PluginCard } from "../../shared.js";

/** 插件卡片列表（App 启动快照 + 操作后重拉） */
export const plugins = ref<PluginCard[]>([]);
/** 启停操作进行中的插件 id 集合（开关禁用防连点重复提交） */
export const toggling = ref<Set<string>>(new Set());
/** 启停操作失败信息（操作级错误与装配级 error 分开展示） */
export const actionError = ref<string | null>(null);
/** 操作成功提示（导入 / 导出 / 删除的轻反馈；新操作或出错时清除） */
export const actionNotice = ref<string | null>(null);
/** 导入进行中（按钮禁用防连点：对话框 + 解包 + rescan 有可感知耗时） */
export const importing = ref(false);
/** 导出 / 删除进行中的插件 id 集合（按钮禁用防连点） */
export const managing = ref<Set<string>>(new Set());
/** 微应用界面打开进行中的插件 id 集合（P-003；按钮禁用防连点） */
export const openingUi = ref<Set<string>>(new Set());
/** 删除二次确认中的插件 id（null = 无确认态；两步式确认防误删） */
export const confirmingRemove = ref<string | null>(null);

/** 拉取插件卡片列表（启动快照 / 操作后刷新共用） */
export async function loadPlugins(): Promise<void> {
  plugins.value = await getApi().listPlugins();
}

/** 插件状态 → 中文标签（纯 CSS 指示器配色见 styles.css） */
export function statusLabel(status: PluginCard["status"]): string {
  switch (status) {
    case "enabled":
      return "运行中";
    case "disabled":
      return "已停用";
    case "error":
      return "异常";
  }
}

/**
 * 启停开关 / "重新启用"按钮共用处理（M2-07 核心：启停即时生效）
 *
 * 成功 → 重拉插件列表即刻反映新状态；失败 → 操作级错误展示（信封
 * code 语义已在 preload 解包还原，这里只呈现 message）。
 * 返回是否成功（autopilot 断言用）。
 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
  if (toggling.value.has(pluginId)) return false;
  toggling.value.add(pluginId);
  actionError.value = null;
  try {
    await getApi().togglePlugin(pluginId, enabled);
    plugins.value = await getApi().listPlugins();
    return true;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    toggling.value.delete(pluginId);
  }
}

/** 开关 change 事件 → setPluginEnabled（checkbox checked 即目标状态） */
export function onSwitchChange(pluginId: string, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  void setPluginEnabled(pluginId, checked);
}

/**
 * 导入插件：主进程弹 zip 选择框 → 校验部署 → rescan。
 * 用户取消（null）静默返回；成功重拉列表 + 轻提示；
 * 失败（ID 冲突 40008 / 包非法 -32602）走 actionError 展示。
 */
export async function importPlugin(): Promise<void> {
  if (importing.value) return;
  importing.value = true;
  actionError.value = null;
  actionNotice.value = null;
  try {
    const result = await getApi().importPlugin();
    if (result === null) return; // 用户取消对话框——非错误
    plugins.value = await getApi().listPlugins();
    actionNotice.value = `插件已导入：${result.plugin_id}`;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    importing.value = false;
  }
}

/**
 * 导出第三方插件为 zip（分享用）：主进程弹保存框。
 * 成功提示导出路径（用户下一步去找文件）；取消静默。
 */
export async function exportPlugin(pluginId: string): Promise<void> {
  if (managing.value.has(pluginId)) return;
  managing.value.add(pluginId);
  actionError.value = null;
  actionNotice.value = null;
  try {
    const path = await getApi().exportPlugin(pluginId);
    if (path === null) return; // 用户取消对话框——非错误
    actionNotice.value = `已导出到：${path}`;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    managing.value.delete(pluginId);
  }
}

/**
 * 删除第三方插件（两步确认后执行）：终止进程 → 删目录 → 移除注册。
 * 成功重拉列表；失败（40009 内置保护 / 文件占用）走 actionError。
 */
export async function uninstallPlugin(plugin: PluginCard): Promise<void> {
  if (managing.value.has(plugin.id)) return;
  managing.value.add(plugin.id);
  confirmingRemove.value = null; // 确认态即点即消（防列表刷新后悬挂）
  actionError.value = null;
  actionNotice.value = null;
  try {
    await getApi().uninstallPlugin(plugin.id);
    plugins.value = await getApi().listPlugins();
    actionNotice.value = `已删除插件：${plugin.name}`;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    managing.value.delete(plugin.id);
  }
}

/**
 * 打开插件微应用界面（P-003 v1）：主进程单实例窗口管理（已开聚焦）。
 * 失败（40005 非微应用 / 未启用）走 actionError 展示；成功无轻提示
 * （窗口本身即反馈，叠加提示冗余）。
 */
export async function openPluginUi(pluginId: string): Promise<void> {
  if (openingUi.value.has(pluginId)) return;
  openingUi.value.add(pluginId);
  actionError.value = null;
  try {
    await getApi().openPluginUi(pluginId);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    openingUi.value.delete(pluginId);
  }
}

/** 拉取插件状态（autopilot 断言辅助；未找到返回 undefined） */
export async function fetchPluginCard(pluginId: string): Promise<PluginCard | undefined> {
  plugins.value = await getApi().listPlugins();
  return plugins.value.find((p) => p.id === pluginId);
}
