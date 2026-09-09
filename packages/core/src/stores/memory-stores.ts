/**
 * 内存存储实现（M1：设计文档 6.4 "M1 内存实现，M2 切换 SQLite"）
 *
 * 三实现与抽象接口一一对应；M2 的 SQLite Repository 实现
 * （node:sqlite，设计文档 7.2）落地后按构造注入替换即可。
 */
import type { ExecutionEvent, ExecutionLog, InvocationStatus } from "@kiko-workbench/protocol";
import type {
  ArtifactQuery,
  ArtifactQueryItem,
  ArtifactStats,
  EventStore,
  InvocationQuery,
  InvocationRecord,
  LogStore,
  StateStore,
} from "./types.js";
import { toExternalStatus } from "./types.js";

/** 单条产物的登记元数据（内存实现镜像 SQLite 的 created_at + 自增 id 语义） */
interface ArtifactMeta {
  /** 登记时刻 epoch ms（与 SQLite insertArtifact 的 Date.now() 同源） */
  ts: number;
  /** 全局登记序（递增；镜像 SQLite artifacts.id 的插入序，作同毫秒排序键） */
  seq: number;
}

/** invocation 状态内存存储（单一数据源） */
export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, InvocationRecord>();
  /** invocation_id → 产物登记元数据（与 record.artifacts 按下标对齐） */
  private readonly artifactMeta = new Map<string, ArtifactMeta[]>();
  /** 全局产物登记序（构造起递增；仅作排序键，不对外暴露） */
  private artifactSeq = 0;

  create(record: InvocationRecord): void {
    // invocation_id 由 InvocationManager 生成（nanoid），重复视为编程错误
    if (this.records.has(record.invocation_id)) {
      throw new Error(`invocation_id 重复：${record.invocation_id}`);
    }
    this.records.set(record.invocation_id, { ...record });
    // 防御性支持非空 artifacts（与 SQLite 实现等价：登记时刻 + 登记序）
    if (record.artifacts.length > 0) {
      this.artifactMeta.set(
        record.invocation_id,
        record.artifacts.map(() => ({ ts: Date.now(), seq: ++this.artifactSeq })),
      );
    }
  }

  get(invocationId: string): InvocationRecord | undefined {
    const record = this.records.get(invocationId);
    // 返回浅拷贝：调用方修改不得污染内部单一数据源
    return record ? { ...record } : undefined;
  }

  update(invocationId: string, patch: Partial<InvocationRecord>): void {
    const record = this.records.get(invocationId);
    if (!record) {
      throw new Error(`invocation 不存在：${invocationId}`);
    }
    if (
      (record.internalStatus === "completed" ||
        record.internalStatus === "failed" ||
        record.internalStatus === "cancelled") &&
      patch.internalStatus !== undefined &&
      patch.internalStatus !== record.internalStatus
    ) {
      // 终态不可再迁移（设计文档 6.2 状态表最后一行在存储层的兜底）
      throw new Error(`终态 invocation 不可更新状态：${invocationId}`);
    }
    Object.assign(record, patch);
    // artifacts 追加语义（与 SQLite 行数差值追加同构）：patch 后数组变长
    // 的尾部元素补登记元数据；已存在元素的下标保持不变
    const meta = this.artifactMeta.get(invocationId) ?? [];
    for (let i = meta.length; i < record.artifacts.length; i++) {
      meta.push({ ts: Date.now(), seq: ++this.artifactSeq });
    }
    if (record.artifacts.length > 0) {
      this.artifactMeta.set(invocationId, meta);
    }
  }

  listByStatus(external: InvocationStatus): InvocationRecord[] {
    // 内外状态映射统一走 toExternalStatus（types.ts 单点维护）
    return this.list().filter((r) => toExternalStatus(r.internalStatus) === external);
  }

  list(): InvocationRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  query(q: InvocationQuery): { items: InvocationRecord[]; hasMore: boolean } {
    // 与 SQLite 实现严格同构：AND 组合过滤 + created_at DESC（同毫秒按 id DESC）
    const sinceMs = q.since !== undefined ? Date.parse(q.since) : undefined;
    // since 非法字符串 → 恒空结果（与 SQLite 实现一致，防调用方脏数据放大）
    if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
      return { items: [], hasMore: false };
    }
    const keyword =
      q.capabilityContains !== undefined ? q.capabilityContains.toLowerCase() : undefined;
    const filtered = [...this.records.values()].filter((r) => {
      // 外部状态过滤（pending 经 toExternalStatus 映射，与 SQL IN (...) 同语义）
      if (q.status !== undefined && toExternalStatus(r.internalStatus) !== q.status) {
        return false;
      }
      // 能力 id 子串匹配（大小写不敏感；空串 = 不过滤）
      if (
        keyword !== undefined &&
        keyword !== "" &&
        !r.capability_id.toLowerCase().includes(keyword)
      ) {
        return false;
      }
      // 时间下界
      if (sinceMs !== undefined && Date.parse(r.created_at) < sinceMs) {
        return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      const diff = Date.parse(b.created_at) - Date.parse(a.created_at);
      return diff !== 0 ? diff : b.invocation_id.localeCompare(a.invocation_id);
    });
    // limit+1 探测：多取一行判断 has_more，避免全量计数
    const page = filtered.slice(q.offset, q.offset + q.limit + 1);
    return {
      items: page.slice(0, q.limit).map((r) => ({ ...r })),
      hasMore: page.length > q.limit,
    };
  }

  /**
   * 产物跨 invocation 分页查询（与 SQLite 实现严格同构）：AND 组合过滤 +
   * 登记时间 DESC（同毫秒按登记序 DESC）；limit+1 探测 has_more。
   */
  queryArtifacts(q: ArtifactQuery): { items: ArtifactQueryItem[]; hasMore: boolean } {
    const sinceMs = q.since !== undefined ? Date.parse(q.since) : undefined;
    // since 非法字符串 → 恒空结果（与 SQLite 实现一致，防调用方脏数据放大）
    if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
      return { items: [], hasMore: false };
    }
    const capKeyword =
      q.capabilityContains !== undefined ? q.capabilityContains.toLowerCase() : undefined;
    const nameKeyword =
      q.filenameContains !== undefined ? q.filenameContains.toLowerCase() : undefined;
    const flat: Array<ArtifactQueryItem & { seq: number }> = [];
    for (const record of this.records.values()) {
      const meta = this.artifactMeta.get(record.invocation_id) ?? [];
      record.artifacts.forEach((a, i) => {
        const m = meta[i];
        if (m === undefined) return; // 防御：元数据缺失跳过（正常路径不发生）
        flat.push({
          invocation_id: record.invocation_id,
          capability_id: record.capability_id,
          file: a.file,
          relative_path: a.relative_path,
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          created_at: new Date(m.ts).toISOString(),
          seq: m.seq,
        });
      });
    }
    const filtered = flat.filter((item) => {
      // 能力子串（经关联 invocation；大小写不敏感；空串 = 不过滤）
      if (
        capKeyword !== undefined &&
        capKeyword !== "" &&
        !item.capability_id.toLowerCase().includes(capKeyword)
      ) {
        return false;
      }
      // 文件名子串（大小写不敏感；空串 = 不过滤）
      if (
        nameKeyword !== undefined &&
        nameKeyword !== "" &&
        !item.filename.toLowerCase().includes(nameKeyword)
      ) {
        return false;
      }
      // 登记时间下界
      if (sinceMs !== undefined && Date.parse(item.created_at) < sinceMs) {
        return false;
      }
      return true;
    });
    // 新 → 旧；同毫秒按登记序倒序（镜像 SQL 的 created_at DESC, id DESC）
    filtered.sort((a, b) => {
      const diff = Date.parse(b.created_at) - Date.parse(a.created_at);
      return diff !== 0 ? diff : b.seq - a.seq;
    });
    const page = filtered.slice(q.offset, q.offset + q.limit + 1);
    return {
      items: page.slice(0, q.limit).map(({ seq: _seq, ...item }) => item),
      hasMore: page.length > q.limit,
    };
  }

  /** 产物汇总（全量口径；todayCount 的 sinceMs 由调用方折算本地零点） */
  artifactStats(sinceMs: number): ArtifactStats {
    const flat: Array<{ capabilityId: string; ts: number; size: number }> = [];
    for (const record of this.records.values()) {
      const meta = this.artifactMeta.get(record.invocation_id) ?? [];
      record.artifacts.forEach((a, i) => {
        const m = meta[i];
        if (m === undefined) return;
        flat.push({ capabilityId: record.capability_id, ts: m.ts, size: a.size });
      });
    }
    // 去重能力：按最近登记时间倒序（镜像 SQL GROUP BY + ORDER BY MAX DESC）
    const latestByCap = new Map<string, number>();
    for (const f of flat) {
      latestByCap.set(f.capabilityId, Math.max(latestByCap.get(f.capabilityId) ?? 0, f.ts));
    }
    const capabilities = [...latestByCap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cap]) => cap);
    return {
      total: flat.length,
      todayCount: flat.filter((f) => f.ts >= sinceMs).length,
      totalSize: flat.reduce((sum, f) => sum + f.size, 0),
      capabilities: capabilities.slice(0, 100),
    };
  }

  clearTerminal(): string[] {
    // 终态 → 删除并收集 id（供 events/logs 级联）；非终态原样保留
    const deleted: string[] = [];
    for (const [id, record] of this.records) {
      if (
        record.internalStatus === "completed" ||
        record.internalStatus === "failed" ||
        record.internalStatus === "cancelled"
      ) {
        this.records.delete(id);
        // 产物登记元数据随主记录同生共死（镜像 SQLite 级联 DELETE）
        this.artifactMeta.delete(id);
        deleted.push(id);
      }
    }
    return deleted;
  }
}

/** 事件内存存储（按追加顺序保存） */
export class MemoryEventStore implements EventStore {
  // 可变引用（readonly 字段无法整体重赋）：deleteByInvocations 用过滤重建
  private events: ExecutionEvent[] = [];

  append(event: ExecutionEvent): void {
    this.events.push({ ...event });
  }

  listByInvocation(invocationId: string): ExecutionEvent[] {
    return this.events.filter((e) => e.invocation_id === invocationId).map((e) => ({ ...e }));
  }

  deleteByInvocations(invocationIds: readonly string[]): void {
    const targets = new Set(invocationIds);
    // 原地过滤（splice 逆序或重建均可；量级小，重建更直白）
    this.events = this.events.filter((e) => !targets.has(e.invocation_id));
  }
}

/** 日志内存存储（按 invocation 聚合） */
export class MemoryLogStore implements LogStore {
  private readonly logs = new Map<string, ExecutionLog[]>();

  append(invocationId: string, log: ExecutionLog): void {
    const list = this.logs.get(invocationId) ?? [];
    list.push({ ...log });
    this.logs.set(invocationId, list);
  }

  listByInvocation(invocationId: string): ExecutionLog[] {
    return (this.logs.get(invocationId) ?? []).map((l) => ({ ...l }));
  }

  deleteByInvocations(invocationIds: readonly string[]): void {
    for (const id of invocationIds) {
      this.logs.delete(id);
    }
  }
}
