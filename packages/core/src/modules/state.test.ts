/**
 * 三模块单测（M1-04 验收锚点：接口抽象预留持久化实现位 + 三模块单测通过）
 */
import { describe, expect, it } from "vitest";
import { EventManager, LogManager, StateManager, clearInvocationHistory } from "./state.js";
import { EVENT_TYPES } from "@kiko-workbench/protocol";
import { MemoryEventStore, MemoryLogStore, MemoryStateStore } from "../stores/memory-stores.js";
import { isTerminal, toExternalStatus } from "../stores/types.js";
import type { InvocationRecord } from "../stores/types.js";

/** 构造基准 invocation 记录 */
function makeRecord(overrides: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    invocation_id: "inv_test",
    capability_id: "file.write",
    internalStatus: "created",
    mode: "sync",
    created_at: "2026-08-19T12:00:00Z",
    artifacts: [],
    ...overrides,
  };
}

describe("状态映射（设计文档 6.2 内外映射）", () => {
  it("created/validated/resolved → pending；其余同名", () => {
    expect(toExternalStatus("created")).toBe("pending");
    expect(toExternalStatus("validated")).toBe("pending");
    expect(toExternalStatus("resolved")).toBe("pending");
    expect(toExternalStatus("running")).toBe("running");
    expect(toExternalStatus("completed")).toBe("completed");
    expect(toExternalStatus("failed")).toBe("failed");
    expect(toExternalStatus("cancelled")).toBe("cancelled");
  });

  it("终态判定：completed/failed/cancelled", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("created")).toBe(false);
  });
});

describe("StateManager（内存实现）", () => {
  function setup() {
    return new StateManager(new MemoryStateStore());
  }

  it("create → get 往返；get 返回拷贝防污染", () => {
    const sm = setup();
    sm.create(makeRecord());
    const got = sm.get("inv_test");
    expect(got?.capability_id).toBe("file.write");
    // 篡改返回值不影响内部数据源
    got!.internalStatus = "completed";
    expect(sm.get("inv_test")?.internalStatus).toBe("created");
  });

  it("get 不存在的 id → undefined", () => {
    expect(setup().get("inv_none")).toBeUndefined();
  });

  it("create 重复 id → 抛错（nanoid 冲突防御）", () => {
    const sm = setup();
    sm.create(makeRecord());
    expect(() => sm.create(makeRecord())).toThrow(/重复/);
  });

  it("update 浅合并字段", () => {
    const sm = setup();
    sm.create(makeRecord());
    sm.update("inv_test", { internalStatus: "running", started_at: "2026-08-19T12:00:01Z" });
    const got = sm.get("inv_test");
    expect(got?.internalStatus).toBe("running");
    expect(got?.started_at).toBe("2026-08-19T12:00:01Z");
  });

  it("终态记录禁止再迁移状态（40004 兜底，设计文档 6.2 表末行）", () => {
    const sm = setup();
    sm.create(makeRecord({ internalStatus: "completed" }));
    expect(() => sm.update("inv_test", { internalStatus: "failed" })).toThrow(/终态/);
  });

  it('listByStatus("running") 仅返回运行中记录（崩溃恢复场景）', () => {
    const sm = setup();
    sm.create(makeRecord({ invocation_id: "inv_a", internalStatus: "running" }));
    sm.create(makeRecord({ invocation_id: "inv_b", internalStatus: "completed" }));
    sm.create(makeRecord({ invocation_id: "inv_c", internalStatus: "created" }));
    const running = sm.listByStatus("running");
    expect(running.map((r) => r.invocation_id)).toEqual(["inv_a"]);
  });
});

describe("EventManager（5.4 六标准事件）", () => {
  it("emit：存储 + 分发全部订阅者，返回事件对象", () => {
    const em = new EventManager(new MemoryEventStore());
    const received: string[] = [];
    em.subscribe((e) => received.push(e.event));
    const event = em.emit(EVENT_TYPES.EXECUTION_STARTED, "inv_1", { plugin: "file" });
    expect(event.event).toBe("execution.started");
    expect(event.invocation_id).toBe("inv_1");
    expect(typeof event.timestamp).toBe("string");
    expect(received).toEqual(["execution.started"]);
    expect(em.listByInvocation("inv_1")).toHaveLength(1);
  });

  it("订阅者异常不阻断其他订阅者", () => {
    const em = new EventManager(new MemoryEventStore());
    const received: string[] = [];
    em.subscribe(() => {
      throw new Error("订阅者炸了");
    });
    em.subscribe((e) => received.push(e.event));
    expect(() => em.emit(EVENT_TYPES.EXECUTION_COMPLETED, "inv_1")).not.toThrow();
    expect(received).toEqual(["execution.completed"]);
  });

  it("subscribe 返回退订函数，退订后不再收到事件", () => {
    const em = new EventManager(new MemoryEventStore());
    const received: string[] = [];
    const unsubscribe = em.subscribe((e) => received.push(e.event));
    em.emit(EVENT_TYPES.EXECUTION_PROGRESS, "inv_1", { percent: 40 });
    unsubscribe();
    em.emit(EVENT_TYPES.EXECUTION_PROGRESS, "inv_1", { percent: 80 });
    expect(received).toHaveLength(1);
  });
});

describe("LogManager（Event 与 Log 严格分离）", () => {
  it("append → listByInvocation 按序返回", () => {
    const lm = new LogManager(new MemoryLogStore());
    lm.append("inv_1", "loading template");
    lm.append("inv_1", "rendering document");
    lm.append("inv_2", "other invocation");
    const logs = lm.listByInvocation("inv_1");
    expect(logs.map((l) => l.message)).toEqual(["loading template", "rendering document"]);
    expect(logs[0]?.timestamp).toBeTruthy();
  });

  it("无日志的 invocation → 空数组", () => {
    expect(new LogManager(new MemoryLogStore()).listByInvocation("inv_none")).toEqual([]);
  });
});

describe("clearInvocationHistory（历史清理编排）", () => {
  it("终态全清 + 事件/日志级联；非终态三件套原样保留", () => {
    const state = new StateManager(new MemoryStateStore());
    const events = new EventManager(new MemoryEventStore());
    const logs = new LogManager(new MemoryLogStore());

    // 两条终态 + 一条运行中（含事件与日志）
    state.create(makeRecord({ invocation_id: "inv_done", internalStatus: "completed" }));
    state.create(makeRecord({ invocation_id: "inv_fail", internalStatus: "failed" }));
    state.create(makeRecord({ invocation_id: "inv_run", internalStatus: "running" }));
    for (const id of ["inv_done", "inv_fail", "inv_run"]) {
      events.emit(EVENT_TYPES.EXECUTION_STARTED, id);
      logs.append(id, "processing");
    }

    const cleared = clearInvocationHistory({ state, events, logs });
    expect(cleared).toBe(2);

    // 终态三件套删净
    expect(state.get("inv_done")).toBeUndefined();
    expect(events.listByInvocation("inv_done")).toHaveLength(0);
    expect(logs.listByInvocation("inv_fail")).toHaveLength(0);
    // 运行中的三件套完整（收尾路径依赖）
    expect(state.get("inv_run")).toBeDefined();
    expect(events.listByInvocation("inv_run")).toHaveLength(1);
    expect(logs.listByInvocation("inv_run")).toHaveLength(1);
  });

  it("无终态记录 → 返回 0 且不触碰任何数据（幂等空操作）", () => {
    const state = new StateManager(new MemoryStateStore());
    const events = new EventManager(new MemoryEventStore());
    const logs = new LogManager(new MemoryLogStore());
    state.create(makeRecord({ invocation_id: "inv_run", internalStatus: "running" }));
    events.emit(EVENT_TYPES.EXECUTION_STARTED, "inv_run");

    expect(clearInvocationHistory({ state, events, logs })).toBe(0);
    expect(state.get("inv_run")).toBeDefined();
    expect(events.listByInvocation("inv_run")).toHaveLength(1);
  });
});
