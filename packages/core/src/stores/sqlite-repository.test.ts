/**
 * SQLite Repository 单测（M2-01 验收锚点）
 *
 * 测试面：
 *   1. 同构套件：Memory 与 SQLite 两实现跑同一组行为断言（接口契约的
 *      机器证明——切换持久化实现零行为差异，设计文档 6.4 验收锚点）
 *   2. 持久化往返：文件 DB 写入 → close → 重开 → 四表数据完整
 *   3. WAL 模式验证（文件库；:memory: 自动退化为 journal）
 *   4. artifacts 追加语义：多次 update 追加、created_at 不被冲掉
 *   5. 启动恢复（7.3）：见 recovery.test.ts（本文件只测存储层）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionEvent } from "@kiko-workbench/protocol";
import {
  MemoryEventStore,
  MemoryLogStore,
  MemoryStateStore,
  createSqliteStores,
  type SqliteStores,
} from "../index.js";
import type { EventStore, InvocationRecord, LogStore, StateStore } from "./types.js";

// ---------------------------------------------------------------------------
// 测试物料
// ---------------------------------------------------------------------------

/** 构造完整记录（可选字段按需覆写） */
function makeRecord(overrides: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    invocation_id: "inv_test000001",
    capability_id: "file.write",
    internalStatus: "created",
    mode: "sync",
    input: { path: "a.txt", content: "你好" },
    created_at: "2026-08-20T10:00:00.000Z",
    artifacts: [],
    ...overrides,
  };
}

function makeEvent(seq: number, invocationId: string): ExecutionEvent {
  return {
    event: "execution.started",
    invocation_id: invocationId,
    timestamp: new Date(Date.UTC(2026, 7, 20, 10, 0, seq)).toISOString(),
    data: { seq },
  };
}

/** 三 store 组合（同构套件对两种实现统一形状） */
interface StoreBundle {
  state: StateStore;
  events: EventStore;
  logs: LogStore;
  close?: () => void;
}

function memoryBundle(): StoreBundle {
  return {
    state: new MemoryStateStore(),
    events: new MemoryEventStore(),
    logs: new MemoryLogStore(),
  };
}

function sqliteBundle(): StoreBundle {
  const stores: SqliteStores = createSqliteStores(":memory:");
  return { state: stores.state, events: stores.events, logs: stores.logs, close: stores.close };
}

// ---------------------------------------------------------------------------
// 同构套件（两种实现 × 同一行为断言）
// ---------------------------------------------------------------------------

/** 同构行为套件：bundle 工厂驱动，Memory 与 SQLite 各注册一遍 */
function behaviorSuite(name: string, makeBundle: () => StoreBundle): void {
  describe(`同构行为套件：${name}`, () => {
    let bundle: StoreBundle;
    beforeAll(() => {
      bundle = makeBundle();
    });
    afterAll(() => {
      bundle.close?.();
    });

    // ---- StateStore ----

    it("create → get 完整往返（含 input JSON / ISO 时间戳 / artifacts 空数组）", () => {
      const record = makeRecord();
      bundle.state.create(record);
      const loaded = bundle.state.get("inv_test000001");
      expect(loaded).toEqual(record);
    });

    it("get 不存在 → undefined；update 不存在 → 抛错", () => {
      expect(bundle.state.get("inv_ghost")).toBeUndefined();
      expect(() => bundle.state.update("inv_ghost", { internalStatus: "running" })).toThrow();
    });

    it("update 浅合并：状态迁移 + started_at / result / error 落位", () => {
      bundle.state.update("inv_test000001", {
        internalStatus: "running",
        started_at: "2026-08-20T10:00:01.000Z",
      });
      bundle.state.update("inv_test000001", {
        internalStatus: "completed",
        ended_at: "2026-08-20T10:00:02.000Z",
        result: { path: "a.txt", size: 12 },
      });
      const loaded = bundle.state.get("inv_test000001");
      expect(loaded?.internalStatus).toBe("completed");
      expect(loaded?.started_at).toBe("2026-08-20T10:00:01.000Z");
      expect(loaded?.ended_at).toBe("2026-08-20T10:00:02.000Z");
      expect(loaded?.result).toEqual({ path: "a.txt", size: 12 });
      // 未 patch 字段保留（浅合并非全量替换）
      expect(loaded?.input).toEqual({ path: "a.txt", content: "你好" });
    });

    it("终态记录拒绝状态迁移（6.2 末行存储层兜底）", () => {
      expect(() => bundle.state.update("inv_test000001", { internalStatus: "failed" })).toThrow(
        /终态/,
      );
      // 同状态幂等 patch（非迁移）不拒
      expect(() =>
        bundle.state.update("inv_test000001", { internalStatus: "completed" }),
      ).not.toThrow();
    });

    it("listByStatus：pending 合并内部前三态；终态同名过滤", () => {
      // inv_test000001 已 completed；补三条中间态
      bundle.state.create(makeRecord({ invocation_id: "inv_a", internalStatus: "created" }));
      bundle.state.create(makeRecord({ invocation_id: "inv_b", internalStatus: "resolved" }));
      bundle.state.create(makeRecord({ invocation_id: "inv_c", internalStatus: "running" }));
      const pending = bundle.state.listByStatus("pending").map((r) => r.invocation_id);
      expect(pending.sort()).toEqual(["inv_a", "inv_b"]);
      expect(bundle.state.listByStatus("running").map((r) => r.invocation_id)).toEqual(["inv_c"]);
      expect(bundle.state.listByStatus("completed").map((r) => r.invocation_id)).toEqual([
        "inv_test000001",
      ]);
    });

    it("artifacts 追加语义：多次 update 逐步累积、顺序稳定", () => {
      bundle.state.create(makeRecord({ invocation_id: "inv_art", internalStatus: "running" }));
      const artifact = (name: string) => ({
        file: `C:/ws/${name}`,
        relative_path: name,
        filename: name,
        mime_type: "text/plain",
        size: 100,
      });
      bundle.state.update("inv_art", { artifacts: [artifact("a.txt")] });
      bundle.state.update("inv_art", {
        artifacts: [artifact("a.txt"), artifact("b.txt")],
      });
      bundle.state.update("inv_art", {
        artifacts: [artifact("a.txt"), artifact("b.txt"), artifact("c.txt")],
      });
      const loaded = bundle.state.get("inv_art");
      expect(loaded?.artifacts.map((a) => a.filename)).toEqual(["a.txt", "b.txt", "c.txt"]);
      // ArtifactInfo 形状完整（不含 created_at——那是 DB 列，非接口字段）
      expect(loaded?.artifacts[0]).toEqual({
        file: "C:/ws/a.txt",
        relative_path: "a.txt",
        filename: "a.txt",
        mime_type: "text/plain",
        size: 100,
      });
    });

    // ---- StateStore.query（M2-08 分页 / 筛选，UI 调用历史） ----

    it("query：新→旧排序 + limit/offset 分页 + has_more 探测", () => {
      // 独立能力名（query.page）隔离出恰好 5 条，分页断言不受套件共享记录干扰
      const ids = ["inv_q1", "inv_q2", "inv_q3", "inv_q4", "inv_q5"];
      ids.forEach((id, i) => {
        bundle.state.create(
          makeRecord({
            invocation_id: id,
            capability_id: "query.page",
            // completed：避免混入下方 pending 过滤断言（pending 仅 inv_a/inv_b）
            internalStatus: "completed",
            created_at: `2026-08-20T10:00:${10 + i}.000Z`,
          }),
        );
      });
      const onlyQ = { limit: 2, offset: 0, capabilityContains: "query.page" };
      // 第一页 2 条（新→旧），has_more=true（总数 5 > 2）
      const page1 = bundle.state.query({ ...onlyQ });
      expect(page1.items.map((r) => r.invocation_id)).toEqual(["inv_q5", "inv_q4"]);
      expect(page1.hasMore).toBe(true);
      // 第二页翻到尾：剩 1 条且不足 limit → has_more=false
      const page2 = bundle.state.query({ ...onlyQ, offset: 4 });
      expect(page2.items.map((r) => r.invocation_id)).toEqual(["inv_q1"]);
      expect(page2.hasMore).toBe(false);
      // 恰好整页（offset 2 取 q3/q2）：limit+1 探测行存在 → has_more=true
      const page3 = bundle.state.query({ ...onlyQ, offset: 2 });
      expect(page3.hasMore).toBe(true);
    });

    it("query：状态过滤（pending 映射内部三态）+ 能力子串 + since 时间下界", () => {
      // 状态：套件中 pending = inv_a/inv_b（created 默认 10:00:00，最新 pending 段）
      const pending = bundle.state.query({ limit: 10, offset: 0, status: "pending" });
      expect(pending.items.map((r) => r.invocation_id).sort()).toEqual(["inv_a", "inv_b"]);
      // 能力子串：默认 capability_id = file.write
      const writes = bundle.state.query({ limit: 10, offset: 0, capabilityContains: "file.wr" });
      expect(writes.items.length).toBeGreaterThan(0);
      expect(writes.items.every((r) => r.capability_id.toLowerCase().includes("file.wr"))).toBe(
        true,
      );
      const nomatch = bundle.state.query({ limit: 10, offset: 0, capabilityContains: "document" });
      expect(nomatch.items).toHaveLength(0);
      // since：只留 10:00:12 之后的（q3..q5）
      const recent = bundle.state.query({
        limit: 10,
        offset: 0,
        since: "2026-08-20T10:00:12.000Z",
      });
      expect(recent.items.map((r) => r.invocation_id)).toEqual(["inv_q5", "inv_q4", "inv_q3"]);
      // since 非法 ISO → 空结果（防御约定，两实现同语义）
      const invalid = bundle.state.query({ limit: 10, offset: 0, since: "not-a-date" });
      expect(invalid.items).toHaveLength(0);
      expect(invalid.hasMore).toBe(false);
    });

    it("query：能力子串含 SQL 通配符按字面量匹配（LIKE 转义）", () => {
      // "file.write" 中含 "." 不含通配符；用 % 注入尝试匹配全表——应零命中
      const wildcard = bundle.state.query({ limit: 10, offset: 0, capabilityContains: "%wri" });
      expect(wildcard.items).toHaveLength(0);
    });

    // ---- StateStore.queryArtifacts / artifactStats（产出物页数据源） ----

    it("queryArtifacts：分页 + has_more 探测 + 登记序倒序（同毫秒稳定）", () => {
      // 独立能力（art.page）隔离出恰好 5 条产物：同 invocation 逐次追加，
      // 登记时间极可能同毫秒——排序落点在登记序 DESC（a.id DESC / seq DESC）
      bundle.state.create(
        makeRecord({ invocation_id: "inv_artq", capability_id: "art.page" }),
      );
      const artifact = (name: string) => ({
        file: `C:/ws/${name}`,
        relative_path: name,
        filename: name,
        mime_type: "text/plain",
        size: 100,
      });
      const names = ["p1.txt", "p2.txt", "p3.txt", "p4.txt", "p5.txt"];
      for (let i = 1; i <= names.length; i++) {
        bundle.state.update("inv_artq", { artifacts: names.slice(0, i).map(artifact) });
      }
      const onlyArt = { limit: 2, offset: 0, capabilityContains: "art.page" };
      // 第一页 2 条（登记新 → 旧），has_more=true（5 > 2）
      const page1 = bundle.state.queryArtifacts({ ...onlyArt });
      expect(page1.items.map((a) => a.filename)).toEqual(["p5.txt", "p4.txt"]);
      expect(page1.items[0]).toMatchObject({
        invocation_id: "inv_artq",
        capability_id: "art.page",
        file: "C:/ws/p5.txt",
        relative_path: "p5.txt",
        mime_type: "text/plain",
        size: 100,
      });
      expect(typeof page1.items[0].created_at).toBe("string");
      expect(page1.hasMore).toBe(true);
      // 尾页：剩 1 条且不足 limit → has_more=false
      const page2 = bundle.state.queryArtifacts({ ...onlyArt, offset: 4 });
      expect(page2.items.map((a) => a.filename)).toEqual(["p1.txt"]);
      expect(page2.hasMore).toBe(false);
      // 恰好整页（offset 2 取 p3/p2）：探测行存在 → has_more=true
      const page3 = bundle.state.queryArtifacts({ ...onlyArt, offset: 2 });
      expect(page3.items.map((a) => a.filename)).toEqual(["p3.txt", "p2.txt"]);
      expect(page3.hasMore).toBe(true);
    });

    it("queryArtifacts：文件名子串 + 能力子串 + since 时间下界 + 非法 since", () => {
      // 文件名子串（大小写不敏感）：p4 精确命中 1 条
      const byName = bundle.state.queryArtifacts({
        limit: 10,
        offset: 0,
        capabilityContains: "art.page",
        filenameContains: "P4",
      });
      expect(byName.items.map((a) => a.filename)).toEqual(["p4.txt"]);
      // 能力子串无命中（隔离验证：别的记录不混入）
      const nomatch = bundle.state.queryArtifacts({
        limit: 10,
        offset: 0,
        capabilityContains: "art.none",
      });
      expect(nomatch.items).toHaveLength(0);
      // since：登记时刻为真实时钟（Date.now），用"过去 1s"全收 / "未来 1min"全空
      const past = bundle.state.queryArtifacts({
        limit: 10,
        offset: 0,
        since: new Date(Date.now() - 1000).toISOString(),
      });
      expect(past.items.length).toBeGreaterThanOrEqual(5);
      const future = bundle.state.queryArtifacts({
        limit: 10,
        offset: 0,
        since: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(future.items).toHaveLength(0);
      expect(future.hasMore).toBe(false);
      // since 非法 ISO → 恒空结果（防御约定，两实现同语义）
      const invalid = bundle.state.queryArtifacts({ limit: 10, offset: 0, since: "not-a-date" });
      expect(invalid.items).toHaveLength(0);
      expect(invalid.hasMore).toBe(false);
    });

    it("queryArtifacts：文件名含 SQL 通配符按字面量匹配（LIKE 转义）", () => {
      // % 注入尝试匹配全部——应零命中（art.page 产物文件名均不含字面 %）
      const wildcard = bundle.state.queryArtifacts({
        limit: 10,
        offset: 0,
        capabilityContains: "art.page",
        filenameContains: "%p",
      });
      expect(wildcard.items).toHaveLength(0);
    });

    it("artifactStats：总数 / 今日新增 / 累计大小 / 去重能力（含 inv_art 旧产物）", () => {
      // 共享 bundle：此时库内产物 = inv_art 的 a/b/c.txt（3 条）+ art.page 5 条
      const stats = bundle.state.artifactStats(Date.now() - 1000);
      expect(stats.total).toBe(8);
      expect(stats.todayCount).toBe(8); // 登记时刻均为本测试运行的真实时钟
      expect(stats.totalSize).toBe(800); // 每条 size=100
      // 去重能力含两个来源（顺序按最近登记时间倒序：art.page 最新）
      expect(stats.capabilities).toContain("art.page");
      expect(stats.capabilities).toContain("file.write");
      expect(stats.capabilities[0]).toBe("art.page");
      // sinceMs 未来 → 今日 0（总数口径不变）
      const tomorrow = bundle.state.artifactStats(Date.now() + 60_000);
      expect(tomorrow.todayCount).toBe(0);
      expect(tomorrow.total).toBe(8);
    });

    // ---- EventStore ----

    it("events append → listByInvocation 按追加序返回（data JSON 往返）", () => {
      for (let i = 1; i <= 3; i++) bundle.events.append(makeEvent(i, "inv_ev"));
      bundle.events.append(makeEvent(9, "inv_other")); // 他人事件不混入
      const list = bundle.events.listByInvocation("inv_ev");
      expect(list).toHaveLength(3);
      expect(list.map((e) => e.data["seq"])).toEqual([1, 2, 3]);
      expect(list[0]).toEqual({
        event: "execution.started",
        invocation_id: "inv_ev",
        timestamp: "2026-08-20T10:00:01.000Z",
        data: { seq: 1 },
      });
    });

    // ---- LogStore ----

    it("logs append → listByInvocation 按追加序返回", () => {
      bundle.logs.append("inv_lg", { timestamp: "2026-08-20T10:00:01.000Z", message: "步骤一" });
      bundle.logs.append("inv_lg", { timestamp: "2026-08-20T10:00:02.000Z", message: "步骤二" });
      bundle.logs.append("inv_other", { timestamp: "2026-08-20T10:00:03.000Z", message: "无关" });
      expect(bundle.logs.listByInvocation("inv_lg")).toEqual([
        { timestamp: "2026-08-20T10:00:01.000Z", message: "步骤一" },
        { timestamp: "2026-08-20T10:00:02.000Z", message: "步骤二" },
      ]);
    });

    // ---- 历史清理（clearTerminal / deleteByInvocations，两实现同构） ----

    it("clearTerminal → 仅删终态（非终态保留），返回被删 id；级联删除 events/logs", () => {
      // 三种终态 + 两种非终态
      for (const [id, status] of [
        ["inv_done", "completed"],
        ["inv_fail", "failed"],
        ["inv_cxl", "cancelled"],
        ["inv_run", "running"],
        ["inv_new", "created"],
      ] as const) {
        bundle.state.create(makeRecord({ invocation_id: id, internalStatus: status }));
        bundle.events.append(makeEvent(1, id));
        bundle.logs.append(id, { timestamp: "2026-08-20T10:00:01.000Z", message: "log" });
      }

      const deleted = bundle.state.clearTerminal();
      // 本用例的三条终态必在其中（共享 bundle，前置用例的终态记录同样被清）
      expect(deleted).toContain("inv_done");
      expect(deleted).toContain("inv_fail");
      expect(deleted).toContain("inv_cxl");

      // 终态记录消失，非终态保留；全库不再有任何终态残留
      expect(bundle.state.get("inv_done")).toBeUndefined();
      expect(bundle.state.get("inv_run")).toBeDefined();
      expect(bundle.state.get("inv_new")).toBeDefined();
      for (const r of bundle.state.list()) {
        expect(
          r.internalStatus === "completed" ||
            r.internalStatus === "failed" ||
            r.internalStatus === "cancelled",
        ).toBe(false);
      }

      // 级联：终态的 events/logs 删净，非终态的原样保留
      bundle.events.deleteByInvocations(deleted);
      bundle.logs.deleteByInvocations(deleted);
      expect(bundle.events.listByInvocation("inv_done")).toHaveLength(0);
      expect(bundle.logs.listByInvocation("inv_done")).toHaveLength(0);
      expect(bundle.events.listByInvocation("inv_run")).toHaveLength(1);
      expect(bundle.logs.listByInvocation("inv_run")).toHaveLength(1);

      // 幂等：重复清理 / 空 id 列表不炸不误删
      expect(bundle.state.clearTerminal()).toHaveLength(0);
      bundle.events.deleteByInvocations([]);
      bundle.logs.deleteByInvocations([]);
      expect(bundle.state.get("inv_run")).toBeDefined();
    });
  });
}

behaviorSuite("MemoryStore（M1）", memoryBundle);
behaviorSuite("SqliteStore（M2-01，:memory:）", sqliteBundle);

// ---------------------------------------------------------------------------
// SQLite 专属：持久化往返 / WAL / 文件库
// ---------------------------------------------------------------------------

describe("SQLite 持久化（文件库，M2-01 验收）", () => {
  let dbDir: string;

  beforeAll(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "kiko-sqlite-"));
  });
  afterAll(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it("journal_mode = WAL（7.2 实现约束）", () => {
    const dbPath = join(dbDir, "wal-check.db");
    const stores = createSqliteStores(dbPath);
    // 独立连接读 pragma（用后即关：Windows 下句柄未释放会锁住 -wal 文件）
    const probe = new DatabaseSync(dbPath);
    const mode = (probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
    probe.close();
    stores.close();
    expect(mode).toBe("wal");
  });

  it("vacuum()：清空后重建页文件不抛错，库仍可读写（历史清理收尾）", () => {
    const dbPath = join(dbDir, "vacuum-check.db");
    const stores = createSqliteStores(dbPath);
    stores.state.create(makeRecord({ invocation_id: "inv_v1", internalStatus: "completed" }));
    stores.state.create(makeRecord({ invocation_id: "inv_v2", internalStatus: "running" }));
    expect(stores.state.clearTerminal()).toEqual(["inv_v1"]);
    // VACUUM（WAL 模式下合法：自动 checkpoint 后重建）
    expect(() => stores.vacuum()).not.toThrow();
    // 重建后库功能完好：非终态记录仍在，新写入正常
    expect(stores.state.get("inv_v2")).toBeDefined();
    stores.state.create(makeRecord({ invocation_id: "inv_v3", internalStatus: "created" }));
    expect(stores.state.get("inv_v3")).toBeDefined();
    stores.close();
  });

  it("持久化往返：写入 → close → 重开 → 四表数据完整（kill 重启不丢数据）", () => {
    const dbPath = join(dbDir, "roundtrip.db");
    const first = createSqliteStores(dbPath);
    // 造一条完整生命周期记录 + 事件 + 日志 + 双产物
    first.state.create(makeRecord({ invocation_id: "inv_persist", internalStatus: "completed" }));
    first.state.update("inv_persist", {
      started_at: "2026-08-20T10:00:01.000Z",
      ended_at: "2026-08-20T10:00:02.000Z",
      result: { path: "out.docx", size: 2048 },
      error: undefined,
      artifacts: [
        {
          file: "C:/ws/document/out.docx",
          relative_path: "document/out.docx",
          filename: "out.docx",
          mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 2048,
        },
        {
          file: "C:/ws/document/out (2).docx",
          relative_path: "document/out (2).docx",
          filename: "out (2).docx",
          mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 2048,
        },
      ],
    });
    first.events.append(makeEvent(1, "inv_persist"));
    first.events.append(makeEvent(2, "inv_persist"));
    first.logs.append("inv_persist", { timestamp: "2026-08-20T10:00:01.000Z", message: "生成中" });
    first.close();

    // 重开（模拟应用重启）
    const second = createSqliteStores(dbPath);
    const record = second.state.get("inv_persist");
    expect(record?.internalStatus).toBe("completed");
    expect(record?.result).toEqual({ path: "out.docx", size: 2048 });
    expect(record?.artifacts.map((a) => a.filename)).toEqual(["out.docx", "out (2).docx"]);
    expect(second.events.listByInvocation("inv_persist")).toHaveLength(2);
    expect(second.logs.listByInvocation("inv_persist")).toEqual([
      { timestamp: "2026-08-20T10:00:01.000Z", message: "生成中" },
    ]);
    // list 全量同样完整
    expect(second.state.list()).toHaveLength(1);
    second.close();
  });

  it("重复 create（同 id）→ 抛错（主键冲突，与内存实现同语义）", () => {
    const stores = createSqliteStores(":memory:");
    stores.state.create(makeRecord());
    expect(() => stores.state.create(makeRecord())).toThrow();
    stores.close();
  });
});
