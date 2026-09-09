/**
 * preload 桥接（M2-06）：contextBridge 暴露 window.workbench API
 *
 * 安全基线：contextIsolation 开启（main.ts BrowserWindow 配置），
 * 渲染进程不直接触碰 ipcRenderer——全部经本层封装（通道名不外泄、
 * 信封解包还原 RpcError 语义）。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  WORKBENCH_ARTIFACT_LIST,
  WORKBENCH_ARTIFACT_SHOW,
  WORKBENCH_CLIPBOARD_WRITE,
  WORKBENCH_CONNECTION_INFO,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_HISTORY_CLEAR,
  WORKBENCH_INVOCATION_DETAIL,
  WORKBENCH_INVOCATION_LIST,
  WORKBENCH_PLUGIN_CONFIG_GET,
  WORKBENCH_PLUGIN_CONFIG_SAVE,
  WORKBENCH_PLUGIN_EXPORT,
  WORKBENCH_PLUGIN_IMPORT,
  WORKBENCH_PLUGIN_LIST,
  WORKBENCH_PLUGIN_TOGGLE,
  WORKBENCH_PLUGIN_UI_OPEN,
  WORKBENCH_PLUGIN_UNINSTALL,
  type IpcEnvelope,
  type WorkbenchApi,
} from "./shared.js";

/** 信封解包：ok → value；失败 → 抛携带 code 的 Error（渲染侧 catch 分支用） */
function unwrap<T>(envelope: IpcEnvelope<T>): T {
  if (envelope.ok) return envelope.value;
  const err = new Error(envelope.message) as Error & { code: number };
  err.code = envelope.code;
  throw err;
}

/** invoke 快捷封装（handle + unwrap 链） */
function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((envelope: IpcEnvelope<T>) => unwrap(envelope));
}

const api: WorkbenchApi = {
  listPlugins: () => call(WORKBENCH_PLUGIN_LIST),
  togglePlugin: (pluginId, enabled) => call(WORKBENCH_PLUGIN_TOGGLE, pluginId, enabled),
  // 导入/导出/卸载：文件对话框由主进程弹出（渲染进程无 dialog 权限）
  importPlugin: () => call(WORKBENCH_PLUGIN_IMPORT),
  exportPlugin: (pluginId) => call(WORKBENCH_PLUGIN_EXPORT, pluginId),
  uninstallPlugin: (pluginId) => call(WORKBENCH_PLUGIN_UNINSTALL, pluginId),
  // 插件配置（P-002）：设置表单读写（值对象透传，主进程校验兜底）
  getPluginConfig: (pluginId) => call(WORKBENCH_PLUGIN_CONFIG_GET, pluginId),
  savePluginConfig: (pluginId, values) =>
    call(WORKBENCH_PLUGIN_CONFIG_SAVE, pluginId, values),
  // 微应用界面（P-003）：单实例打开（已开聚焦；主进程窗口管理）
  openPluginUi: (pluginId) => call(WORKBENCH_PLUGIN_UI_OPEN, pluginId),
  // 查询参数透传（缺省 {}：主进程补默认 limit=50/offset=0）
  listInvocations: (query) => call(WORKBENCH_INVOCATION_LIST, query ?? {}),
  getExecution: (invocationId) => call(WORKBENCH_INVOCATION_DETAIL, invocationId),
  // 清空历史：仅终态记录；返回清理条数（SQLite 装配时附带 VACUUM 回收）
  clearHistory: () => call(WORKBENCH_HISTORY_CLEAR),
  showArtifactInFolder: (absolutePath) => call(WORKBENCH_ARTIFACT_SHOW, absolutePath),
  // 产物分页查询：参数透传（缺省 {}：主进程补默认 limit=50/offset=0）
  listArtifacts: (query) => call(WORKBENCH_ARTIFACT_LIST, query ?? {}),
  // 单向事件推送订阅：EventEmitter 语义（多 listener 各自收全量）。
  // 包装函数必须固定引用——off 按引用注销，闭包内新建会退订失效
  subscribeEvents: (listener) => {
    const wrapped = (_e: unknown, event: unknown): void => listener(event);
    ipcRenderer.on(WORKBENCH_EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.off(WORKBENCH_EVENT_CHANNEL, wrapped);
    };
  },
  // Agent 接入信息（端点 / token / 首次引导标记）
  getConnectionInfo: () => call(WORKBENCH_CONNECTION_INFO),
  // 写系统剪贴板（接入指南复制）
  writeClipboard: (text) => call(WORKBENCH_CLIPBOARD_WRITE, text),
};

contextBridge.exposeInMainWorld("workbench", api);
