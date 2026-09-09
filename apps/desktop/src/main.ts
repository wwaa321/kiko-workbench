/**
 * Electron 应用壳入口（M2-06；设计文档第 3 / 10 节）
 *
 * 与 headless.ts 共享装配（bootstrap.ts），差异仅在宿主形态：
 *   - BrowserWindow + Vue 3 渲染进程（dev：Vite dev server HMR；
 *     prod：vite build 产物 dist/renderer/index.html）
 *   - 四组 IPC 通道注册（ipc.ts；UI 直调 core，不走网络协议）
 *   - 服务型工具常驻：关闭按钮 → 隐藏到系统托盘（tray.ts），仅托盘
 *     菜单"退出"走 app.quit()（headless 无窗口不受影响）
 *
 * 入口分发：main 字段保持 dist/headless.js（冒烟脚本兼容），本入口经
 * KIKO_SHELL=1 由 headless.ts 动态加载（内部自注册 whenReady）。
 */
import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bootstrapWorkbench,
  resolveAuthToken,
  resolveDbPath,
  resolveDocumentsDir,
  resolvePluginsRoot,
  resolveSettingsPath,
  resolveUserPluginsRoot,
  resolveWorkspaceRoot,
  resolveWsPort,
} from "./bootstrap.js";
import { registerWorkbenchIpc } from "./ipc.js";
import { createWorkbenchTray, type WorkbenchTray } from "./tray.js";
import { PluginUiManager } from "./plugin-ui.js";

/** 当前模块目录（ESM 无 __dirname；主进程产物 dist/main.js → 加载同目录 renderer/） */
const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Vite dev server 地址（dev 脚本注入；缺省走 prod 静态产物） */
const DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

/**
 * 真正退出标志（托盘常驻核心时序）：
 * app.quit() → before-quit 置位 → 窗口 close 事件放行；
 * 用户点 X / Alt+F4 → close 事件时未置位 → preventDefault + hide。
 * 不区分两者会导致"永远退不出去"或"关闭即退出"两极。
 */
let isQuitting = false;

/** 壳主流程：装配 core → 创建窗口 → 注册 IPC → 托盘 → 就绪报告 */
async function main(): Promise<void> {
  const pluginsRoot = resolvePluginsRoot();
  if (!existsSync(pluginsRoot)) {
    console.error(`[kiko-shell] 插件目录不存在：${pluginsRoot}（registry 将为空）`);
  }

  const settingsPath = resolveSettingsPath();
  // 微应用管理器先于 bootstrap 构造（relay 构造期即可注入 runtime，
  // registry / runtime 依赖 bootstrap 完成后 attach——两段式解循环依赖）
  const pluginUi = new PluginUiManager();
  const modules = await bootstrapWorkbench({
    documentsDir: resolveDocumentsDir(app.getPath("documents")),
    workspaceRoot: resolveWorkspaceRoot(settingsPath),
    pluginsRoot,
    userPluginsRoot: resolveUserPluginsRoot(),
    wsPort: resolveWsPort(),
    dbPath: resolveDbPath(),
    authToken: resolveAuthToken(),
    // P-003：ctx.ui.send → 微应用窗口投递中继
    uiRelay: pluginUi.relay,
  });
  // registry + runtime 接线 + kiko-plugin:// 协议注册（app 已 ready）
  pluginUi.attach({ registry: modules.registry, runtime: modules.runtime });

  // 托盘句柄（窗口创建后初始化；will-quit / close 拦截闭包引用）
  let tray: WorkbenchTray | undefined;

  // 真正退出前置标志（区分"关闭到托盘"与"退出"，见 isQuitting 注释）
  app.on("before-quit", () => {
    isQuitting = true;
  });

  // 优雅退出：与 headless 同语义（WS 关闭 + 插件进程回收 + SQLite 关闭）
  app.on("will-quit", () => {
    tray?.destroy(); // 托盘图标销毁防残留（进程死后鼠标划过才消失的体验问题）
    pluginUi.destroyAll(); // P-003：微应用窗口随宿主退出关闭
    void modules.wsServer.stop();
    modules.runtime.dispose();
    modules.closeStores?.();
  });

  const win = await createWindow(modules, settingsPath, pluginUi);

  // 关闭到托盘：非退出路径拦截 close → 隐藏窗口（服务常驻：WS / 插件 /
  // SQLite 全保活）；window-all-closed 不触发，仅托盘"退出"终结进程
  win.on("close", (event) => {
    if (isQuitting) return; // 退出路径放行（before-quit 已置位）
    event.preventDefault();
    win.hide();
    tray?.notifyHiddenToTray(); // 首次隐藏气泡（内部有标记持久化，仅弹一次）
  });
  tray = createWorkbenchTray(win, settingsPath);

  // 单实例唤醒：二次启动的实例拿不到锁即退出（见模块底部锁注册），
  // 其 second-instance 事件转发到本实例——唤起主窗口（托盘常驻时用户
  // 以为程序没开而重复双击的标准体验路径）
  app.on("second-instance", () => {
    win.show();
    win.focus();
  });

  // 就绪报告（smoke-shell.mjs 解析锚点 + 日常排障）
  const plugins = modules.registry.listPlugins();
  console.log(
    `[kiko-shell] ready: workspace=${modules.workspace.workspaceRoot} plugins=${plugins.length}`,
  );
  console.log(
    `[kiko-shell] ws: ws://127.0.0.1:${modules.wsServer.port} http: http://127.0.0.1:${modules.wsServer.port}/rpc` +
      `（鉴权${process.env["KIKO_NO_AUTH"] === "1" ? "已禁用" : "已启用"}）`,
  );
}

/**
 * 创建主窗口并完成接线（安全基线：contextIsolation + preload，禁 nodeIntegration）。
 *
 * 时序关键：IPC handler 与事件监听必须在 loadFile/loadURL **之前**注册——
 * 渲染进程加载完成即经 preload 发起 invoke，注册晚了直接
 * "No handler registered"（smoke-shell 实测暴露的竞态）。
 */
async function createWindow(
  modules: Parameters<typeof registerWorkbenchIpc>[0],
  settingsPath: string,
  pluginUi: PluginUiManager,
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "Kiko Workbench",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox preload 要求 CJS / .mjs 扩展名（Electron ESM 限制），
      // tsc 产物为 .js（package type:module）——关闭 sandbox 保证 ESM
      // preload 可加载；安全边界仍由 contextIsolation + nodeIntegration
      // 双关闭承担（preload 仅暴露白名单 IPC 桥）
      sandbox: false,
    },
  });

  // 渲染进程 console 转发到主进程 stdout（smoke-shell.mjs 断言锚点 + 排障）。
  // Electron 35 事件对象签名（旧多参签名已 deprecated）
  win.webContents.on("console-message", (event) => {
    if (event.message.startsWith("[kiko-renderer]")) {
      console.log(event.message);
    }
  });

  // 加载完成锚点（smoke-shell 断言；必须在 load 前注册防漏事件）
  win.webContents.once("did-finish-load", () => {
    console.log(`[kiko-shell] renderer loaded: url=${win.webContents.getURL()}`);
  });

  // 四组 IPC 通道 + 事件推送（先于 load，见函数注释）
  registerWorkbenchIpc(modules, win, settingsPath, pluginUi);

  // autopilot 验收模式注入（M2-07）：KIKO_AUTOPILOT env → URL query →
  // 渲染进程自动驱动与用户点击同款的处理函数（smoke-plugins.mjs 锚点）
  const autopilot = process.env["KIKO_AUTOPILOT"];
  const autopilotQuery = autopilot ? `?autopilot=${encodeURIComponent(autopilot)}` : "";

  if (DEV_SERVER_URL !== undefined && DEV_SERVER_URL !== "") {
    // dev 模式：Vite dev server（HMR 热更新）
    await win.loadURL(
      autopilotQuery !== "" ? `${DEV_SERVER_URL}${autopilotQuery}` : DEV_SERVER_URL,
    );
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // prod 模式：vite build 静态产物（vite.config outDir = dist/renderer）。
    // loadFile 不支持 query——autopilot 模式经 file:// URL 附加（pathToFileURL）
    if (autopilotQuery !== "") {
      await win.loadURL(
        `${pathToFileURL(join(__dirname, "renderer", "index.html")).href}${autopilotQuery}`,
      );
    } else {
      await win.loadFile(join(__dirname, "renderer", "index.html"));
    }
  }
  return win;
}

// ---------------------------------------------------------------------------
// 单实例锁（托盘常驻标配）：程序藏于托盘时用户重复双击 exe → 第二实例
// 分裂状态、抢占 WS 端口。requestSingleInstanceLock 必须在 app ready 前
// 调用（本模块经 headless.ts 动态加载，执行时机早于 whenReady 注册）。
// KIKO_NO_SINGLE_LOCK=1 逃生门：冒烟脚本并发隔离（顺序 killTree+重启
// 虽不并发，锁释放的 OS 级微小延迟不该影响测试稳定性）。
// ---------------------------------------------------------------------------
const gotSingleInstanceLock =
  process.env["KIKO_NO_SINGLE_LOCK"] === "1" || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // 第二实例：主实例已收到 second-instance 唤起主窗口，本实例静默退场
  // （app.exit 硬退——本实例尚未装配任何资源，无优雅回收需求）
  console.log("[kiko-shell] 检测到已运行实例：本次启动转为唤起既有窗口后退出");
  app.exit(0);
} else {
  // Electron 生命周期接线（壳形态：托盘常驻下 close 被拦截为隐藏，
  // window-all-closed 仅在托盘"退出"链路（quit → close 放行）后触发——
  // 保留兜底语义；macOS 常规待机不适用本产品）
  app.on("window-all-closed", () => {
    app.quit();
  });

  app.whenReady().then(
    () => {
      void main().catch((e: unknown) => {
        // 启动失败快死（与 headless 同策略：带病存活更难排查）
        console.error("[kiko-shell] 启动失败：", e);
        app.exit(1);
      });
    },
    (e: unknown) => {
      console.error("[kiko-shell] app ready 失败：", e);
      app.exit(1);
    },
  );
}
