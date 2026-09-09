/**
 * headless 开发运行时入口（M1-09；设计文档 11 节 M1 清单第 6 条）
 *
 * Electron 仅作为 devDependency 提供无窗口主进程（M1 阶段无 UI）：
 *   - 全套装配经共享模块 bootstrap.ts（M2-06 抽出；Electron 壳 main.ts
 *     复用同一装配，两入口行为一致）
 *   - 本入口只负责 headless 特有职责：启动就绪报告 + 存活等待
 *
 * M2-06 起支持入口分发：KIKO_SHELL=1 → 动态加载应用壳入口 main.ts
 * （BrowserWindow + IPC + Vue 渲染进程）。main 字段保持指向本文件——
 * 5 个冒烟脚本 spawn("electron", ["."]) 零改动兼容。
 */
import { app } from "electron";
import { existsSync } from "node:fs";
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
import { registerPluginUiSchemePrivileges } from "./plugin-ui.js";

/** headless 主流程：装配 → 打印插件清单与 WS 端点 → 存活等待（M1-12 冒烟脚本接入） */
async function main(): Promise<void> {
  const pluginsRoot = resolvePluginsRoot();
  if (!existsSync(pluginsRoot)) {
    console.error(`[kiko-headless] 插件目录不存在：${pluginsRoot}（registry 将为空）`);
  }

  const settingsPath = resolveSettingsPath();
  const modules = await bootstrapWorkbench({
    documentsDir: resolveDocumentsDir(app.getPath("documents")),
    workspaceRoot: resolveWorkspaceRoot(settingsPath),
    pluginsRoot,
    userPluginsRoot: resolveUserPluginsRoot(),
    wsPort: resolveWsPort(),
    dbPath: resolveDbPath(),
    authToken: resolveAuthToken(),
  });

  // 优雅退出：WS 关闭 + 插件进程回收（running 批量 failed + 主动杀灭；
  // 剩余子进程随主进程退出由 Electron 终止）+ SQLite 连接关闭。
  // will-quit 在此注册以闭包捕获 modules
  app.on("will-quit", () => {
    void modules.wsServer.stop();
    modules.runtime.dispose();
    modules.closeStores?.();
  });

  // 启动就绪报告（可观测性：插件状态与对外端点一目了然）
  const plugins = modules.registry.listPlugins();
  console.log(
    `[kiko-headless] ready: workspace=${modules.workspace.workspaceRoot} plugins=${plugins.length}`,
  );
  for (const plugin of plugins) {
    console.log(
      `[kiko-headless]   - ${plugin.id} (${plugin.status}${plugin.errorReason !== undefined ? `: ${plugin.errorReason}` : ""})`,
    );
  }
  // 对外端点报告（5.1 双通道同端口；鉴权状态供冒烟脚本 / 排障辨识）
  console.log(
    `[kiko-headless] ws: ws://127.0.0.1:${modules.wsServer.port} http: http://127.0.0.1:${modules.wsServer.port}/rpc` +
      `（鉴权${process.env["KIKO_NO_AUTH"] === "1" ? "已禁用" : "已启用"}）`,
  );
}

// 入口分发（M2-06 + M2-10a 打包适配）：应用壳模式加载 main.ts（其内部
// 自注册 whenReady，时序安全——whenReady 在 ready 后调用亦立即 resolve）。
// 分发条件：KIKO_SHELL=1（显式）或打包产物（app.isPackaged——安装包
// 双击运行必须是窗口形态，headless 反向逃生门 KIKO_HEADLESS=1 留给
// 打包产物自动化测试 / 排障场景）。
if (process.env["KIKO_SHELL"] === "1" || (app.isPackaged && process.env["KIKO_HEADLESS"] !== "1")) {
  // P-003：kiko-plugin:// 协议特权注册必须 app ready **前同步**完成。
  // 不能放 main.ts 模块顶层——下方动态 import 是异步的，模块解析期间
  // app 可能已 ready（smoke-plugins 实测竞态：registerSchemesAsPrivileged
  // 抛错 + unhandled rejection，壳直接没起来）。本分发点位于入口模块
  // 顶层，静态时序保证先于 ready。
  registerPluginUiSchemePrivileges();
  import("./main.js").catch((e: unknown) => {
    // 动态 import 的模块顶层异常会变成 import promise 的 rejection——
    // 不 catch 即 unhandled rejection 静默吞掉启动失败（本次竞态的教训）
    console.error("[kiko-headless] 应用壳加载失败：", e);
    app.exit(1);
  });
} else {
  // Electron 生命周期接线（无窗口：不会触发 window-all-closed，进程由
  // Ctrl+C / SIGTERM / M2 壳的 app.quit() 终止）
  app.whenReady().then(
    () => {
      void main().catch((e: unknown) => {
        // 启动失败快死（headless 开发运行时：带病存活更难排查）
        console.error("[kiko-headless] 启动失败：", e);
        app.exit(1);
      });
    },
    (e: unknown) => {
      console.error("[kiko-headless] app ready 失败：", e);
      app.exit(1);
    },
  );
}
