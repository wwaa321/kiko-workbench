/**
 * InvocationManager 单测（M1-06 验收锚点）
 *
 * 验收锚点：
 *   - 6.2 状态转换表逐行单测（8 行全覆盖）
 *   - 40002 携带 ajv 明细
 *   - 终态操作拒绝返回 40004
 *   - timeout_ms 控制（fake timers）
 *   - get_execution 组装（5.3.4）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvocationManager } from "./invocation.js";
import { EventManager, LogManager, StateManager } from "./state.js";
import { MemoryEventStore, MemoryLogStore, MemoryStateStore } from "../stores/memory-stores.js";
import type { CapabilityRegistry } from "./registry.js";
import {
  ERROR_CODES,
  EVENT_TYPES,
  RpcError,
  type CapabilityDefinition,
} from "@kiko-workbench/protocol";

/** 测试用能力定义：file.write 形状（content 必填 string） */
const CAPABILITY: CapabilityDefinition = {
  id: "file.write",
  name: "Write File",
  description: "Write file to workspace",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  output_schema: { type: "object" },
  timeout_ms: 1000, // 测试用短超时
};

/** Registry stub：只提供 resolveCapability / describe（无需真实目录扫描） */
function makeRegistry(): CapabilityRegistry {
  return {
    resolveCapability: (capabilityId: string) => {
      if (capabilityId !== CAPABILITY.id) {
        throw new RpcError(ERROR_CODES.CAPABILITY_NOT_FOUND, `能力不存在：${capabilityId}`);
      }
      return {
        plugin: {
          id: "file",
          name: "File",
          description: "",
          version: "1.0.0",
          entry: "index.js",
          permissions: [],
          status: "enabled",
          rootDir: "/plugins/file",
        },
        definition: CAPABILITY,
      };
    },
  } as unknown as CapabilityRegistry;
}

/** 组装被测对象（含真实三 Manager + 内存存储） */
function setup(overrides: { onCancelRequested?: (id: string) => void } = {}) {
  const state = new StateManager(new MemoryStateStore());
  const events = new EventManager(new MemoryEventStore());
  const logs = new LogManager(new MemoryLogStore());
  let seq = 0;
  const manager = new InvocationManager({
    registry: makeRegistry(),
    state,
    events,
    logs,
    // 与默认 nanoid(12) 同长度：t + 11 位序号 = 12 字符，满足 inv_ 前缀格式断言
    generateId: () => `t${String(++seq).padStart(11, "0")}`,
    onCancelRequested: overrides.onCancelRequested,
  });
  return { manager, state, events, logs };
}

/** 创建一个成功通过校验的 invocation（resolved 态） */
function createValid(manager: InvocationManager, mode: "sync" | "async" = "sync") {
  return manager.createInvocation({
    capabilityId: "file.write",
    input: { path: "notes.txt", content: "hello" },
    mode,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createInvocation：行1 / 行2 + invocation_id 格式", () => {
  it("行1：ajv 校验通过 → resolved（外部 pending），发 invocation.created", () => {
    const { manager, events } = setup();
    const record = createValid(manager);

    expect(record.invocation_id).toMatch(/^inv_[A-Za-z0-9_-]{12}$/);
    expect(record.internalStatus).toBe("resolved");
    expect(record.mode).toBe("sync");
    const created = events.listByInvocation(record.invocation_id);
    expect(created[0]?.event).toBe("invocation.created");
    expect(created[0]?.data).toEqual({ capability_id: "file.write", mode: "sync" });
  });

  it("能力不存在 → 40001，不产生 invocation", () => {
    const { manager, state } = setup();
    try {
      manager.createInvocation({ capabilityId: "nope.x", input: {} });
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.CAPABILITY_NOT_FOUND);
    }
    expect(state.list()).toHaveLength(0);
  });

  it("行2：校验失败 → invocation 落 failed + execution.failed 事件 + 抛 40002（data 携带 ajv 明细）", () => {
    const { manager, state, events } = setup();
    // content 缺失 + path 类型错误：制造多条 ajv 错误验证 allErrors 明细
    try {
      manager.createInvocation({
        capabilityId: "file.write",
        input: { path: 123 },
      });
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      const rpcError = e as RpcError;
      expect(rpcError.code).toBe(ERROR_CODES.INPUT_VALIDATION_FAILED);
      // ajv 明细（5.5 契约形状：data.errors）：required(content) + type(path: string)
      const data = rpcError.data as { errors: Array<{ instancePath: string; keyword: string }> };
      const keywords = data.errors.map((x) => x.keyword).sort();
      expect(keywords).toContain("required");
      expect(keywords).toContain("type");
    }
    // invocation 已创建并落 failed 终态（不启动执行）
    const [record] = state.list();
    expect(record?.internalStatus).toBe("failed");
    expect(record?.error?.code).toBe(ERROR_CODES.INPUT_VALIDATION_FAILED);
    expect(record?.error?.errors).toBeTruthy();
    // 事件序列：created → failed（无 execution.started）
    const evts = events.listByInvocation(record!.invocation_id);
    expect(evts.map((e) => e.event)).toEqual([
      EVENT_TYPES.INVOCATION_CREATED,
      EVENT_TYPES.EXECUTION_FAILED,
    ]);
  });
});

describe("状态转换表：行3-行8 逐行", () => {
  it("行4：markRunning resolved → running，落 started_at，发 execution.started", () => {
    const { manager, events } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);

    const running = manager.getExecution(record.invocation_id);
    expect(running.status).toBe("running");
    expect(running.started_at).toBeTruthy();
    expect(events.listByInvocation(record.invocation_id).map((e) => e.event)).toContain(
      EVENT_TYPES.EXECUTION_STARTED,
    );
  });

  it("行5：complete running → completed，落 result + ended_at，发 execution.completed", () => {
    const { manager } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.complete(record.invocation_id, { path: "notes.txt", size: 5 });

    const detail = manager.getExecution(record.invocation_id);
    expect(detail.status).toBe("completed");
    expect(detail.result).toEqual({ path: "notes.txt", size: 5 });
    expect(detail.ended_at).toBeTruthy();
    expect(detail.error).toBeNull();
  });

  it("行6：fail running → failed，落 error，发 execution.failed", () => {
    const { manager, events } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.fail(record.invocation_id, { code: 50001, message: "插件执行错误" });

    const detail = manager.getExecution(record.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error).toEqual({ code: 50001, message: "插件执行错误" });
    const evts = events.listByInvocation(record.invocation_id);
    expect(evts.at(-1)?.event).toBe(EVENT_TYPES.EXECUTION_FAILED);
    expect(evts.at(-1)?.data).toEqual({ code: 50001, message: "插件执行错误" });
  });

  it("行3：cancel resolved 态 → 直接 cancelled（未进插件进程），发 execution.cancelled", () => {
    const { manager, events } = setup();
    const record = createValid(manager);
    manager.cancel(record.invocation_id);

    const detail = manager.getExecution(record.invocation_id);
    expect(detail.status).toBe("cancelled");
    expect(detail.ended_at).toBeTruthy();
    expect(events.listByInvocation(record.invocation_id).at(-1)?.event).toBe(
      EVENT_TYPES.EXECUTION_CANCELLED,
    );
  });

  it("行7：cancel running 态 → 触发 onCancelRequested 钩子（协作取消交由 Runtime）", () => {
    const requested: string[] = [];
    const { manager } = setup({ onCancelRequested: (id) => requested.push(id) });
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.cancel(record.invocation_id);

    // 仍 running（终态由 Runtime 确认）
    expect(requested).toEqual([record.invocation_id]);
    expect(manager.getExecution(record.invocation_id).status).toBe("running");
  });

  it("行7 后半：confirmCancelled running → cancelled（协作成功/强杀后）", () => {
    const { manager } = setup({ onCancelRequested: () => undefined });
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.cancel(record.invocation_id);
    manager.confirmCancelled(record.invocation_id);

    expect(manager.getExecution(record.invocation_id).status).toBe("cancelled");
  });

  it("行7 变体：无 Runtime 钩子时 cancel running → 直接 cancelled（headless 简化）", () => {
    const { manager } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.cancel(record.invocation_id);

    expect(manager.getExecution(record.invocation_id).status).toBe("cancelled");
  });

  it("行8：终态（completed）上 complete/fail/cancel 全部拒绝 40004", () => {
    const { manager } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.complete(record.invocation_id, { ok: true });

    for (const fn of [
      () => manager.complete(record.invocation_id, {}),
      () => manager.fail(record.invocation_id, { code: 50001, message: "x" }),
      () => manager.cancel(record.invocation_id),
    ]) {
      try {
        fn();
        expect.unreachable("应当抛出 RpcError");
      } catch (e) {
        expect((e as RpcError).code).toBe(ERROR_CODES.ILLEGAL_STATE_OPERATION);
      }
    }
  });

  it("非法来源转换：created 未校验直接 markRunning → 40004", () => {
    const { manager, state } = setup();
    // 绕过 createInvocation 构造 created 态记录（模拟竞态/误用）
    const record = createValid(manager);
    state.update(record.invocation_id, { internalStatus: "created" });
    try {
      manager.markRunning(record.invocation_id);
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.ILLEGAL_STATE_OPERATION);
    }
  });
});

describe("timeout_ms 控制（6.2，fake timers）", () => {
  it("running 超过 capability.timeout_ms → failed(40006) + execution.failed", () => {
    const { manager } = setup();
    const record = createValid(manager); // timeout_ms: 1000
    manager.markRunning(record.invocation_id);

    vi.advanceTimersByTime(999);
    expect(manager.getExecution(record.invocation_id).status).toBe("running");
    vi.advanceTimersByTime(1);
    const detail = manager.getExecution(record.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe(ERROR_CODES.EXECUTION_TIMEOUT);
  });

  it("完成先于超时 → 定时器清理，advance 后不误伤", () => {
    const { manager } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.complete(record.invocation_id, { ok: true });

    vi.advanceTimersByTime(5000);
    expect(manager.getExecution(record.invocation_id).status).toBe("completed");
  });

  it("取消后超时定时器同样清理", () => {
    const { manager } = setup();
    const record = createValid(manager);
    manager.markRunning(record.invocation_id);
    manager.cancel(record.invocation_id);

    vi.advanceTimersByTime(5000);
    expect(manager.getExecution(record.invocation_id).status).toBe("cancelled");
  });
});

describe("getExecution（5.3.4）", () => {
  it("invocation 不存在 → 40003", () => {
    const { manager } = setup();
    try {
      manager.getExecution("inv_ghost");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.INVOCATION_NOT_FOUND);
    }
  });

  it("includeEvents / include_logs 开关：默认不含，开启返回", () => {
    const { manager, logs } = setup();
    const record = createValid(manager, "async");
    manager.markRunning(record.invocation_id);
    logs.append(record.invocation_id, "rendering document");
    manager.complete(record.invocation_id, { path: "notes.txt" });

    const minimal = manager.getExecution(record.invocation_id);
    expect(minimal.events).toBeUndefined();
    expect(minimal.logs).toBeUndefined();
    expect(minimal.mode).toBe("async");

    const full = manager.getExecution(record.invocation_id, {
      includeEvents: true,
      includeLogs: true,
    });
    // 事件序列完整：created → started → completed
    expect(full.events?.map((e) => e.event)).toEqual([
      EVENT_TYPES.INVOCATION_CREATED,
      EVENT_TYPES.EXECUTION_STARTED,
      EVENT_TYPES.EXECUTION_COMPLETED,
    ]);
    expect(full.logs).toEqual([{ timestamp: expect.any(String), message: "rendering document" }]);
  });
});
