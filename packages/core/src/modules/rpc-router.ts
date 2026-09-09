/**
 * RPC 方法路由器（设计文档 5.3 六方法；M2-02 从 ws-server.ts 平移抽出）
 *
 * 职责：六方法的参数校验与业务分发（registry / invocation / runtime /
 * state 依赖注入），**不含任何传输层细节**——WS 与 HTTP 双通道（5.1）
 * 共用本路由，通道差异经 RpcContext 判别：
 *   - kind "ws"：携带 session（subscribe_event 的订阅状态落点）
 *   - kind "http"：无会话——subscribe_event 返回 -32601（5.1：
 *     "subscribe_event 仅 WS 可用"）
 *
 * auth 方法不在此路由：它属于传输层握手（WS 连接状态机，见
 * ws-server.ts；HTTP 用 Bearer 头，无 auth 方法）。
 */
import {
  ERROR_CODES,
  RPC_METHODS,
  RpcError,
  type InvokeAsyncResult,
  type InvokeSyncResult,
  type RescanResult,
} from "@kiko-workbench/protocol";
import type { CapabilityRegistry } from "./registry.js";
import type { InvocationManager } from "./invocation.js";
import type { ExecutionRuntime } from "./runtime.js";
import type { StateManager } from "./state.js";
import { toExternalStatus } from "../stores/types.js";

/** 组装依赖（全部注入，路由器零传输层逻辑） */
export interface RpcRouterDeps {
  registry: CapabilityRegistry;
  invocation: InvocationManager;
  runtime: ExecutionRuntime;
  state: StateManager;
}

/** WS 会话上下文（subscribe_event 订阅状态的落点） */
export interface WsSessionContext {
  kind: "ws";
  /** 事件过滤（invocationId 缺省 = 全量；subscription 缺省 = 未订阅） */
  subscription?: { invocationId?: string };
}

/** HTTP 请求上下文（无连接级会话：无法订阅推送） */
export interface HttpContext {
  kind: "http";
}

/** 方法路由上下文：通道判别（WS 有会话 / HTTP 无会话） */
export type RpcContext = WsSessionContext | HttpContext;

export class RpcRouter {
  constructor(private readonly deps: RpcRouterDeps) {}

  /** 方法路由（5.3 六方法 + 未知方法 -32601；subscribe_event 仅 WS） */
  async dispatch(
    context: RpcContext,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (method) {
      case RPC_METHODS.DISCOVER:
        return this.discover(params);
      case RPC_METHODS.DESCRIBE:
        return this.describe(params);
      case RPC_METHODS.INVOKE:
        return this.invoke(params);
      case RPC_METHODS.GET_EXECUTION:
        return this.getExecution(params);
      case RPC_METHODS.SUBSCRIBE_EVENT:
        return this.subscribeEvent(context, params);
      case RPC_METHODS.CANCEL:
        return this.cancel(params);
      case RPC_METHODS.PLUGINS_RESCAN:
        return this.pluginsRescan();
      default:
        throw new RpcError(ERROR_CODES.METHOD_NOT_FOUND, `方法不存在：${method}`);
    }
  }

  // ---------------- 5.3.1 discover ----------------

  private discover(params?: Record<string, unknown>): unknown {
    const query = params?.["query"];
    if (query !== undefined && typeof query !== "string") {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, "query 必须为字符串");
    }
    // 摘要由 registry 组装（R4 契约：不含 schema 字段，registry.test 锁定）
    return { capabilities: this.deps.registry.discover(query) };
  }

  // ---------------- 5.3.2 describe ----------------

  private describe(params?: Record<string, unknown>): unknown {
    const capabilityId = requireString(params, "capability_id");
    // 未注册 / 禁用 → 40001（registry.describe 内部抛出，透传）
    return this.deps.registry.describe(capabilityId);
  }

  // ---------------- 5.3.3 invoke ----------------

  private async invoke(params?: Record<string, unknown>): Promise<unknown> {
    if (params === undefined) throw new RpcError(ERROR_CODES.INVALID_PARAMS, "缺少 params");
    const capabilityId = requireString(params, "capability_id");
    const input = params["input"];
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, "input 必须为对象");
    }
    const mode = params["mode"] ?? "sync";
    if (mode !== "sync" && mode !== "async") {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'mode 必须为 "sync" 或 "async"');
    }

    // 创建 + ajv 校验（40001 能力不存在 / 40002 校验失败明细 / 40005 插件不可用）
    const record = this.deps.invocation.createInvocation({
      capabilityId,
      input: input as Record<string, unknown>,
      mode,
    });

    if (mode === "async") {
      // 受理即返回（5.3.3 async 行；执行 fire-and-forget，事件序列验收属 M2-03）
      void this.deps.runtime.execute(record).catch(() => undefined);
      const asyncResult: InvokeAsyncResult = {
        invocation_id: record.invocation_id,
        status: "running",
      };
      return asyncResult;
    }

    // sync：阻塞至终态（5.3.3 sync 行：成功带 result，失败带 error——均非 JSON-RPC error）
    await this.deps.runtime.execute(record);
    await this.deps.runtime.waitForSettled(record.invocation_id);
    const final = this.deps.state.get(record.invocation_id);
    if (final === undefined) {
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, "invocation 终态记录丢失");
    }
    const result: InvokeSyncResult = {
      invocation_id: record.invocation_id,
      status: toExternalStatus(final.internalStatus),
    };
    if (final.result !== undefined) result.result = final.result;
    // 产物登记填充（PRD 第 9 节 Result 五分；M2-04）：非空才输出
    if (final.artifacts.length > 0) result.artifacts = final.artifacts;
    if (final.error !== undefined) result.error = final.error;
    return result;
  }

  // ---------------- 5.3.4 get_execution ----------------

  private getExecution(params?: Record<string, unknown>): unknown {
    const invocationId = requireString(params, "invocation_id");
    // 不存在 → 40003（invocation.getExecution 内部抛出，透传）
    return this.deps.invocation.getExecution(invocationId, {
      includeEvents: optionalBoolean(params, "include_events"),
      includeLogs: optionalBoolean(params, "include_logs"),
    });
  }

  // ---------------- 5.3.5 subscribe_event（仅 WS） ----------------

  private subscribeEvent(context: RpcContext, params?: Record<string, unknown>): unknown {
    // 5.1："subscribe_event 仅 WS 可用"——HTTP 无连接会话，推送无处投递
    if (context.kind !== "ws") {
      throw new RpcError(
        ERROR_CODES.METHOD_NOT_FOUND,
        "subscribe_event 仅 WS 通道可用（HTTP 无法接收推送）",
      );
    }
    let filter: { invocationId?: string } | undefined;
    const raw = params?.["filter"];
    if (raw !== undefined) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, "filter 必须为对象");
      }
      const invocationId = (raw as Record<string, unknown>)["invocation_id"];
      if (invocationId !== undefined && typeof invocationId !== "string") {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, "filter.invocation_id 必须为字符串");
      }
      filter = invocationId !== undefined ? { invocationId } : {};
    }
    // 重复订阅：最新 filter 覆盖旧订阅（每连接单一订阅，语义简单可预期）
    context.subscription = filter ?? {};
    return { subscribed: true };
  }

  // ---------------- 5.3.6 cancel ----------------

  private async cancel(params?: Record<string, unknown>): Promise<unknown> {
    const invocationId = requireString(params, "invocation_id");
    // 终态 → 40004；created/resolved → 直接终态；running → 协作取消（宽限强杀）
    this.deps.invocation.cancel(invocationId);
    // 5.3.6："返回时已处于 cancelled 终态"——running 态等待协作取消链收尾
    await this.deps.runtime.waitForSettled(invocationId);
    const record = this.deps.state.get(invocationId);
    if (record === undefined) {
      throw new RpcError(ERROR_CODES.INVOCATION_NOT_FOUND, `invocation 不存在：${invocationId}`);
    }
    // 正常路径恒为 cancelled；崩溃取消竞态（M1-09：崩溃胜出）下为 failed——
    // 返回实际终态而非谎报 cancelled，客户端可感知真实情况
    return { invocation_id: invocationId, status: toExternalStatus(record.internalStatus) };
  }

  // ---------------- plugins.rescan（S11，零 Shell 自举方案 3.3） ----------------

  /**
   * 第三方插件根重扫：registry.rescan 拿增量结果，removed 列表驱动
   * runtime dispose（运行中进程终止 + 残余 invocation failed）。
   * 无参数；WS / HTTP 双通道均可用（与 subscribe_event 不同：rescan
   * 是一次性请求-响应，无会话依赖）。
   */
  private async pluginsRescan(): Promise<RescanResult> {
    const result = await this.deps.registry.rescan();
    // 卸载的插件：终止运行中进程（registry 是纯数据层不碰进程——职责
    // 分离在 router 收口，见 registry.unregisterPlugin 注释）
    for (const pluginId of result.removed) {
      this.deps.runtime.disposePlugin(pluginId);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// 参数工具（-32602：缺必填 / 类型错，非 schema 校验——那是 40002 的职责）
// ---------------------------------------------------------------------------

/** 取必填非空 string 参数；缺失 / 类型错 → -32602 */
function requireString(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, `参数 ${key} 必须为非空字符串`);
  }
  return value;
}

/** 取可选 boolean 参数；缺省 undefined；存在但非 boolean → -32602 */
function optionalBoolean(
  params: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = params?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, `参数 ${key} 必须为布尔值`);
  }
  return value;
}
