/**
 * kiko-workbench-desktop —— Electron 应用壳（M2 落地）
 *
 * 职责（设计文档第 3 / 10 节）：
 *   - 主进程：集成 Workbench Core（注入 documents / userData 宿主路径）、
 *     启动 WS/HTTP 服务、提供 IPC 通道
 *   - 渲染进程：Vue 3 UI 三区块——插件列表 / 调用历史（Execution Trace）/ 实时事件流
 *   - IPC 通道：workbench:plugin / workbench:invocation /
 *     workbench:artifact:show-in-folder / workbench:event
 *
 * M1 期间 Electron 仅作为 devDependency 提供 headless 开发运行时
 * （无窗口，M1-09 任务），应用壳本体与打包在 M2-06 / M2-10 落地。
 *
 * 当前状态：M1-01 占位骨架。
 */
export const DESKTOP_APP_NAME = "kiko-workbench-desktop";
