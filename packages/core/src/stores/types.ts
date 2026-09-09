/**
 * State / Event / Log 存储抽象接口（设计文档 6.4-6.6）
 *
 * M1 使用内存实现（MemoryStateStore / MemoryEventStore / MemoryLogStore）；
 * M2 切换 SQLite 持久化时，仅需提供新的实现类，业务模块零改动
 * （验收锚点：接口抽象预留持久化实现位）。
 *
 * 内部状态机形态（设计文档 6.2）：
 *   内部: created → validated → resolved → running → completed/failed/cancelled
 *   外部: pending(created/validated/resolved 合并) running 终态同名
 */
import type {
  ArtifactInfo,
  ExecutionEvent,
  ExecutionLog,
  InvocationStatus,
  ResultError,
} from "@kiko-workbench/protocol";

/** invocation 内部完整记录（get_execution 响应的数据源） */
export interface InvocationRecord {
  invocation_id: string;
  capability_id: string;
  /** 内部状态机（见文件头），对外映射为 InvocationStatus */
  internalStatus: InternalStatus;
  mode: "sync" | "async";
  /** 已校验的调用输入（ExecutionRuntime 下发 invoke 消息用；M2 持久化审计） */
  input: Record<string, unknown>;
  /** ISO 8601 UTC */
  created_at: string;
  started_at?: string;
  ended_at?: string;
  /** 业务数据（插件 handle 返回值） */
  result?: unknown;
  error?: ResultError;
  artifacts: ArtifactInfo[];
}

/** 内部状态机状态（设计文档 6.2：含丰富中间态） */
export type InternalStatus =
  "created" | "validated" | "resolved" | "running" | "completed" | "failed" | "cancelled";

/** 内部状态 → 对外状态映射（设计文档 6.2：pending 合并前三态） */
export function toExternalStatus(internal: InternalStatus): InvocationStatus {
  switch (internal) {
    case "created":
    case "validated":
    case "resolved":
      return "pending";
    default:
      // running / completed / failed / cancelled 对外同名
      return internal;
  }
}

/** 是否终态（终态后拒绝任何状态操作，设计文档 6.2 状态表最后一行） */
export function isTerminal(internal: InternalStatus): boolean {
  return internal === "completed" || internal === "failed" || internal === "cancelled";
}

/** 状态存储接口（M1 内存实现 / M2 SQLite 实现） */
export interface StateStore {
  create(record: InvocationRecord): void;
  /** 不存在返回 undefined */
  get(invocationId: string): InvocationRecord | undefined;
  /** 更新记录（浅合并字段）；终态记录不可再更新（防竞态覆写终态） */
  update(invocationId: string, patch: Partial<InvocationRecord>): void;
  /** 按外部状态过滤（崩溃恢复：批量取 running 态） */
  listByStatus(external: InvocationStatus): InvocationRecord[];
  list(): InvocationRecord[];
  /**
   * 分页 + 筛选查询（M2-08：UI 调用历史数据量控制，SQL 下推）。
   * 新 → 旧排序；has_more 用 limit+1 探测（避免 COUNT 全表扫描）。
   */
  query(q: InvocationQuery): InvocationQueryResult;
  /**
   * 产物跨 invocation 分页查询（产出物页数据源，SQL 下推）。
   * 新 → 旧排序（登记时间 DESC，同毫秒按登记序 DESC）；has_more 用
   * limit+1 探测。能力筛选经 JOIN invocations 下推。
   */
  queryArtifacts(q: ArtifactQuery): ArtifactQueryResult;
  /**
   * 产物汇总（全量口径，与筛选无关）：总数 / since 后新增 / 累计大小 /
   * 去重能力列表（倒序封顶 100）。
   */
  artifactStats(sinceMs: number): ArtifactStats;
  /**
   * 清空全部终态（completed/failed/cancelled）记录，返回被删的
   * invocation id 列表（供 events/logs 级联删除，编排见
   * clearInvocationHistory）。非终态记录保留——运行中的调用
   * 收尾路径（事件写入 / 状态更新）依赖记录存在。
   */
  clearTerminal(): string[];
}

/**
 * 列表查询参数（M2-08）。字段全部可选过滤；limit/offset 控制分页。
 * 语义：条件 AND 组合；排序恒为 created_at DESC（同毫秒按 id DESC 稳定）。
 */
export interface InvocationQuery {
  /** 页大小（1..500；探测实现会取 limit+1 行） */
  limit: number;
  /** 偏移（≥0） */
  offset: number;
  /** 外部状态过滤（pending 映射内部三态 IN 查询） */
  status?: InvocationStatus;
  /** 能力 id 子串匹配（大小写不敏感；空串/undefined = 不过滤） */
  capabilityContains?: string;
  /** ISO 8601：仅返回 created_at ≥ since 的记录 */
  since?: string;
}

/** query() 结果：items 为当前页；has_more 表示还有下一页 */
export interface InvocationQueryResult {
  items: InvocationRecord[];
  hasMore: boolean;
}

/** 产物查询项：跨 invocation 的扁平视图（capability_id 来自关联 invocation） */
export interface ArtifactQueryItem {
  invocation_id: string;
  capability_id: string;
  /** 产物绝对路径（工作空间沙箱内） */
  file: string;
  relative_path: string;
  filename: string;
  mime_type: string;
  size: number;
  /** 产物登记时间（ISO 8601；登记≠调用创建，同 invocation 产物按登记序） */
  created_at: string;
}

/**
 * 产物分页查询参数（产出物页数据源）。语义对齐 InvocationQuery：
 * 条件 AND 组合；排序恒为登记时间 DESC（同毫秒按登记序 DESC 稳定）。
 */
export interface ArtifactQuery {
  /** 页大小（1..500；探测实现取 limit+1 行） */
  limit: number;
  /** 偏移（≥0） */
  offset: number;
  /** 能力 id 子串匹配（关联 invocation；大小写不敏感；空串/undefined = 不过滤） */
  capabilityContains?: string;
  /** 文件名子串匹配（大小写不敏感；空串/undefined = 不过滤） */
  filenameContains?: string;
  /** ISO 8601：仅返回登记时间 ≥ since 的产物（非法 ISO → 恒空结果） */
  since?: string;
}

/** queryArtifacts() 结果：items 为当前页；hasMore 表示还有下一页 */
export interface ArtifactQueryResult {
  items: ArtifactQueryItem[];
  hasMore: boolean;
}

/**
 * 产物汇总（全量口径，与查询筛选无关；UI 指标卡 / 侧栏徽标 / 筛选
 * 下拉数据源）。todayCount 的 sinceMs 由调用方折算（本地今天零点）。
 */
export interface ArtifactStats {
  /** 产物总条数 */
  total: number;
  /** 登记时间 ≥ sinceMs 的条数（"今日新增"） */
  todayCount: number;
  /** 累计字节数 */
  totalSize: number;
  /** 去重能力 id（按最近产物登记时间倒序；封顶 100 防下拉膨胀） */
  capabilities: string[];
}

/** 事件存储接口（事件产生即持久化，M2） */
export interface EventStore {
  append(event: ExecutionEvent): void;
  listByInvocation(invocationId: string): ExecutionEvent[];
  /** 删除指定 invocation 的事件（历史清理级联；不存在 / 已删 id 幂等） */
  deleteByInvocations(invocationIds: readonly string[]): void;
}

/** 日志存储接口（按 invocation 聚合） */
export interface LogStore {
  append(invocationId: string, log: ExecutionLog): void;
  listByInvocation(invocationId: string): ExecutionLog[];
  /** 删除指定 invocation 的日志（历史清理级联；不存在 / 已删 id 幂等） */
  deleteByInvocations(invocationIds: readonly string[]): void;
}
