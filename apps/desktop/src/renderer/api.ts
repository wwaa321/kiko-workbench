/**
 * 渲染进程 API 访问层：preload 暴露的 window.workbench（shared.ts 契约）
 *
 * 类型经 type-only import 自 shared.ts（vite 构建期擦除，不引入主进程模块）；
 * 运行时实体是 preload contextBridge 注入的桥对象。
 */
import type { WorkbenchApi } from "../shared.js";

declare global {
  interface Window {
    workbench: WorkbenchApi;
  }
}

/** 契约缺失快死（preload 未加载：启动装配错误，白屏更难排查） */
export function getApi(): WorkbenchApi {
  if (window.workbench === undefined) {
    throw new Error("window.workbench 未注入（preload 加载失败）");
  }
  return window.workbench;
}
