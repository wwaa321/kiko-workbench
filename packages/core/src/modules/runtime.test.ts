/**
 * ExecutionRuntime 单测（M1-09 验收锚点）
 *
 * 验收锚点（6.3 / 5.3.6）：
 *   - 懒启动：首 invoke 启动进程（load 携带 manifestPath / workspaceRoot /
 *     documentsDir），loaded 后下发 invoke；同插件复用进程
 *   - 崩溃检测：意外退出 → running 批量 failed(50001) + 指数退避重启
 *   - 熔断：连续崩溃 crashLimit 次 → 插件 error → 后续 invoke 40005；
 *     成功执行重置计数；UI 重新启用后恢复
 *   - 空闲回收：idleTimeoutMs 无活动 → shutdown → shutdown-complete / 宽限强杀
 *   - 协作取消：cancel 消息下发 → 宽限内 cancelled / 宽限耗尽强杀 + 批量 failed
 *   - dispose：running 批量 failed + 全部进程杀灭
 *   - waitForSettled（sync invoke 响应组装用，M1-11 接线）
 *
 * 进程经 ProcessLauncher 注入 FakeProcess（零 electron 依赖，与生产
 * utilityProcess 同构：send / kill / onMessage / onExit）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionRuntime, type PluginProcess, type ProcessLauncher } from "./runtime.js";
import { InvocationManager } from "./invocation.js";
import { EventManager, LogManager, StateManager } from "./state.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryEventStore, MemoryLogStore, MemoryStateStore } from "../stores/memory-stores.js";
import type { CapabilityRegistry, PluginRecord } from "./registry.js";
import type { ConfigurationSchema, PluginConfigReader } from "./config-store.js";
import type { HostCommand, HostEvent } from "@kiko-workbench/plugin-sdk";
import {
  ERROR_CODES,
  EVENT_TYPES,
  RpcError,
  type CapabilityDefinition,
} from "@kiko-workbench/protocol";
import type { InvocationRecord } from "../stores/types.js";

// ---------------------------------------------------------------------------
// FakeProcess：与 utilityProcess 同构的假子进程
// ---------------------------------------------------------------------------

/** 假子进程：记录下行命令，测试手动 emit 上行事件 / 退出 */
class FakeProcess implements PluginProcess {
  /** 收到的全部下行命令（load / invoke / cancel / shutdown） */
  readonly sent: HostCommand[] = [];
  private readonly messageListeners = new Set<(event: HostEvent) => void>();
  private readonly exitListeners = new Set<() => void>();
  /** kill() 是否被调用（主动杀灭：intentional） */
  killed = false;
  /** 是否已退出（退出后不再分发消息） */
  exited = false;

  send(command: HostCommand): void {
    this.sent.push(command);
  }

  kill(): void {
    this.killed = true;
    // 真实 utilityProcess kill 后触发 exit 事件（runtime 依赖此收尾）
    this.emitExit();
  }

  onMessage(listener: (event: HostEvent) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** 上行事件（host → main） */
  emit(event: HostEvent): void {
    if (this.exited) return;
    for (const listener of this.messageListeners) listener(event);
  }

  /** 进程退出（主动 kill 与意外崩溃共用；exited 幂等防重复） */
  emitExit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener();
  }

  /** 意外崩溃：不经 kill 的退出（intentionalKill = false → 崩溃路径） */
  crash(): void {
    this.emitExit();
  }
}

// ---------------------------------------------------------------------------
// 测试组装（registry stub + 真实 Invocation/State/Event/Log/Workspace）
// ---------------------------------------------------------------------------

/** 测试能力定义：input 宽松（properties 无 required），路径交由插件处理 */
const CAPABILITY: CapabilityDefinition = {
  id: "file.write",
  name: "Write File",
  description: "Write file to workspace",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
  output_schema: { type: "object" },
  // 超时预算需长于 idleTimeoutMs（60s）：空闲回收用例 advance 60s 时
  // invocation 仍应 running（不被执行超时守卫抢先置 failed）
  timeout_ms: 120_000,
};

/** Registry stub：维护插件状态 Map（resolveCapability / getPlugin / setPluginStatus） */
function makeRegistry(
  pluginIds: string[] = ["file"],
  configSchema?: ConfigurationSchema,
): CapabilityRegistry & {
  getPluginRecord: (id: string) => PluginRecord | undefined;
} {
  const plugins = new Map<string, PluginRecord>(
    pluginIds.map((id) => [
      id,
      {
        id,
        name: id.toUpperCase(),
        description: "",
        version: "1.0.0",
        entry: "index.js",
        permissions: [],
        status: "enabled",
        rootDir: `/plugins/${id}`,
        // P-002：插件声明的配置 schema（PluginRecord.configSchema 注入源）
        ...(configSchema !== undefined ? { configSchema } : {}),
      },
    ]),
  );
  // 能力表：每个插件注册 "<id>.write"（file 插件即 file.write，与 CAPABILITY.id 一致）
  const capabilities = new Map<string, { pluginId: string; definition: CapabilityDefinition }>(
    pluginIds.map((id) => [`${id}.write`, { pluginId: id, definition: CAPABILITY }]),
  );
  return {
    resolveCapability(capabilityId: string) {
      const entry = capabilities.get(capabilityId);
      if (entry === undefined) {
        throw new RpcError(ERROR_CODES.CAPABILITY_NOT_FOUND, `能力不存在：${capabilityId}`);
      }
      const plugin = plugins.get(entry.pluginId);
      if (plugin === undefined || plugin.status === "disabled") {
        throw new RpcError(
          ERROR_CODES.CAPABILITY_NOT_FOUND,
          `能力不可用（插件 ${entry.pluginId} 处于 ${plugin?.status ?? "未知"} 状态）`,
        );
      }
      if (plugin.status === "error") {
        throw new RpcError(
          ERROR_CODES.PLUGIN_UNAVAILABLE,
          `插件 ${entry.pluginId} 处于 error 状态`,
        );
      }
      return { plugin, definition: entry.definition };
    },
    getPlugin: (pluginId: string) => plugins.get(pluginId),
    setPluginStatus(pluginId: string, status: PluginRecord["status"], reason?: string) {
      const plugin = plugins.get(pluginId);
      if (plugin === undefined) {
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
      }
      plugin.status = status;
      if (status === "enabled") delete plugin.errorReason;
      else if (reason !== undefined) plugin.errorReason = reason;
    },
    getPluginRecord: (pluginId: string) => plugins.get(pluginId),
  } as unknown as CapabilityRegistry & {
    getPluginRecord: (id: string) => PluginRecord | undefined;
  };
}

/** 组装被测对象（全部真实 Manager + fake launcher） */
function setup(
  overrides: Partial<ConstructorParameters<typeof ExecutionRuntime>[0]> = {},
  wrapLauncher?: (base: ProcessLauncher) => ProcessLauncher,
  configSchema?: ConfigurationSchema,
) {
  const registry = makeRegistry(["file"], configSchema);
  const state = new StateManager(new MemoryStateStore());
  const events = new EventManager(new MemoryEventStore());
  const logs = new LogManager(new MemoryLogStore());
  const workspace = new WorkspaceManager({ documentsDir: root });

  // 协作取消桥接：InvocationManager 构造期需要钩子，而 runtime 构造期需要
  // invocation——经可变引用容器解环（构造完成后接线）
  const cancelBridge: { hook?: (invocationId: string) => void } = {};
  let seq = 0;
  const invocation = new InvocationManager({
    registry,
    state,
    events,
    logs,
    generateId: () => `t${String(++seq).padStart(11, "0")}`,
    onCancelRequested: (id) => cancelBridge.hook?.(id),
  });

  const procs: FakeProcess[] = [];
  const baseLauncher: ProcessLauncher = () => {
    const proc = new FakeProcess();
    procs.push(proc);
    return proc;
  };
  const launcher = wrapLauncher?.(baseLauncher) ?? baseLauncher;
  const runtime = new ExecutionRuntime({
    registry,
    invocation,
    state,
    events,
    logs,
    workspace,
    launcher,
    userPluginsRoot: "/user-plugins",
    // S8 扩展字段（PluginContext.esbuildBinaryPath 注入源）：单测占位
    esbuildBinaryPath: "/fake/esbuild.exe",
    // 测试时间尺度（真实默认见 runtime.ts 构造函数）
    idleTimeoutMs: 60_000,
    cancelGraceMs: 5_000,
    shutdownGraceMs: 5_000,
    loadTimeoutMs: 10_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    crashLimit: 3,
    ...overrides,
  });
  cancelBridge.hook = (id) => runtime.onCancelRequested(id);

  return { runtime, invocation, registry, state, events, logs, workspace, procs };
}

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 创建一个 resolved 态 invocation（经 createInvocation 校验路径） */
function createRecord(invocation: InvocationManager): InvocationRecord {
  return invocation.createInvocation({
    capabilityId: "file.write",
    input: { path: "notes.txt" },
  });
}

/** execute + 立即 emit loaded：等价于"插件秒加载成功"，返回下发完成的 promise */
function executeReady(
  runtime: ExecutionRuntime,
  record: InvocationRecord,
  procs: FakeProcess[],
): Promise<void> {
  // 注意：先调用 execute（同步段内启动进程并下发 load），再取进程 emit loaded。
  // 参数求值顺序陷阱：不可在调用点先求值 currentProc（此刻进程尚未启动）。
  const executing = runtime.execute(record);
  currentProc(procs).emit({ type: "loaded", capabilities: [record.capability_id] });
  return executing;
}

/** 当前进程（最近启动的假进程） */
function currentProc(procs: FakeProcess[]): FakeProcess {
  const proc = procs.at(-1);
  if (proc === undefined) throw new Error("尚无进程被启动");
  return proc;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

let root: string;

beforeEach(async () => {
  vi.useFakeTimers();
  root = await mkdtemp(join(tmpdir(), "kiko-runtime-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("懒启动与正常执行（6.3）", () => {
  it("首 invoke：启动进程 → load 携带 manifestPath/pluginId/workspaceRoot/documentsDir → loaded 后下发 invoke", async () => {
    const { runtime, invocation, procs, workspace } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    // 进程只启动一次，load 命令字段完整（M1-09 documentsDir / S2 userPluginsRoot 扩展）
    expect(procs).toHaveLength(1);
    expect(procs[0].sent[0]).toEqual({
      type: "load",
      manifestPath: join("/plugins/file", "manifest.json"),
      pluginId: "file",
      workspaceRoot: workspace.workspaceRoot,
      documentsDir: workspace.documentsDir,
      userPluginsRoot: "/user-plugins",
    // S8 扩展字段（PluginContext.esbuildBinaryPath 注入源）：单测占位
    esbuildBinaryPath: "/fake/esbuild.exe",
    // P-002 扩展字段：未装配 pluginConfigs（缺省空实现）→ 注入 {}
    config: {},
    });
    // invoke 下发（input 透传）
    expect(procs[0].sent[1]).toEqual({
      type: "invoke",
      invocationId: record.invocation_id,
      capabilityId: "file.write",
      input: { path: "notes.txt" },
    });
    // 状态：running（execution.started 已发）
    expect(invocation.getExecution(record.invocation_id).status).toBe("running");
  });

  it("P-002：装配 pluginConfigs → load 命令携带 read 结果（pluginId + configSchema 透传）", async () => {
    // 插件声明的配置 schema（经 PluginRecord.configSchema 注入源传递）
    const configSchema: ConfigurationSchema = {
      type: "object",
      properties: {
        api_key: { type: "string", "x-kiko-secret": true },
        retries: { type: "integer", default: 3 },
      },
      required: ["api_key"],
    };
    // 记录调用的 fake 读取器（断言 read 收到完整参数 + 结果落进 load 命令）
    const calls: Array<{ pluginId: string; schema?: ConfigurationSchema }> = [];
    const pluginConfigs: PluginConfigReader = {
      read: (pluginId, schema) => {
        calls.push({ pluginId, schema });
        // 模拟 config-store.read 的合并结果（default 合并 + 已保存值）
        return { api_key: "test-key-saved", retries: 3 };
      },
    };
    const { runtime, invocation, procs } = setup({ pluginConfigs }, undefined, configSchema);
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    // read 以 (pluginId, record.configSchema) 被调用
    expect(calls).toEqual([{ pluginId: "file", schema: configSchema }]);
    // load 命令携带合并后的配置值（零加工透传）
    expect(procs[0].sent[0]).toMatchObject({
      type: "load",
      config: { api_key: "test-key-saved", retries: 3 },
    });
  });

  it("P-002：插件未声明配置（configSchema undefined）→ read 收到 undefined，仍注入 read 返回值", async () => {
    const calls: Array<{ pluginId: string; schema?: ConfigurationSchema }> = [];
    const pluginConfigs: PluginConfigReader = {
      read: (pluginId, schema) => {
        calls.push({ pluginId, schema });
        return {}; // 真实 config-store 对未声明配置返回 {}
      },
    };
    const { runtime, invocation, procs } = setup({ pluginConfigs });
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    expect(calls).toEqual([{ pluginId: "file", schema: undefined }]);
    expect(procs[0].sent[0]).toMatchObject({ type: "load", config: {} });
  });

  it("result 上行 → completed；log / progress 桥接；同插件二次 execute 复用进程", async () => {
    const { runtime, invocation, procs, events, logs } = setup();
    const first = createRecord(invocation);
    await executeReady(runtime, first, procs);
    const proc = currentProc(procs);

    // log / progress 上行桥接
    proc.emit({ type: "log", invocationId: first.invocation_id, message: "writing" });
    proc.emit({
      type: "progress",
      invocationId: first.invocation_id,
      percent: 50,
      message: "half",
    });
    expect(logs.listByInvocation(first.invocation_id)).toHaveLength(1);
    expect(
      events
        .listByInvocation(first.invocation_id)
        .some((e) => e.event === EVENT_TYPES.EXECUTION_PROGRESS),
    ).toBe(true);

    // result → completed
    proc.emit({ type: "result", invocationId: first.invocation_id, result: { ok: true } });
    expect(invocation.getExecution(first.invocation_id).status).toBe("completed");

    // 二次 execute 复用进程（无新启动，无重复 load）
    const second = createRecord(invocation);
    await executeReady(runtime, second, procs);
    expect(procs).toHaveLength(1);
    expect(proc.sent.filter((c) => c.type === "load")).toHaveLength(1);
    expect(proc.sent.at(-1)?.type).toBe("invoke");
  });

  it("artifact 上报（工作空间内）→ 越界复查通过后登记到记录", async () => {
    const { runtime, invocation, procs, workspace, state } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    const file = join(workspace.workspaceRoot, "file", "out.txt");
    currentProc(procs).emit({
      type: "artifact",
      invocationId: record.invocation_id,
      file,
      relativePath: "file/out.txt",
      filename: "out.txt",
      mimeType: "text/plain",
      size: 3,
    });
    expect(state.get(record.invocation_id)?.artifacts).toEqual([
      {
        file,
        relative_path: "file/out.txt",
        filename: "out.txt",
        mime_type: "text/plain",
        size: 3,
      },
    ]);
  });

  it("artifact 上报越界（host 侧伪造）→ 50001 归因该 invocation 执行失败", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    currentProc(procs).emit({
      type: "artifact",
      invocationId: record.invocation_id,
      file: "/etc/passwd",
      relativePath: "../passwd",
      filename: "passwd",
      mimeType: "text/plain",
      size: 1,
    });
    const detail = invocation.getExecution(record.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe(ERROR_CODES.PLUGIN_EXECUTION_ERROR);
  });
});

describe("加载失败路径（执行未开始 → failFromResolved）", () => {
  it("load-error → invocation failed(40005) + 插件 error + 进程杀灭不重试", async () => {
    const { runtime, invocation, procs, registry } = setup();
    const record = createRecord(invocation);
    const executing = runtime.execute(record);
    currentProc(procs).emit({ type: "load-error", message: "entry 加载失败" });
    await executing;

    // 执行未开始：resolved → failed(40005)
    const detail = invocation.getExecution(record.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe(ERROR_CODES.PLUGIN_UNAVAILABLE);
    // 插件置 error（确定性失败不重试）
    expect(registry.getPlugin("file")?.status).toBe("error");
    expect(currentProc(procs).killed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(procs).toHaveLength(1);
  });

  it("加载超时 → failed(40005) + 杀进程按崩溃计（退避后重启）", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    const executing = runtime.execute(record);
    // 不 emit loaded → loadTimer 到期
    await vi.advanceTimersByTimeAsync(10_000);
    await executing;

    const detail = invocation.getExecution(record.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe(ERROR_CODES.PLUGIN_UNAVAILABLE);
    // 超时杀进程 → exit 崩溃路径 → 退避 1s 后重启
    expect(currentProc(procs).killed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(procs).toHaveLength(2);
  });
});

describe("崩溃检测与退避重启（6.3）", () => {
  it("执行中崩溃 → running 批量 failed(50001) + 退避 1s 后自动重启", async () => {
    const { runtime, invocation, procs } = setup();
    const a = createRecord(invocation);
    const b = createRecord(invocation);
    await executeReady(runtime, a, procs);
    await executeReady(runtime, b, procs);

    // 意外崩溃：两个 running 全部批量 failed(50001)
    currentProc(procs).crash();
    for (const record of [a, b]) {
      const detail = invocation.getExecution(record.invocation_id);
      expect(detail.status).toBe("failed");
      expect(detail.error?.code).toBe(ERROR_CODES.PLUGIN_EXECUTION_ERROR);
    }

    // 退避 1s（backoffBaseMs）→ 自动重启新进程
    await vi.advanceTimersByTimeAsync(1_000);
    expect(procs).toHaveLength(2);
    expect(currentProc(procs).sent[0]?.type).toBe("load");
  });

  it("退避期内新 execute 顺延：重启加载完成后才下发 invoke", async () => {
    const { runtime, invocation, procs } = setup();
    const first = createRecord(invocation);
    await executeReady(runtime, first, procs);
    currentProc(procs).crash();

    // 退避期内发起第二个 execute（挂起等待重启）
    const second = createRecord(invocation);
    const executing = runtime.execute(second);
    await vi.advanceTimersByTimeAsync(1_000); // 退避到期 → 新进程启动 + load
    currentProc(procs).emit({ type: "loaded", capabilities: ["file.write"] });
    await executing;

    expect(procs).toHaveLength(2);
    expect(currentProc(procs).sent).toEqual([
      {
        type: "load",
        manifestPath: expect.any(String),
        pluginId: "file",
        workspaceRoot: expect.any(String),
        documentsDir: expect.any(String),
        userPluginsRoot: "/user-plugins",
    // S8 扩展字段（PluginContext.esbuildBinaryPath 注入源）：单测占位
    esbuildBinaryPath: "/fake/esbuild.exe",
    // P-002 扩展字段：缺省空实现注入 {}
    config: {},
      },
      {
        type: "invoke",
        invocationId: second.invocation_id,
        capabilityId: "file.write",
        input: { path: "notes.txt" },
      },
    ]);
  });

  it("指数退避：第 1 次崩溃 1s、第 2 次崩溃 2s", async () => {
    const { runtime, invocation, procs } = setup();
    // 崩溃 #1（crashCount=1 → 退避 1s）
    const first = createRecord(invocation);
    await executeReady(runtime, first, procs);
    currentProc(procs).crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(procs).toHaveLength(2);

    // 重启加载完成后崩溃 #2（crashCount=2 → 退避 2s）
    currentProc(procs).emit({ type: "loaded", capabilities: [] });
    const second = createRecord(invocation);
    await executeReady(runtime, second, procs);
    currentProc(procs).crash();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(procs).toHaveLength(2); // 2s 未到不重启
    await vi.advanceTimersByTimeAsync(1);
    expect(procs).toHaveLength(3);
  });

  it("退避重启 fork 同步抛错 → 不击穿 timer 回调；后续 execute 经 startProcess 正常上报 50000", async () => {
    // 第二次起 launcher 同步抛错（模拟 fork 失败：宿主资源不足等）
    const { runtime, invocation, procs } = setup({}, (base) => {
      let calls = 0;
      return (options) => {
        calls += 1;
        if (calls >= 2) throw new Error("fork failed");
        return base(options);
      };
    });
    const first = createRecord(invocation);
    await executeReady(runtime, first, procs);
    currentProc(procs).crash(); // crashCount=1 → 退避 1s

    // 退避到期重启：fork 抛错被吞（不逃进 setTimeout 回调击穿主进程）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(procs).toHaveLength(1);

    // 后续 execute：startProcess 再次抛错 → execute catch → failFromResolved(50000)
    const second = createRecord(invocation);
    await runtime.execute(second);
    const detail = invocation.getExecution(second.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });
});

describe("熔断（crashLimit=3）", () => {
  it("连续 3 次崩溃 → 插件 error（熔断）+ 不再重启 + 后续 invoke 40005", async () => {
    const { runtime, invocation, procs, registry } = setup();

    // 崩溃 → 退避重启 → 加载 → 崩溃 …… 连续 3 次
    for (let i = 0; i < 3; i += 1) {
      const record = createRecord(invocation);
      await executeReady(runtime, record, procs);
      currentProc(procs).crash();
      await vi.advanceTimersByTimeAsync(1_000 * 2 ** i); // 1s → 2s → 4s
    }
    expect(procs).toHaveLength(3); // 第 3 次崩溃后熔断，不再重启

    const plugin = registry.getPlugin("file");
    expect(plugin?.status).toBe("error");
    expect(plugin?.errorReason).toContain("熔断");

    // 后续 invoke：createInvocation 阶段即 40005（插件 error 态）
    try {
      createRecord(invocation);
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.PLUGIN_UNAVAILABLE);
    }
    // 长时间不恢复（无重启循环）
    await vi.advanceTimersByTimeAsync(120_000);
    expect(procs).toHaveLength(3);
  });

  it("成功执行重置计数：崩溃 → 重启成功执行 → 再崩溃 3 次才熔断", async () => {
    const { runtime, invocation, procs } = setup();

    // 崩溃 #1（计数 1）
    const first = createRecord(invocation);
    await executeReady(runtime, first, procs);
    currentProc(procs).crash();
    await vi.advanceTimersByTimeAsync(1_000);
    // 重启后成功执行一次（计数清零）
    const second = createRecord(invocation);
    await executeReady(runtime, second, procs);
    currentProc(procs).emit({ type: "result", invocationId: second.invocation_id, result: {} });

    // 此后连续崩溃 3 次（计数 1 → 2 → 3 熔断）
    for (let i = 0; i < 3; i += 1) {
      const record = createRecord(invocation);
      await executeReady(runtime, record, procs);
      currentProc(procs).crash();
      await vi.advanceTimersByTimeAsync(1_000 * 2 ** i);
    }
    // 进程数：首轮 1 + 崩溃#1 重启 1 + 三连崩中前两次崩溃各重启 1
    // （第三次崩溃熔断不再重启）= 4。若无成功重置，首轮后仅需两次崩溃即熔断
    //（进程数 3），此处多一次证明计数确被成功执行清零
    expect(procs).toHaveLength(4);
  });

  it("熔断后 UI 重新启用（setPluginStatus + resetPlugin）→ 恢复执行", async () => {
    const { runtime, invocation, procs, registry } = setup();

    // 三连崩溃 → 熔断
    for (let i = 0; i < 3; i += 1) {
      const record = createRecord(invocation);
      await executeReady(runtime, record, procs);
      currentProc(procs).crash();
      await vi.advanceTimersByTimeAsync(1_000 * 2 ** i);
    }
    expect(registry.getPlugin("file")?.status).toBe("error");

    // UI 侧重新启用（清 errorReason + 崩溃计数）
    registry.setPluginStatus("file", "enabled");
    runtime.resetPlugin("file");

    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);
    expect(procs).toHaveLength(4);
    expect(invocation.getExecution(record.invocation_id).status).toBe("running");
  });
});

describe("空闲回收（6.3：idleTimeoutMs 无活动）", () => {
  it("空闲到期 → shutdown 下发 → shutdown-complete → 主动杀灭（不计崩溃不重启）", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);
    currentProc(procs).emit({ type: "result", invocationId: record.invocation_id, result: {} });

    // 空闲 60s → shutdown 下发
    await vi.advanceTimersByTimeAsync(60_000);
    const proc = currentProc(procs);
    expect(proc.sent.at(-1)?.type).toBe("shutdown");

    // 优雅完成 → 主动杀灭；后续无重启
    proc.emit({ type: "shutdown-complete" });
    expect(proc.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(procs).toHaveLength(1);

    // 再次 execute → 重新懒启动新进程
    const next = createRecord(invocation);
    await executeReady(runtime, next, procs);
    expect(procs).toHaveLength(2);
  });

  it("shutdown-complete 超时 → shutdownGraceMs 后强杀兜底", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);
    currentProc(procs).emit({ type: "result", invocationId: record.invocation_id, result: {} });

    await vi.advanceTimersByTimeAsync(60_000); // 空闲到期 → shutdown
    await vi.advanceTimersByTimeAsync(5_000); // 宽限耗尽 → 强杀（不发 shutdown-complete）
    const proc = currentProc(procs);
    expect(proc.killed).toBe(true);
    // 主动杀灭不计崩溃：无退避重启
    await vi.advanceTimersByTimeAsync(60_000);
    expect(procs).toHaveLength(1);
  });

  it("运行中不回收：running 态空闲计时到期 → 顺延（无 shutdown 下发）", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(currentProc(procs).sent.some((c) => c.type === "shutdown")).toBe(false);
    expect(invocation.getExecution(record.invocation_id).status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// ui-send 路由与 UI 租约（P-003 v1）
// ---------------------------------------------------------------------------

describe("ui-send 路由与 UI 租约（P-003 v1）", () => {
  /** 组装 + 预热：启动进程并完成一个 invocation（清空 running，解锁 idle 回收路径） */
  async function setupWarm(overrides: Partial<ConstructorParameters<typeof ExecutionRuntime>[0]> = {}) {
    const ctx = setup(overrides);
    const record = createRecord(ctx.invocation);
    await executeReady(ctx.runtime, record, ctx.procs);
    ctx.procs
      .at(-1)!
      .emit({ type: "result", invocationId: record.invocation_id, result: {} });
    return ctx;
  }

  it("ui-send 上行 → uiRelay 投递成功 → 回执 ok: true（pluginId/payload 透传）", async () => {
    const relayCalls: Array<{ pluginId: string; payload: unknown }> = [];
    const { runtime, procs } = await setupWarm({
      uiRelay: {
        send: (pluginId, payload) => {
          relayCalls.push({ pluginId, payload });
          return Promise.resolve();
        },
      },
    });
    void runtime;
    const proc = currentProc(procs);

    proc.emit({ type: "ui-send", requestId: 1, payload: { hello: "ui" } });
    await vi.waitFor(() => {
      expect(proc.sent.some((c) => c.type === "ui-send-result")).toBe(true);
    });

    expect(relayCalls).toEqual([{ pluginId: "file", payload: { hello: "ui" } }]);
    expect(proc.sent.at(-1)).toEqual({ type: "ui-send-result", requestId: 1, ok: true });
  });

  it("uiRelay reject RpcError(40010) → 回执 ok: false + 错误码透传（界面未打开）", async () => {
    const { procs } = await setupWarm({
      uiRelay: {
        send: () => Promise.reject(new RpcError(ERROR_CODES.PLUGIN_UI_NOT_OPEN, "插件界面未打开")),
      },
    });
    const proc = currentProc(procs);

    proc.emit({ type: "ui-send", requestId: 2, payload: { ping: 1 } });
    await vi.waitFor(() => {
      expect(proc.sent.some((c) => c.type === "ui-send-result")).toBe(true);
    });

    expect(proc.sent.at(-1)).toEqual({
      type: "ui-send-result",
      requestId: 2,
      ok: false,
      error: { code: ERROR_CODES.PLUGIN_UI_NOT_OPEN, message: "插件界面未打开" },
    });
  });

  it("uiRelay 抛普通异常 → 回执 INTERNAL_ERROR（宿主异常不裸透传）", async () => {
    const { procs } = await setupWarm({
      uiRelay: { send: () => Promise.reject(new Error("relay exploded")) },
    });
    const proc = currentProc(procs);

    proc.emit({ type: "ui-send", requestId: 3, payload: null });
    await vi.waitFor(() => {
      expect(proc.sent.some((c) => c.type === "ui-send-result")).toBe(true);
    });

    expect(proc.sent.at(-1)).toEqual({
      type: "ui-send-result",
      requestId: 3,
      ok: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: expect.stringContaining("relay exploded") },
    });
  });

  it("未注入 uiRelay（headless 默认 stub）→ 回执 40010", async () => {
    const { procs } = await setupWarm(); // 不注入 uiRelay
    const proc = currentProc(procs);

    proc.emit({ type: "ui-send", requestId: 1, payload: {} });
    await vi.waitFor(() => {
      expect(proc.sent.some((c) => c.type === "ui-send-result")).toBe(true);
    });

    expect(proc.sent.at(-1)).toEqual({
      type: "ui-send-result",
      requestId: 1,
      ok: false,
      error: { code: ERROR_CODES.PLUGIN_UI_NOT_OPEN, message: "插件界面未打开" },
    });
  });

  it("UI 租约：持有租约 idle 到期不回收；释放后下一周期正常回收", async () => {
    const { runtime, procs } = await setupWarm();
    const proc = currentProc(procs);

    // 窗口打开（shell 调 acquireUiLease）→ idle 到期顺延，进程保活
    runtime.acquireUiLease("file");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(proc.sent.some((c) => c.type === "shutdown")).toBe(false);
    expect(proc.killed).toBe(false);

    // 窗口关闭（releaseUiLease）→ 下一空闲周期正常回收
    runtime.releaseUiLease("file");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.sent.some((c) => c.type === "shutdown")).toBe(true);
  });

  it("租约幂等：重复 acquire / 重复 release 不影响语义", async () => {
    const { runtime, procs } = await setupWarm();
    const proc = currentProc(procs);

    runtime.acquireUiLease("file");
    runtime.acquireUiLease("file");
    runtime.releaseUiLease("file");
    runtime.releaseUiLease("file"); // 双 release 后无租约

    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.sent.some((c) => c.type === "shutdown")).toBe(true);
  });

  it("投递期间进程被终止 → 不回执（陈旧守卫，host 侧超时兜底）", async () => {
    // relay 返回手动 settle 的 pending promise：先发 ui-send，再终止进程，最后 resolve
    let settleRelay!: () => void;
    const { runtime, procs } = await setupWarm({
      uiRelay: {
        send: () =>
          new Promise<void>((resolve) => {
            settleRelay = resolve;
          }),
      },
    });
    const proc = currentProc(procs);

    proc.emit({ type: "ui-send", requestId: 1, payload: {} });
    runtime.disposePlugin("file"); // 投递在途时插件被卸载（进程终止）
    settleRelay();
    await Promise.resolve(); // flush microtask：then 回调执行但陈旧守卫拦截

    expect(proc.sent.some((c) => c.type === "ui-send-result")).toBe(false);
  });
});

describe("协作取消（5.3.6：先协作后强杀）", () => {
  it("宽限内插件上报 cancelled → 目标 cancelled，进程存活", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);
    const proc = currentProc(procs);

    invocation.cancel(record.invocation_id); // → onCancelRequested → cancel 消息
    expect(proc.sent.at(-1)).toEqual({ type: "cancel", invocationId: record.invocation_id });
    expect(invocation.getExecution(record.invocation_id).status).toBe("running"); // 终态由 Runtime 确认

    proc.emit({ type: "cancelled", invocationId: record.invocation_id });
    expect(invocation.getExecution(record.invocation_id).status).toBe("cancelled");
    expect(proc.killed).toBe(false); // 协作成功不强杀
  });

  it("宽限耗尽未响应 → 目标 cancelled + 强杀进程 + 同插件其余 running 批量 failed", async () => {
    const { runtime, invocation, procs } = setup();
    const a = createRecord(invocation);
    const b = createRecord(invocation);
    await executeReady(runtime, a, procs);
    await executeReady(runtime, b, procs);
    const proc = currentProc(procs);

    invocation.cancel(a.invocation_id); // 只取消 a
    await vi.advanceTimersByTimeAsync(5_000); // cancelGraceMs 耗尽

    expect(invocation.getExecution(a.invocation_id).status).toBe("cancelled");
    // 强杀进程：同插件其余 running 批量 failed(50001)
    expect(invocation.getExecution(b.invocation_id).status).toBe("failed");
    expect(invocation.getExecution(b.invocation_id).error?.code).toBe(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(proc.killed).toBe(true);
    // 主动强杀不计崩溃：无退避重启
    await vi.advanceTimersByTimeAsync(60_000);
    expect(procs).toHaveLength(1);
  });

  it("崩溃与取消竞态：cancel 后进程先崩溃 → 崩溃胜出（failed 50001），陈旧守卫不误杀重启新进程", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);
    const proc = currentProc(procs);

    invocation.cancel(record.invocation_id);
    proc.crash(); // 守卫存续期间进程崩溃：running 批处理先置 failed（崩溃如实上报）
    expect(invocation.getExecution(record.invocation_id).status).toBe("failed");
    expect(invocation.getExecution(record.invocation_id).error?.code).toBe(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );

    // 守卫已在 exit 清理：到期不误杀（且退避重启的新进程存活）
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(procs).toHaveLength(2);
    expect(currentProc(procs).killed).toBe(false);
    expect(currentProc(procs).sent[0]?.type).toBe("load");
  });

  it("强杀后 exit 异步送达（真实 utilityProcess 语义）：恢复 invoke 走新进程，旧 exit 迟到被忽略", async () => {
    // FakeProcess.kill 同步 emitExit，掩盖了真实 utilityProcess "kill 后 exit
    // 异步送达"的窗口——本用例将 kill 改为延迟 50ms 退出，锁定冒烟脚本暴露的
    // 竞态：窗口期内恢复 invoke 不得经 ensureReady 快速路径发给已死进程，
    // 也不得被旧 exit 批处理误判为崩溃 50001 / 计入崩溃计数
    const { runtime, invocation, procs } = setup({ cancelGraceMs: 100 }, (base) => (options) => {
      const proc = base(options);
      proc.kill = () => {
        setTimeout(() => proc.emitExit(), 50); // exit 异步送达（真实语义）
      };
      return proc;
    });
    const stubborn = createRecord(invocation);
    await executeReady(runtime, stubborn, procs);

    // 不协作（FakeProcess 对 cancel 不回 cancelled）→ 宽限 100ms 耗尽强杀
    invocation.cancel(stubborn.invocation_id);
    await vi.advanceTimersByTimeAsync(100); // terminateProcess 已同步收尾；exit（T+150）未达
    expect(invocation.getExecution(stubborn.invocation_id).status).toBe("cancelled");

    // exit 未送达窗口内恢复 invoke：句柄已同步失效 → 懒启动新进程执行
    const recovery = createRecord(invocation);
    await executeReady(runtime, recovery, procs);
    expect(procs).toHaveLength(2);
    expect(procs[1].sent.some((c) => c.type === "invoke")).toBe(true);
    procs[1].emit({ type: "result", invocationId: recovery.invocation_id, result: {} });
    expect(invocation.getExecution(recovery.invocation_id).status).toBe("completed");

    // 旧进程 exit 迟到送达（T+150）：陈旧守卫忽略——不批处理 / 不计崩溃 /
    // 不触发退避重启（新进程存活，无第三个进程被拉起）
    await vi.advanceTimersByTimeAsync(50);
    expect(invocation.getExecution(recovery.invocation_id).status).toBe("completed");
    expect(procs[1].exited).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(procs).toHaveLength(2);
  });
});

describe("dispose（进程回收前清理）", () => {
  it("dispose → running 批量 failed(50001) + 全部进程杀灭 + 拒绝新启动", async () => {
    const registry = makeRegistry(["file", "doc"]);
    const state = new StateManager(new MemoryStateStore());
    const events = new EventManager(new MemoryEventStore());
    const logs = new LogManager(new MemoryLogStore());
    const workspace = new WorkspaceManager({ documentsDir: root });
    let seq = 0;
    const invocation = new InvocationManager({
      registry,
      state,
      events,
      logs,
      generateId: () => `t${String(++seq).padStart(11, "0")}`,
      onCancelRequested: () => undefined,
    });
    const procs: FakeProcess[] = [];
    const runtime = new ExecutionRuntime({
      registry,
      invocation,
      state,
      events,
      logs,
      workspace,
      launcher: () => {
        const proc = new FakeProcess();
        procs.push(proc);
        return proc;
      },
      backoffBaseMs: 1_000,
    });

    // file 插件：一个 running invocation；doc 插件：另一个（双插件验证全量清理）
    // （execute 挂起于加载等待，须先启动再 emit loaded，最后 await 收尾）
    const fileRecord = invocation.createInvocation({
      capabilityId: "file.write",
      input: { path: "a.txt" },
    });
    const execFile = runtime.execute(fileRecord);
    procs[0].emit({ type: "loaded", capabilities: [] });
    await execFile;
    const docRecord = invocation.createInvocation({
      capabilityId: "doc.write",
      input: { path: "b.txt" },
    });
    const execDoc = runtime.execute(docRecord);
    procs[1].emit({ type: "loaded", capabilities: [] });
    await execDoc;

    runtime.dispose();
    for (const record of [fileRecord, docRecord]) {
      const detail = invocation.getExecution(record.invocation_id);
      expect(detail.status).toBe("failed");
      expect(detail.error?.code).toBe(ERROR_CODES.PLUGIN_EXECUTION_ERROR);
    }
    expect(procs.every((p) => p.killed)).toBe(true);

    // 关闭后新 execute → 40005（failFromResolved，执行未开始）
    const late = invocation.createInvocation({
      capabilityId: "file.write",
      input: { path: "c.txt" },
    });
    await runtime.execute(late);
    const detail = invocation.getExecution(late.invocation_id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe(ERROR_CODES.PLUGIN_UNAVAILABLE);
  });
});

describe("waitForSettled（sync invoke 响应组装，M1-11 接线）", () => {
  it("未知 invocation → 40003", () => {
    const { runtime } = setup();
    try {
      runtime.waitForSettled("inv_ghost");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.INVOCATION_NOT_FOUND);
    }
  });

  it("已终态立即返回；运行中挂起至 result 终态唤醒", async () => {
    const { runtime, invocation, procs } = setup();
    const record = createRecord(invocation);
    await executeReady(runtime, record, procs);

    const settled = runtime.waitForSettled(record.invocation_id);
    // 未终态：挂起（advance 大量时间也不 resolve——超时守卫 30s 会置 failed，
    // 但此处验证 result 路径，先于超时 emit）
    let resolved = false;
    void settled.then(() => {
      resolved = true;
    });
    currentProc(procs).emit({ type: "result", invocationId: record.invocation_id, result: {} });
    await vi.advanceTimersByTimeAsync(0); // flush 微任务
    expect(resolved).toBe(true);
    expect(invocation.getExecution(record.invocation_id).status).toBe("completed");

    // 已终态：立即返回
    await expect(runtime.waitForSettled(record.invocation_id)).resolves.toBeUndefined();
  });
});
