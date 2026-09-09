/**
 * 启动恢复单测（M2-01：设计文档 7.3）
 *
 * 场景覆盖：
 *   - 空库恢复 → 0 条（正常启动）
 *   - pending / running 残留 → 全部 failed（50001 workbench restarted）
 *     + ended_at 落位 + 补发 execution.failed 事件（data 含 code/message）
 *   - 终态记录不动（completed 不被恢复波及）
 *   - 幂等：二次恢复 → 0 条（全部已是终态）
 *   - SQLite 集成：文件库造 running 残留（模拟 kill 时未落终态）→
 *     新实例恢复 → get_execution 视角完整验证（含事件时间线）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventManager,
  MemoryEventStore,
  MemoryStateStore,
  StateManager,
  createSqliteStores,
  recoverInterruptedInvocations,
} from "../index.js";
import { toExternalStatus, type InvocationRecord, type StateStore } from "../stores/types.js";

/** 组装恢复环境（StateManager + EventManager + 捕获事件流） */
function makeFixture(store: StateStore) {
  const state = new StateManager(store);
  const events = new EventManager(new MemoryEventStore());
  const emitted: Array<{ event: string; invocation_id: string; data: Record<string, unknown> }> =
    [];
  events.subscribe((e) =>
    emitted.push({ event: e.event, invocation_id: e.invocation_id, data: e.data }),
  );
  return { state, events, emitted };
}

function makeRecord(id: string, status: InvocationRecord["internalStatus"]): InvocationRecord {
  return {
    invocation_id: id,
    capability_id: "file.write",
    internalStatus: status,
    mode: "async",
    input: { path: "x.txt" },
    created_at: "2026-08-20T10:00:00.000Z",
    artifacts: [],
  };
}

describe("启动恢复（7.3，内存存储）", () => {
  it("空库 → 恢复 0 条", () => {
    const { state, events } = makeFixture(new MemoryStateStore());
    expect(recoverInterruptedInvocations({ state, events })).toBe(0);
  });

  it("pending + running 残留 → 全部 failed（50001 / workbench restarted）+ 补发事件；终态不动", () => {
    const store = new MemoryStateStore();
    const { state, events, emitted } = makeFixture(store);
    store.create(makeRecord("inv_p", "resolved")); // pending（内部 resolved）
    store.create(makeRecord("inv_r", "running"));
    store.create(makeRecord("inv_done", "completed")); // 终态不波及
    store.create(makeRecord("inv_fail", "failed"));

    const recovered = recoverInterruptedInvocations({ state, events });
    expect(recovered).toBe(2);

    for (const id of ["inv_p", "inv_r"]) {
      const record = state.get(id);
      expect(record?.internalStatus).toBe("failed");
      expect(record?.error).toEqual({ code: 50001, message: "workbench restarted" });
      expect(record?.ended_at).toBeDefined();
    }
    // 终态记录原样
    expect(state.get("inv_done")?.internalStatus).toBe("completed");
    expect(state.get("inv_fail")?.error).toBeUndefined(); // 原失败记录无恢复覆盖

    // 补发事件：仅两条 execution.failed，data 与 7.3 原文一致
    expect(emitted).toEqual([
      {
        event: "execution.failed",
        invocation_id: "inv_p",
        data: { code: 50001, message: "workbench restarted" },
      },
      {
        event: "execution.failed",
        invocation_id: "inv_r",
        data: { code: 50001, message: "workbench restarted" },
      },
    ]);

    // 幂等：二次恢复 → 0（全部终态）
    expect(recoverInterruptedInvocations({ state, events })).toBe(0);
  });
});

describe("启动恢复（7.3，SQLite 持久化集成）", () => {
  let dbDir: string;
  beforeAll(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "kiko-recovery-"));
  });
  afterAll(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it("kill 残留 running → 重启恢复 failed（文件库往返，M2-01 验收锚点）", () => {
    const dbPath = join(dbDir, "recovery.db");

    // 第一次启动：造 running 残留后直接 close（模拟 kill 时未落终态）
    const first = createSqliteStores(dbPath);
    first.state.create(makeRecord("inv_killed", "running"));
    first.events.append({
      event: "execution.started",
      invocation_id: "inv_killed",
      timestamp: "2026-08-20T10:00:01.000Z",
      data: {},
    });
    first.close();

    // 第二次启动（新进程视角）：恢复 + 验证
    const second = createSqliteStores(dbPath);
    const state = new StateManager(second.state);
    const events = new EventManager(second.events);
    expect(recoverInterruptedInvocations({ state, events })).toBe(1);

    const record = state.get("inv_killed");
    expect(record?.internalStatus).toBe("failed");
    expect(toExternalStatus(record?.internalStatus ?? "created")).toBe("failed");
    expect(record?.error).toEqual({ code: 50001, message: "workbench restarted" });

    // 事件时间线：历史 started + 恢复补发的 failed（顺序保留）
    const timeline = events.listByInvocation("inv_killed").map((e) => e.event);
    expect(timeline).toEqual(["execution.started", "execution.failed"]);

    // 恢复事件已落库（第三次启动可见持久痕迹；且不再重复恢复）
    second.close();
    const third = createSqliteStores(dbPath);
    const state3 = new StateManager(third.state);
    const events3 = new EventManager(third.events);
    expect(recoverInterruptedInvocations({ state: state3, events: events3 })).toBe(0);
    expect(events3.listByInvocation("inv_killed").map((e) => e.event)).toEqual([
      "execution.started",
      "execution.failed",
    ]);
    third.close();
  });
});
