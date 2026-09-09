/**
 * StateManager / EventManager / LogManager（设计文档 6.4-6.6）
 *
 * 三模块是 core 的状态与可观测性中枢：
 *   - StateManager  invocation 状态单一数据源（get_execution 数据源）
 *   - EventManager  事件产生即分发（M1 内存 + 回调订阅；M2 加 SQLite 持久化）
 *   - LogManager    执行日志聚合（Event 与 Log 严格分离，PRD 5.1.5/5.1.6）
 */
import type { ExecutionEvent, EventType } from "@kiko-workbench/protocol";
import type {
  ArtifactQuery,
  ArtifactQueryResult,
  ArtifactStats,
  EventStore,
  InvocationQuery,
  InvocationQueryResult,
  InvocationRecord,
  LogStore,
  StateStore,
} from "../stores/types.js";
import { toExternalStatus } from "../stores/types.js";

/** 事件订阅者（M1-11 WS Server / IPC 转发 UI 经此挂接） */
export type EventListener = (event: ExecutionEvent) => void;

/** StateManager：invocation 状态单一数据源 */
export class StateManager {
  constructor(private readonly store: StateStore) {}

  create(record: InvocationRecord): void {
    this.store.create(record);
  }

  get(invocationId: string): InvocationRecord | undefined {
    return this.store.get(invocationId);
  }

  update(invocationId: string, patch: Partial<InvocationRecord>): void {
    this.store.update(invocationId, patch);
  }

  /** 按对外状态过滤（崩溃恢复场景批量取 running） */
  listByStatus(external: ReturnType<typeof toExternalStatus>): InvocationRecord[] {
    return this.store.listByStatus(external);
  }

  list(): InvocationRecord[] {
    return this.store.list();
  }

  /** 分页 + 筛选查询（M2-08：UI 调用历史；条件全部下推存储层） */
  query(q: InvocationQuery): InvocationQueryResult {
    return this.store.query(q);
  }

  /** 跨 invocation 产物分页查询（UI 升级：产出物页；条件全部下推存储层） */
  queryArtifacts(q: ArtifactQuery): ArtifactQueryResult {
    return this.store.queryArtifacts(q);
  }

  /** 产物汇总统计（总数/今日新增/累计大小/能力清单；供侧边栏徽标与指标卡） */
  artifactStats(sinceMs: number): ArtifactStats {
    return this.store.artifactStats(sinceMs);
  }

  /** 清空全部终态记录（返回被删 id，供事件/日志级联；编排见下方） */
  clearTerminal(): string[] {
    return this.store.clearTerminal();
  }
}

/** EventManager：事件产生即分发（5.4 六标准事件） */
export class EventManager {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly store: EventStore) {}

  /** 挂接订阅者（WS 连接订阅 / IPC 转发 UI）；返回退订函数 */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 产生事件：追加存储 + 分发全部订阅者。
   * 分发异常不阻断后续订阅者（可观测性链路自身的健壮性）。
   */
  emit(type: EventType, invocationId: string, data: Record<string, unknown> = {}): ExecutionEvent {
    const event: ExecutionEvent = {
      event: type,
      invocation_id: invocationId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.store.append(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 订阅者异常吞掉：单个订阅者故障不应中断事件链
      }
    }
    return event;
  }

  listByInvocation(invocationId: string): ExecutionEvent[] {
    return this.store.listByInvocation(invocationId);
  }

  /** 删除指定 invocation 的事件（历史清理级联） */
  deleteByInvocations(invocationIds: readonly string[]): void {
    this.store.deleteByInvocations(invocationIds);
  }
}

/** LogManager：按 invocation 聚合执行日志（Log，非 Event） */
export class LogManager {
  constructor(private readonly store: LogStore) {}

  /** 追加一条执行日志（host 的 log 消息落地处） */
  append(invocationId: string, message: string): ExecutionLogEntry {
    const log = { timestamp: new Date().toISOString(), message };
    this.store.append(invocationId, log);
    return log;
  }

  listByInvocation(invocationId: string): ExecutionLogEntry[] {
    return this.store.listByInvocation(invocationId);
  }

  /** 删除指定 invocation 的日志（历史清理级联） */
  deleteByInvocations(invocationIds: readonly string[]): void {
    this.store.deleteByInvocations(invocationIds);
  }
}

/**
 * 清空调用历史（UI「清空历史」入口的 core 编排）：
 * 终态记录删除 → 事件/日志按被删 id 级联删除。返回清理条数。
 *
 * 语义边界（评审确认）：
 *   - 仅删终态（completed/failed/cancelled）——运行中调用的收尾路径
 *     （事件写入/状态更新）依赖记录存在，不能删
 *   - 删除顺序对崩溃窗口友好：先删主记录再删 events/logs，中断残留的
 *     孤儿事件/日志行无功能危害（get_execution 以 state 查询为准）
 *   - 磁盘回收（VACUUM）是 SQLite 特有概念，由宿主（bootstrap 装配的
 *     modules.vacuumDb）在编排后调用，core 接口保持存储无关
 */
export function clearInvocationHistory(deps: {
  state: StateManager;
  events: EventManager;
  logs: LogManager;
}): number {
  const ids = deps.state.clearTerminal();
  if (ids.length > 0) {
    deps.events.deleteByInvocations(ids);
    deps.logs.deleteByInvocations(ids);
  }
  return ids.length;
}

/** 日志条目（ExecutionLog 的内部别名，避免与 store 类型循环依赖） */
export type ExecutionLogEntry = { timestamp: string; message: string };
