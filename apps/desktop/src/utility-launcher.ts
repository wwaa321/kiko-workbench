/**
 * utilityProcess launcher（设计文档 6.3：ExecutionRuntime 的 Electron 侧适配）
 *
 * 职责：把 Electron utilityProcess 适配为 core 的 ProcessLauncher /
 * PluginProcess 抽象——core 保持零 electron 依赖（M1-08 架构约束），
 * Electron 具体进程语义全部收敛在本模块：
 *   - fork：以 plugin-sdk 的 host-entry 为入口启动子进程
 *     （host-entry 启动即挂接 parentPort 通道，见 plugin-sdk/host-entry.ts）
 *   - send → child.postMessage（结构化克隆序列化，6.3）
 *   - onMessage → child 的 "message" 事件（载荷即 host 上行事件对象）
 *   - onExit → child 的 "exit" 事件（含崩溃与主动 kill；正文消息此后不再到达）
 *   - kill → child.kill()（Windows 上等价 terminate）
 */
import { utilityProcess } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PluginProcess, ProcessLauncher } from "@kiko-workbench/core";
import type { HostCommand, HostEvent } from "@kiko-workbench/plugin-sdk";

/** 解析 plugin-sdk host-entry 构建产物绝对路径（utilityProcess.fork 入口） */
export function resolveHostEntryPath(): string {
  // createRequire 兼容 ESM 主进程（electron 35 内嵌 Node 22）；
  // require.resolve 仅解析路径不执行，对 "type": "module" 包同样有效
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve("@kiko-workbench/plugin-sdk");
  return join(dirname(sdkEntry), "host-entry.js");
}

/**
 * 创建 utilityProcess 版 ProcessLauncher（ExecutionRuntime 注入）。
 *
 * 子进程 stdio: "inherit"——host 的 uncaughtException / unhandledRejection
 * 守卫写 stderr（plugin-sdk host.ts），透传到主进程日志可见（可观测性）。
 */
export function createUtilityProcessLauncher(options: { hostEntryPath: string }): ProcessLauncher {
  return ({ pluginId }) => {
    const child = utilityProcess.fork(options.hostEntryPath, [], {
      serviceName: `kiko-plugin-${pluginId}`,
      stdio: "inherit",
    });

    const process: PluginProcess = {
      send(command: HostCommand) {
        child.postMessage(command);
      },
      kill() {
        child.kill();
      },
      onMessage(listener: (event: HostEvent) => void) {
        // UtilityProcess "message" 事件载荷即 postMessage 对象本身
        const handler = (message: unknown): void => listener(message as HostEvent);
        child.on("message", handler);
        return () => {
          child.off("message", handler);
        };
      },
      onExit(listener: () => void) {
        const handler = (): void => listener();
        child.once("exit", handler);
        return () => {
          child.off("exit", handler);
        };
      },
    };
    return process;
  };
}
