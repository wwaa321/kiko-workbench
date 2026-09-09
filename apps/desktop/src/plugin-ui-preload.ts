/**
 * 微应用窗口 preload（P-003 v1，草案附录 C）
 *
 * 桥面刻意极窄（与主窗口 preload 的全量 workbench API 对比）：
 *   - 仅 onMessage 单向订阅（后端 ctx.ui.send → 前端）
 *   - 无 invoke / 无文件 / 无系统交互——微应用对宿主的全部能力面
 *     就是"接收推送"（v1 决策；前端 → 后端上报留 v2，届时再扩桥）
 *
 * 安全基线：contextIsolation 开启（plugin-ui.ts BrowserWindow 配置），
 * 页面脚本只能经 window.kikoPluginUi 订阅消息，够不到 ipcRenderer。
 */
import { contextBridge, ipcRenderer } from "electron";
import { PLUGIN_UI_MESSAGE_CHANNEL, type KikoPluginUiApi } from "./shared.js";

const api: KikoPluginUiApi = {
  onMessage: (listener) => {
    // 包装函数固定引用——off 按引用注销，闭包内新建会退订失效
    //（与主窗口 preload subscribeEvents 同款约定）
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(PLUGIN_UI_MESSAGE_CHANNEL, wrapped);
    return () => {
      ipcRenderer.off(PLUGIN_UI_MESSAGE_CHANNEL, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("kikoPluginUi", api);
