/**
 * SQLite Repository（设计文档 7.2：M2 持久化，node:sqlite DatabaseSync + WAL）
 *
 * 实现约束（7.2 原文）：
 *   - 所有 SQL 访问收敛在本模块内，不散落到其他模块（应对 13 节 R1 的
 *     node:sqlite API 微调风险——如遇 API 变更只改本文件）
 *   - 建库后执行 PRAGMA journal_mode = WAL
 *   - 四表 DDL：invocations / events / logs / artifacts（含四索引）
 *
 * 与内存实现（memory-stores.ts）严格同构：三 store 实现相同接口，
 * StateManager/EventManager/LogManager 零改动切换（6.4 接口抽象预留位）。
 *
 * 关键映射决策（偏差表 2026-08-20 登记）：
 *   - invocations.status 列存【内部状态】七值（created/validated/resolved/
 *     running/completed/failed/cancelled），而非 DDL 注释示意的外部五值——
 *     StateStore.get() 必须还原 internalStatus 供状态机转换校验（6.2），
 *     存外部态会丢失中间态精度；listByStatus 的外部过滤在 SQL 以
 *     IN ('created','validated','resolved') = pending 表达
 *   - ISO 8601 字符串（接口层）↔ epoch ms INTEGER（DDL 层）双向转换
 *   - artifacts 表与 InvocationRecord.artifacts 的同步为【追加语义】：
 *     attachArtifact 只增不减（invocation.ts 终态后拒追加），update 以
 *     行数差值追加尾部元素，保留表中 created_at 不被全量重插冲掉
 */
import { DatabaseSync } from "node:sqlite";
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

/** SQLite stores 组装产物（close 供宿主优雅关闭，headless will-quit 调用） */
export interface SqliteStores {
  state: StateStore;
  events: EventStore;
  logs: LogStore;
  /** 关闭数据库连接（ WAL 模式下未 checkpoint 的数据已在磁盘，安全） */
  close(): void;
  /**
   * 重建数据库文件页（VACUUM）：历史清理后回收磁盘空间
   * （DELETE 只标记复用，文件不缩小）。低频操作，短暂阻塞可接受。
   */
  vacuum(): void;
}

/** invocations 行形状（node:sqlite 返回值：INTEGER→number，NULL→undefined） */
interface InvocationRow {
  id: string;
  capability_id: string;
  input: string;
  status: InvocationRecord["internalStatus"];
  mode: "sync" | "async";
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  result: string | null;
  error: string | null;
}

/** artifacts 行形状 */
interface ArtifactRow {
  id: number;
  invocation_id: string;
  file: string;
  relative_path: string;
  filename: string;
  mime_type: string;
  size: number;
  created_at: number;
}

/** 产物查询 JOIN 行形状（artifacts × invocations.capability_id） */
interface ArtifactJoinRow extends ArtifactRow {
  capability_id: string;
}

/** LIKE 子串通配符转义（%/_/\ 按字面量处理，防通配符注入；配 ESCAPE '\'） */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** events 行形状 */
interface EventRow {
  id: number;
  invocation_id: string;
  event_type: string;
  timestamp: number;
  data: string | null;
}

/** logs 行形状 */
interface LogRow {
  id: number;
  invocation_id: string;
  timestamp: number;
  message: string;
}

/**
 * 四表 DDL（设计文档 7.2 原文逐字段对照）。
 * status 列无 CHECK 约束：DDL 原文即无（TEXT），存内部态七值合法。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invocations (
  id            TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  input         TEXT NOT NULL,
  status        TEXT NOT NULL,
  mode          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  result        TEXT,
  error         TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  timestamp     INTEGER NOT NULL,
  data          TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL,
  timestamp     INTEGER NOT NULL,
  message       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL,
  file          TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invocations_status ON invocations(status);
CREATE INDEX IF NOT EXISTS idx_events_inv ON events(invocation_id);
CREATE INDEX IF NOT EXISTS idx_logs_inv ON logs(invocation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_inv ON artifacts(invocation_id);
`;

// ---------------------------------------------------------------------------
// 工厂（唯一入口：开库 + WAL + DDL + 三 store 组装）
// ---------------------------------------------------------------------------

/**
 * 打开（或创建）SQLite 数据库并组装三 store。
 * @param dbPath 数据库文件路径；":memory:" 为内存库（测试用，WAL 自动退化）
 */
export function createSqliteStores(dbPath: string): SqliteStores {
  const db = new DatabaseSync(dbPath);
  // WAL：写不阻塞读（主进程同步 API + Electron 渲染层无直接访问，
  // WAL 主要收益是崩溃安全——未 checkpoint 的 WAL 文件重启后自动恢复）
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  return {
    state: new SqliteStateStore(db),
    events: new SqliteEventStore(db),
    logs: new SqliteLogStore(db),
    close: () => db.close(),
    // VACUUM 不能在事务内执行（node:sqlite exec 独立语句，无事务包裹）
    vacuum: () => db.exec("VACUUM"),
  };
}

// ---------------------------------------------------------------------------
// ISO 8601 ↔ epoch ms 转换（单点）
// ---------------------------------------------------------------------------

/** ISO 字符串 → epoch ms（undefined / 非法输入 → null，DDL 允许 NULL） */
function isoToMs(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** epoch ms → ISO 字符串（null → undefined） */
function msToIso(ms: number | null): string | undefined {
  return ms === null ? undefined : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// StateStore 实现（invocations + artifacts 双表）
// ---------------------------------------------------------------------------

class SqliteStateStore implements StateStore {
  constructor(private readonly db: DatabaseSync) {}

  create(record: InvocationRecord): void {
    // 主键冲突由 SQLite 抛错（与内存实现"重复视为编程错误"同语义）
    this.db
      .prepare(
        `INSERT INTO invocations
           (id, capability_id, input, status, mode, created_at, started_at, ended_at, result, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.invocation_id,
        record.capability_id,
        JSON.stringify(record.input),
        record.internalStatus,
        record.mode,
        isoToMs(record.created_at) ?? Date.now(),
        isoToMs(record.started_at),
        isoToMs(record.ended_at),
        record.result !== undefined ? JSON.stringify(record.result) : null,
        record.error !== undefined ? JSON.stringify(record.error) : null,
      );
    // createInvocation 恒传空 artifacts；防御性支持非空（与内存实现等价）
    for (const artifact of record.artifacts) this.insertArtifact(record.invocation_id, artifact);
  }

  get(invocationId: string): InvocationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(invocationId) as
      InvocationRow | undefined;
    if (row === undefined) return undefined;
    return this.assemble(row);
  }

  update(invocationId: string, patch: Partial<InvocationRecord>): void {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(invocationId) as
      InvocationRow | undefined;
    if (row === undefined) {
      throw new Error(`invocation 不存在：${invocationId}`);
    }
    // 浅合并语义（与 Memory 实现一致：patch 字段覆盖，其余保留）
    const current = this.assemble(row);
    const merged: InvocationRecord = { ...current, ...patch };
    // 终态校验（6.2 状态表最后一行在存储层的兜底，与 Memory 同构）
    if (
      (current.internalStatus === "completed" ||
        current.internalStatus === "failed" ||
        current.internalStatus === "cancelled") &&
      patch.internalStatus !== undefined &&
      patch.internalStatus !== current.internalStatus
    ) {
      throw new Error(`终态 invocation 不可更新状态：${invocationId}`);
    }
    // 事务：invocations 行更新 + artifacts 追加原子完成（半更新不可留存）
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, started_at = ?, ended_at = ?, result = ?, error = ?
           WHERE id = ?`,
        )
        .run(
          merged.internalStatus,
          isoToMs(merged.started_at),
          isoToMs(merged.ended_at),
          merged.result !== undefined ? JSON.stringify(merged.result) : null,
          merged.error !== undefined ? JSON.stringify(merged.error) : null,
          invocationId,
        );
      // artifacts 追加语义：以 DB 现有行数为基线，数组尾部新增逐条插入。
      // attachArtifact 只增不减（invocation.ts 终态拒追加），行数差即新增量
      const existingCount = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE invocation_id = ?")
          .get(invocationId) as { n: number }
      ).n;
      for (const artifact of merged.artifacts.slice(existingCount)) {
        this.insertArtifact(invocationId, artifact);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  listByStatus(external: InvocationStatus): InvocationRecord[] {
    // 外部过滤 → 内部态集合（toExternalStatus 的 SQL 版；pending 合并前三态）
    const internalStatuses: string[] =
      external === "pending" ? ["created", "validated", "resolved"] : [external];
    const placeholders = internalStatuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM invocations WHERE status IN (${placeholders})`)
      .all(...internalStatuses) as unknown as InvocationRow[];
    return rows.map((row) => this.assemble(row));
  }

  list(): InvocationRecord[] {
    const rows = this.db.prepare("SELECT * FROM invocations").all() as unknown as InvocationRow[];
    return rows.map((row) => this.assemble(row));
  }

  /**
   * 分页 + 筛选查询（M2-08）：全条件下推 SQL（排序/过滤/LIMIT 均在库内完成，
   * 不拉全量到内存——UI 调用历史数据量控制的存储层落点）。
   * has_more 用 limit+1 探测（省一次 COUNT；invocations 表量级增长后依然 O(limit)）。
   */
  query(q: InvocationQuery): { items: InvocationRecord[]; hasMore: boolean } {
    // 动态拼装 WHERE（参数化占位符，杜绝注入；LIKE 走 ESCAPE 转义）
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (q.status !== undefined) {
      // 外部状态 → 内部态集合（pending 合并前三态，与 listByStatus 同映射）
      const internalStatuses: string[] =
        q.status === "pending" ? ["created", "validated", "resolved"] : [q.status];
      const placeholders = internalStatuses.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      params.push(...internalStatuses);
    }
    if (q.capabilityContains !== undefined && q.capabilityContains !== "") {
      // 子串匹配：LIKE + ESCAPE '\'（%/_/\ 按字面量处理，防通配符注入）
      const escaped = q.capabilityContains
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      conditions.push("capability_id LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    if (q.since !== undefined) {
      const sinceMs = Date.parse(q.since);
      // 非法 ISO → 条件恒 false（防御调用方；与内存实现 NaN 语义一致）
      if (Number.isNaN(sinceMs)) {
        return { items: [], hasMore: false };
      }
      conditions.push("created_at >= ?");
      params.push(sinceMs);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    // 排序：新 → 旧；同毫秒按 id DESC 保证分页稳定（与内存实现同构）
    // LIMIT 取 limit+1（探测 has_more），返回前裁掉探测行
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit + 1, q.offset) as unknown as InvocationRow[];
    return {
      items: rows.slice(0, q.limit).map((row) => this.assemble(row)),
      hasMore: rows.length > q.limit,
    };
  }

  /**
   * 产物跨 invocation 分页查询（产出物页数据源）：全条件 SQL 下推
   * （JOIN + 过滤 + LIMIT 均在库内完成）。能力筛选经 JOIN invocations
   * 取 capability_id；has_more 用 limit+1 探测（与 query() 同模式）。
   */
  queryArtifacts(q: ArtifactQuery): { items: ArtifactQueryItem[]; hasMore: boolean } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (q.capabilityContains !== undefined && q.capabilityContains !== "") {
      conditions.push("i.capability_id LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q.capabilityContains)}%`);
    }
    if (q.filenameContains !== undefined && q.filenameContains !== "") {
      conditions.push("a.filename LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q.filenameContains)}%`);
    }
    if (q.since !== undefined) {
      const sinceMs = Date.parse(q.since);
      // 非法 ISO → 恒空结果（与 query() 的防御语义一致）
      if (Number.isNaN(sinceMs)) {
        return { items: [], hasMore: false };
      }
      conditions.push("a.created_at >= ?");
      params.push(sinceMs);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    // 排序：登记时间新 → 旧；同毫秒按 id DESC（自增主键即登记序）稳定分页
    const rows = this.db
      .prepare(
        `SELECT a.*, i.capability_id AS capability_id
           FROM artifacts a
           JOIN invocations i ON a.invocation_id = i.id${where}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit + 1, q.offset) as unknown as ArtifactJoinRow[];
    return {
      items: rows.slice(0, q.limit).map((row) => ({
        invocation_id: row.invocation_id,
        capability_id: row.capability_id,
        file: row.file,
        relative_path: row.relative_path,
        filename: row.filename,
        mime_type: row.mime_type,
        size: row.size,
        created_at: msToIso(row.created_at) ?? new Date().toISOString(),
      })),
      hasMore: rows.length > q.limit,
    };
  }

  /**
   * 产物汇总（全量口径）：三条轻量聚合——总数/累计大小、"今日新增"
   * （created_at ≥ sinceMs）、去重能力（最近登记倒序封顶 100）。
   */
  artifactStats(sinceMs: number): ArtifactStats {
    const totals = this.db
      .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS total_size FROM artifacts")
      .get() as { total: number; total_size: number };
    const today = this.db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE created_at >= ?")
      .get(sinceMs) as { n: number };
    const caps = this.db
      .prepare(
        `SELECT i.capability_id AS capability_id, MAX(a.created_at) AS latest
           FROM artifacts a
           JOIN invocations i ON a.invocation_id = i.id
          GROUP BY i.capability_id
          ORDER BY latest DESC
          LIMIT 100`,
      )
      .all() as unknown as Array<{ capability_id: string }>;
    return {
      total: totals.total,
      todayCount: today.n,
      totalSize: totals.total_size,
      capabilities: caps.map((c) => c.capability_id),
    };
  }

  clearTerminal(): string[] {
    // 事务：先取终态 ids → 删 artifacts + invocations（artifacts 表属
    // StateStore 域，随行主记录同生共死）；events/logs 由各自 store 级联
    this.db.exec("BEGIN");
    try {
      const rows = this.db
        .prepare(
          `SELECT id FROM invocations WHERE status IN ('completed', 'failed', 'cancelled')`,
        )
        .all() as unknown as Array<{ id: string }>;
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(", ");
      if (ids.length > 0) {
        this.db
          .prepare(`DELETE FROM artifacts WHERE invocation_id IN (${placeholders})`)
          .run(...ids);
        this.db
          .prepare(`DELETE FROM invocations WHERE id IN (${placeholders})`)
          .run(...ids);
      }
      this.db.exec("COMMIT");
      return ids;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 行 → InvocationRecord（含 artifacts 组装，按插入序） */
  private assemble(row: InvocationRow): InvocationRecord {
    const artifactRows = this.db
      .prepare("SELECT * FROM artifacts WHERE invocation_id = ? ORDER BY id")
      .all(row.id) as unknown as ArtifactRow[];
    return {
      invocation_id: row.id,
      capability_id: row.capability_id,
      internalStatus: row.status,
      mode: row.mode,
      input: JSON.parse(row.input) as Record<string, unknown>,
      created_at: msToIso(row.created_at) ?? new Date().toISOString(),
      started_at: msToIso(row.started_at),
      ended_at: msToIso(row.ended_at),
      result: row.result !== null ? JSON.parse(row.result) : undefined,
      error: row.error !== null ? JSON.parse(row.error) : undefined,
      artifacts: artifactRows.map((a) => ({
        file: a.file,
        relative_path: a.relative_path,
        filename: a.filename,
        mime_type: a.mime_type,
        size: a.size,
      })),
    };
  }

  /** 产物登记插入（created_at 由登记时刻生成，ArtifactInfo 无此字段） */
  private insertArtifact(
    invocationId: string,
    artifact: InvocationRecord["artifacts"][number],
  ): void {
    this.db
      .prepare(
        `INSERT INTO artifacts
           (invocation_id, file, relative_path, filename, mime_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invocationId,
        artifact.file,
        artifact.relative_path,
        artifact.filename,
        artifact.mime_type,
        artifact.size,
        Date.now(),
      );
  }
}

// ---------------------------------------------------------------------------
// EventStore 实现（events 表）
// ---------------------------------------------------------------------------

class SqliteEventStore implements EventStore {
  constructor(private readonly db: DatabaseSync) {}

  append(event: ExecutionEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (invocation_id, event_type, timestamp, data)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        event.invocation_id,
        event.event,
        isoToMs(event.timestamp) ?? Date.now(),
        JSON.stringify(event.data),
      );
  }

  listByInvocation(invocationId: string): ExecutionEvent[] {
    // ORDER BY id：自增主键即追加序（事件时间线语义）
    const rows = this.db
      .prepare("SELECT * FROM events WHERE invocation_id = ? ORDER BY id")
      .all(invocationId) as unknown as EventRow[];
    return rows.map((row) => ({
      event: row.event_type,
      invocation_id: row.invocation_id,
      timestamp: msToIso(row.timestamp) ?? new Date().toISOString(),
      data: row.data !== null ? (JSON.parse(row.data) as Record<string, unknown>) : {},
    }));
  }

  deleteByInvocations(invocationIds: readonly string[]): void {
    if (invocationIds.length === 0) return;
    const placeholders = invocationIds.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM events WHERE invocation_id IN (${placeholders})`)
      .run(...invocationIds);
  }
}

// ---------------------------------------------------------------------------
// LogStore 实现（logs 表）
// ---------------------------------------------------------------------------

class SqliteLogStore implements LogStore {
  constructor(private readonly db: DatabaseSync) {}

  append(invocationId: string, log: ExecutionLog): void {
    this.db
      .prepare("INSERT INTO logs (invocation_id, timestamp, message) VALUES (?, ?, ?)")
      .run(invocationId, isoToMs(log.timestamp) ?? Date.now(), log.message);
  }

  listByInvocation(invocationId: string): ExecutionLog[] {
    const rows = this.db
      .prepare("SELECT * FROM logs WHERE invocation_id = ? ORDER BY id")
      .all(invocationId) as unknown as LogRow[];
    return rows.map((row) => ({
      timestamp: msToIso(row.timestamp) ?? new Date().toISOString(),
      message: row.message,
    }));
  }

  deleteByInvocations(invocationIds: readonly string[]): void {
    if (invocationIds.length === 0) return;
    const placeholders = invocationIds.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM logs WHERE invocation_id IN (${placeholders})`)
      .run(...invocationIds);
  }
}
