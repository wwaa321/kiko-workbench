/**
 * 启动恢复（设计文档 7.3）
 *
 * 应用启动时扫描 status IN ('pending','running') 的记录 → 全部更新为
 * failed（error = {"code":50001,"message":"workbench restarted"}）→
 * 补发 execution.failed 事件。
 *
 * 明确不尝试续跑：插件进程内存状态已丢失，诚实失败优于假装恢复。
 *
 * 接线时序（headless / M2 Electron 壳装配期，WS Server 启动前）：
 *   DB 打开 → recoverInterruptedInvocations → 后续模块装配——
 *   恢复补发的事件经 EventManager 落库（events 表留痕），get_execution
 *   include_events 可见完整时间线。
 *
 * 对内存存储同样安全：启动时表空，恢复为空操作（返回 0）。
 */
import { EVENT_TYPES, type ResultError } from "@kiko-workbench/protocol";
import type { EventManager, StateManager } from "./state.js";

/** 7.3 原文规定的恢复错误（workbench 重启导致执行中断） */
const RESTART_ERROR: ResultError = {
  code: 50001,
  message: "workbench restarted",
};

/** 恢复依赖（Manager 层注入：恢复逻辑不属于 SQL 访问，不进 Repository） */
export interface RecoveryDeps {
  state: StateManager;
  events: EventManager;
}

/**
 * 扫描并恢复中断的 invocation（pending / running → failed + 补发事件）。
 * @returns 恢复条数（0 = 无中断记录；可观测性：启动日志报告）
 */
export function recoverInterruptedInvocations(deps: RecoveryDeps): number {
  const interrupted = [
    ...deps.state.listByStatus("pending"),
    ...deps.state.listByStatus("running"),
  ];
  const endedAt = new Date().toISOString();
  for (const record of interrupted) {
    // 直接经 StateStore.update 落终态（绕过 InvocationManager 状态机：
    // 新进程内不存在超时守卫等运行时簿记，且 store 层终态校验兜底竞态）
    deps.state.update(record.invocation_id, {
      internalStatus: "failed",
      error: RESTART_ERROR,
      ended_at: endedAt,
    });
    // 补发事件（与崩溃路径同形状：data 携带 code/message，5.4）
    deps.events.emit(EVENT_TYPES.EXECUTION_FAILED, record.invocation_id, {
      code: RESTART_ERROR.code,
      message: RESTART_ERROR.message,
    });
  }
  return interrupted.length;
}
