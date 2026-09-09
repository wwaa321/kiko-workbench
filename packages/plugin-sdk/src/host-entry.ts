/**
 * utilityProcess 子进程入口（设计文档 6.3 / 8.5）
 *
 * ExecutionRuntime 经 utilityProcess.fork 启动本文件构建产物
 * （dist/host-entry.js）作为插件宿主进程：进程启动即挂接 parentPort
 * 消息通道，后续 load / invoke / cancel / shutdown 命令全部经
 * PluginHost 处理（进程级异常守卫见 startUtilityProcessHost）。
 *
 * 位置说明：本入口属 plugin-sdk 而非 apps/desktop——host 运行时是
 * SDK 的一部分，Electron 壳 / headless 入口 / 未来其它宿主共用。
 */
import { startUtilityProcessHost } from "./host.js";

startUtilityProcessHost();
