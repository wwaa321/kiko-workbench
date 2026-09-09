/**
 * InvocationManager + 状态机（设计文档 6.2）
 *
 * 状态转换表（逐行实现，单测逐行锁定）：
 * | 当前状态          | 触发                  | 目标状态    | 动作                              |
 * |-------------------|-----------------------|-------------|-----------------------------------|
 * | created           | ajv 校验通过          | resolved    | —（内部瞬时经过 validated）        |
 * | created           | 校验失败（40002）     | failed      | 发 execution.failed，不启动执行    |
 * | created/resolved  | cancel 请求           | cancelled   | 未进插件进程，直接终态             |
 * | resolved          | 插件进程开始执行       | running     | 发 execution.started              |
 * | running           | 执行成功              | completed   | 发 execution.completed，落 result |
 * | running           | 异常/超时/插件崩溃     | failed      | 发 execution.failed，落 error     |
 * | running           | cancel（协作/强杀）    | cancelled   | 发 execution.cancelled            |
 * | 终态              | 任何                  | —           | 拒绝，返回 40004                  |
 *
 * 外部状态映射：created/validated/resolved → pending（见 stores/types.ts）。
 *
 * 超时控制（6.2 末行）：markRunning 时按 capability.timeout_ms（默认 30000）
 * 启动定时器，超时 → failed（40006）；终态清理定时器。sync 与 async 一致。
 */
// NodeNext 下 ajv（CJS）默认导入的类型解析有坑（TS2709），命名导入双端安全
import { Ajv } from "ajv";
import { nanoid } from "nanoid";
import {
  ERROR_CODES,
  EVENT_TYPES,
  RpcError,
  type ArtifactInfo,
  type ExecutionDetail,
  type InvokeMode,
  type ResultError,
} from "@kiko-workbench/protocol";
import type { CapabilityRegistry } from "./registry.js";
import type { EventManager, LogManager, StateManager } from "./state.js";
import { isTerminal, toExternalStatus, type InvocationRecord } from "../stores/types.js";

/** 构造依赖（全部注入，保持纯 Node 可单测） */
export interface InvocationManagerDeps {
  registry: CapabilityRegistry;
  state: StateManager;
  events: EventManager;
  logs: LogManager;
  /**
   * running 态收到 cancel 时的通知钩子：ExecutionRuntime 挂接进程级
   * 协作取消 + 宽限强杀（M1-09）。未挂接时直接终态（headless 简化）。
   */
  onCancelRequested?: (invocationId: string) => void;
  /** 测试注入固定 id 序列（默认 nanoid(12)） */
  generateId?: () => string;
}

/** 默认执行超时（设计文档 6.2：timeout_ms 缺省 30000） */
export const DEFAULT_TIMEOUT_MS = 30000;

export class InvocationManager {
  /** ajv 校验函数缓存（capability id → validate fn，避免重复 compile） */
  private readonly validators = new Map<string, ReturnType<Ajv["compile"]>>();
  /** 运行中 invocation 的超时定时器 */
  private readonly timeoutGuards = new Map<string, ReturnType<typeof setTimeout>>();
  /** 各 invocation 的超时预算（创建时从 capability 定义读取） */
  private readonly timeoutBudgets = new Map<string, number>();

  constructor(private readonly deps: InvocationManagerDeps) {}

  // ---------------- invoke 入口（5.3.3） ----------------

  /**
   * 创建并校验一个 invocation：resolve → created → ajv 校验 → resolved。
   * 返回 resolved 态记录（交由 ExecutionRuntime 执行，M1-09）。
   *
   * 错误路径：
   *   - 能力不存在 / 插件不可用 → RpcError(40001/40005)，不产生 invocation
   *   - 校验失败 → invocation 落 failed 态（行2）+ 发事件，同时抛
   *     RpcError(40002, data=ajv errors) 供传输层回错误响应
   */
  createInvocation(params: {
    capabilityId: string;
    input: Record<string, unknown>;
    mode?: InvokeMode;
  }): InvocationRecord {
    // resolve 先行：input_schema 来自 capability 定义，无定义则无从校验
    const { definition } = this.deps.registry.resolveCapability(params.capabilityId);

    const invocationId = `inv_${this.deps.generateId?.() ?? nanoid(12)}`;
    this.deps.state.create({
      invocation_id: invocationId,
      capability_id: params.capabilityId,
      internalStatus: "created",
      mode: params.mode ?? "sync",
      input: params.input,
      created_at: new Date().toISOString(),
      artifacts: [],
    });
    this.deps.events.emit(EVENT_TYPES.INVOCATION_CREATED, invocationId, {
      capability_id: params.capabilityId,
      mode: params.mode ?? "sync",
    });
    // 记录超时预算（markRunning 时启用定时器）
    this.timeoutBudgets.set(invocationId, definition.timeout_ms ?? DEFAULT_TIMEOUT_MS);

    // ajv 校验（行1 / 行2 分叉）
    const validate = this.getValidator(definition.id, definition.input_schema);
    if (!validate(params.input)) {
      // 行2：校验失败 → failed 终态（不启动执行），error 携带 ajv 明细
      const error: ResultError = {
        code: ERROR_CODES.INPUT_VALIDATION_FAILED,
        message: "输入校验失败",
        errors: validate.errors ?? [],
      };
      this.transitionToFailed(invocationId, "created", error);
      // 传输层响应路径：抛 40002（data.errors 携带 ajv 明细，见 5.5）
      throw new RpcError(ERROR_CODES.INPUT_VALIDATION_FAILED, "输入校验失败", {
        errors: validate.errors ?? [],
      });
    }

    // 行1：校验通过 → resolved（内部链 created → validated → resolved，瞬时经过）
    this.deps.state.update(invocationId, { internalStatus: "validated" });
    this.deps.state.update(invocationId, { internalStatus: "resolved" });
    const record = this.deps.state.get(invocationId);
    if (record === undefined) throw new RpcError(ERROR_CODES.INTERNAL_ERROR, "invocation 丢失");
    return record;
  }

  /** 取（或编译缓存）ajv 校验函数 */
  private getValidator(capabilityId: string, schema: object): ReturnType<Ajv["compile"]> {
    let validate = this.validators.get(capabilityId);
    if (validate === undefined) {
      // allErrors：收集全部错误供 40002 明细（而非首个即停）
      validate = new Ajv({ allErrors: true }).compile(schema);
      this.validators.set(capabilityId, validate);
    }
    return validate;
  }

  // ---------------- 状态转换（供 ExecutionRuntime 调用，M1-09） ----------------

  /** 行4：resolved → running；发 execution.started；启动超时守卫 */
  markRunning(invocationId: string): void {
    this.transition(invocationId, ["resolved"], "running");
    this.deps.state.update(invocationId, { started_at: new Date().toISOString() });
    this.deps.events.emit(EVENT_TYPES.EXECUTION_STARTED, invocationId, {});
    this.startTimeoutGuard(invocationId);
  }

  /** 行5：running → completed；落 result；发 execution.completed */
  complete(invocationId: string, result: unknown): void {
    this.transition(invocationId, ["running"], "completed");
    this.clearTimeoutGuard(invocationId);
    this.deps.state.update(invocationId, {
      result,
      ended_at: new Date().toISOString(),
    });
    this.deps.events.emit(EVENT_TYPES.EXECUTION_COMPLETED, invocationId, {});
  }

  /** 行6：running → failed；落 error；发 execution.failed（异常/超时/插件崩溃） */
  fail(invocationId: string, error: ResultError): void {
    this.transitionToFailed(invocationId, "running", error);
  }

  /**
   * 行6 扩展（M1-09）：resolved → failed。
   * "执行未开始"的失败路径（插件加载失败 / 熔断 / 加载超时）——
   * 6.2 状态表未覆盖此转换（偏差表 2026-08-20），动作同行6：
   * 落 error + 发 execution.failed，防 resolved 态僵尸记录。
   */
  failFromResolved(invocationId: string, error: ResultError): void {
    this.transitionToFailed(invocationId, "resolved", error);
  }

  /**
   * 产物登记（M1-09 ExecutionRuntime 接线）：host artifact 消息经
   * WorkspaceManager.validateArtifactPath 越界复查后挂到记录。
   * 终态后静默忽略（竞态防御：产物消息晚于 result 到达）。
   */
  attachArtifact(invocationId: string, artifact: ArtifactInfo): void {
    const record = this.requireRecord(invocationId);
    if (isTerminal(record.internalStatus)) return;
    this.deps.state.update(invocationId, {
      artifacts: [...record.artifacts, artifact],
    });
  }

  /** failed 落盘公共路径：写 error + ended_at，发 execution.failed（含 code/message） */
  private transitionToFailed(
    invocationId: string,
    expectedFrom: InvocationRecord["internalStatus"],
    error: ResultError,
  ): void {
    // 防御：仅允许合法来源（created=校验失败路径 / running=执行失败路径）
    this.transition(invocationId, [expectedFrom], "failed");
    this.clearTimeoutGuard(invocationId);
    this.deps.state.update(invocationId, {
      error,
      ended_at: new Date().toISOString(),
    });
    this.deps.events.emit(EVENT_TYPES.EXECUTION_FAILED, invocationId, {
      code: error.code,
      message: error.message,
    });
  }

  /**
   * cancel（行3 / 行7 / 行8）：
   *   - 终态 → 40004（行8）
   *   - created/validated/resolved → 直接 cancelled（行3：未进插件进程）
   *   - running → 通知 onCancelRequested（协作取消，M1-09 接管宽限强杀）；
   *     无钩子时（headless / 测试）直接终态
   */
  cancel(invocationId: string): void {
    const record = this.requireRecord(invocationId);
    if (isTerminal(record.internalStatus)) {
      throw new RpcError(
        ERROR_CODES.ILLEGAL_STATE_OPERATION,
        `invocation 已处于终态 ${record.internalStatus}，无法取消`,
      );
    }
    if (record.internalStatus === "running" && this.deps.onCancelRequested !== undefined) {
      // 行7 前半：协作取消——进程级操作交由 Runtime，终态由其确认
      this.deps.onCancelRequested(invocationId);
      return;
    }
    this.confirmCancelled(invocationId);
  }

  /** 行7 后半：running → cancelled（协作成功或强杀后由 Runtime 调用） */
  confirmCancelled(invocationId: string): void {
    this.transition(invocationId, ["running", "created", "validated", "resolved"], "cancelled");
    this.clearTimeoutGuard(invocationId);
    this.deps.state.update(invocationId, { ended_at: new Date().toISOString() });
    this.deps.events.emit(EVENT_TYPES.EXECUTION_CANCELLED, invocationId, {});
  }

  // ---------------- 超时守卫（6.2：timeout_ms 控制） ----------------

  /** markRunning 时启动：超时 → fail(40006) */
  private startTimeoutGuard(invocationId: string): void {
    const budget = this.timeoutBudgets.get(invocationId) ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.timeoutGuards.delete(invocationId);
      // 行6 变体：执行超时 → failed（40006）；仍处 running 才生效
      const record = this.deps.state.get(invocationId);
      if (record?.internalStatus === "running") {
        this.fail(invocationId, {
          code: ERROR_CODES.EXECUTION_TIMEOUT,
          message: `执行超时（${budget}ms）`,
        });
      }
    }, budget);
    this.timeoutGuards.set(invocationId, timer);
  }

  /** 终态清理超时定时器与预算记录（防泄漏 + 防已终态再触发） */
  private clearTimeoutGuard(invocationId: string): void {
    const timer = this.timeoutGuards.get(invocationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timeoutGuards.delete(invocationId);
    }
    this.timeoutBudgets.delete(invocationId);
  }

  // ---------------- 查询（get_execution 5.3.4） ----------------

  /** 组装执行详情；invocation 不存在 → 40003 */
  getExecution(
    invocationId: string,
    opts?: { includeEvents?: boolean; includeLogs?: boolean },
  ): ExecutionDetail {
    const record = this.requireRecord(invocationId);
    const detail: ExecutionDetail = {
      invocation_id: record.invocation_id,
      capability_id: record.capability_id,
      status: toExternalStatus(record.internalStatus),
      mode: record.mode,
      created_at: record.created_at,
      started_at: record.started_at ?? null,
      ended_at: record.ended_at ?? null,
      result: record.result,
      error: record.error ?? null,
    };
    // 产物登记填充（PRD 第 9 节 Result 五分；M2-04）：非空才输出，
    // 无产物的调用不产生响应噪音
    if (record.artifacts.length > 0) detail.artifacts = record.artifacts;
    if (opts?.includeEvents) {
      detail.events = this.deps.events.listByInvocation(invocationId);
    }
    if (opts?.includeLogs) {
      detail.logs = this.deps.logs.listByInvocation(invocationId);
    }
    return detail;
  }

  // ---------------- 内部工具 ----------------

  /** 读取记录；不存在 → 40003（5.5 错误表） */
  private requireRecord(invocationId: string): InvocationRecord {
    const record = this.deps.state.get(invocationId);
    if (record === undefined) {
      throw new RpcError(ERROR_CODES.INVOCATION_NOT_FOUND, `invocation 不存在：${invocationId}`);
    }
    return record;
  }

  /**
   * 状态转换守卫：from 必须命中 allowedFrom、当前非终态，否则 40004 / 40003。
   * （行8 "终态拒绝"的单点实现，所有转换方法必经）
   */
  private transition(
    invocationId: string,
    allowedFrom: Array<InvocationRecord["internalStatus"]>,
    to: InvocationRecord["internalStatus"],
  ): void {
    const record = this.requireRecord(invocationId);
    if (isTerminal(record.internalStatus)) {
      throw new RpcError(
        ERROR_CODES.ILLEGAL_STATE_OPERATION,
        `invocation 已处于终态 ${record.internalStatus}，拒绝 ${to} 转换`,
      );
    }
    if (!allowedFrom.includes(record.internalStatus)) {
      throw new RpcError(
        ERROR_CODES.ILLEGAL_STATE_OPERATION,
        `非法状态转换：${record.internalStatus} → ${to}（允许来源：${allowedFrom.join("/")}）`,
      );
    }
    this.deps.state.update(invocationId, { internalStatus: to });
  }
}
