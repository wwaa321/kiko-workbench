/**
 * @kiko-workbench/plugin-dev —— Dev 内置插件（M2-03 异步语义验证测试床）
 *
 * 能力清单：
 *   - dev.longtask —— 模拟长任务：分段 sleep + progress 周期上报 +
 *     协作取消检查点；ignore_cancel=true 可模拟不协作插件（跳过检查点，
 *     验证主进程 5s 宽限强杀路径，5.3.6）
 *   - dev.greeting —— 声明式配置参考实现（P-002 Phase 1）：消费
 *     manifest.contributes.configuration 声明的配置（经 ctx.config 注入），
 *     覆盖全部 v1 控件类型（string / enum / boolean / integer）与
 *     x-kiko-secret 秘密字段——第三方插件作者照抄本文件即可接入配置
 *   - dev.uitest —— 微应用推送参考实现（P-003 v1）：ctx.ui.send 向
 *     本插件微应用窗口（web/，manifest.contributes.ui.entry 声明）推送
 *     消息；窗口未开抛 40010 + 操作指引——微应用链路的端到端测试床
 *
 * 用途（M2 验收门 / M3 复用）：
 *   - "异步调用后 subscribe_event 依次收到 started/progress/completed"
 *   - "长任务（模拟 10s）发起 cancel，5s 内终态；协作退出与强杀双路径"
 *   - M3 MCP 适配器 progress notification 转发验证复用本能力
 *
 * 约束：仅依赖 plugin-sdk（设计文档第 4 节依赖方向）；零文件系统 /
 * 网络副作用（纯时间模拟，测试间无状态残留）。
 */
import {
  ERROR_CODES,
  RpcError,
  type InvocationContext,
  type KikoPlugin,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/** dev.longtask 输入形状（ajv 主进程侧已校验，此处防御性复检） */
interface LongTaskInput {
  duration_ms: number;
  /** 缺省 false：正常协作（检查点响应取消） */
  ignore_cancel?: boolean;
  /** 缺省 1000ms */
  progress_interval_ms?: number;
}

/** dev.greeting 输入形状（ajv 主进程侧已校验） */
interface GreetingInput {
  /** 覆盖配置里的 greeting_name（单次调用语义） */
  name?: string;
}

/** dev.uitest 输入形状（ajv 主进程侧已校验） */
interface UiTestInput {
  /** 推送文本（缺省自动生成带时间戳的消息） */
  message?: string;
}

/** 取消检查点步长（协作取消延迟上限 ≈ 步长 + 调度误差） */
const STEP_MS = 100;
/** progress 上报缺省间隔 */
const DEFAULT_PROGRESS_INTERVAL_MS = 1000;
/** 输入防御上限（与 capabilities.json schema 对齐，双保险） */
const MAX_DURATION_MS = 60000;
/** repeat_times 防御上限（与 manifest schema 对齐） */
const MAX_REPEAT_TIMES = 5;

/** 分段 sleep（不阻塞事件循环：host 命令通道与 cancel 置位可并发到达） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * dev.greeting：声明式配置参考实现（P-002 Phase 1）
 *
 * 组装语义（全部消费 ctx.config 注入值，输入 name 单次覆盖）：
 *   - 问候对象 = input.name ?? config.greeting_name ?? "world"
 *   - style：casual → `hey {name}`；formal → `Good day, {name}.`
 *   - exclaim → 尾部追加 "!"
 *   - repeat_times → repeated 数组（1~5）
 *
 * 两种配置缺失处理模式的活样例（规范"插件配置"章节的两极）：
 *   - 非关键配置（greeting_name 等）→ 缺省兜底，缺了照常运行
 *   - 关键配置（api_token，required + secret）→ 未配置抛含
 *     "请到设置面板配置"指引的结构化错误，Agent 转达即闭环
 *
 * 安全示范：api_token（x-kiko-secret）值绝不出现在返回值与日志
 * （调用日志 / 对话上下文均可见），配置成功时也只回显状态。
 */
function handleGreeting(
  input: GreetingInput,
  config: Record<string, unknown>,
  ctx: InvocationContext,
): Record<string, unknown> {
  // 关键配置缺失 → 结构化错误 + 指引（运行时宿主不拦截，插件自判——
  // 错误信息 Agent 可读可转达，这是 required 语义的运行时半边）
  if (typeof config.api_token !== "string" || config.api_token === "") {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      "api_token 未配置：请在工作台插件面板点击「设置」填写访问令牌（保存后自动生效，下次调用即使用新配置）",
    );
  }

  // 非关键配置读取防御：类型不符（异常流量 / 旧结构迁移残留）一律回落
  // 缺省——配置损坏时插件仍可用（后果明确反馈，不崩溃）
  const fallbackName =
    typeof config.greeting_name === "string" && config.greeting_name !== ""
      ? config.greeting_name
      : "world";
  const name =
    typeof input.name === "string" && input.name !== "" ? input.name : fallbackName;
  const style = config.style === "formal" ? "formal" : "casual";
  const exclaim = config.exclaim === true;
  const repeatRaw = config.repeat_times;
  const repeatTimes =
    typeof repeatRaw === "number" && Number.isInteger(repeatRaw)
      ? Math.min(Math.max(repeatRaw, 1), MAX_REPEAT_TIMES)
      : 1;

  const base = style === "formal" ? `Good day, ${name}.` : `hey ${name}`;
  const greeting = exclaim ? `${base}!` : base;
  const repeated = Array.from({ length: repeatTimes }, () => greeting);

  // 日志与返回值均不含 token 值（secret 只报状态）
  ctx.log(`greeting assembled: style=${style} name=${name} repeat=${repeatTimes}`);

  return {
    greeting,
    repeated,
    config_used: { greeting_name: name, style, exclaim, repeat_times: repeatTimes },
    token_status: "configured",
  };
}

/**
 * dev.uitest：微应用推送参考实现（P-003 v1）
 *
 * 链路：ctx.ui.send(payload) → 主进程 runtime ui-send 路由 → 微应用
 * 窗口（kiko-plugin://dev/ 消息流页面渲染）。窗口未打开时宿主回
 * 40010（PLUGIN_UI_NOT_OPEN）——本能力把它转成带操作指引的错误透出，
 * Agent 读到即可转达用户（与 dev.greeting 的 api_token 指引同思路）。
 *
 * 回显契约：返回 payload 原文（delivered + sent_at + payload），调用方
 * 与窗口渲染内容可逐字段比对——推送链路的端到端验证锚点。
 */
async function handleUiTest(
  input: UiTestInput,
  ctx: InvocationContext,
): Promise<Record<string, unknown>> {
  const sentAt = new Date().toISOString();
  const message =
    typeof input.message === "string" && input.message !== ""
      ? input.message
      : `hello from dev.uitest at ${sentAt}`;
  const payload = { kind: "dev.uitest", message, sent_at: sentAt };

  ctx.log(`uitest push: ${message}`);
  try {
    await ctx.ui.send(payload);
  } catch (e) {
    // 40010（窗口未开）→ 保留错误码 + 补充指引（错误信息 Agent 可读可转达）
    if (e instanceof RpcError && e.code === ERROR_CODES.PLUGIN_UI_NOT_OPEN) {
      throw new RpcError(
        ERROR_CODES.PLUGIN_UI_NOT_OPEN,
        "插件界面未打开：请先在工作台插件面板点击「打开界面」，再调用 dev.uitest",
      );
    }
    // 其余异常（宿主投递故障等）原样透传——不吞不包装，排障信息完整
    throw e;
  }
  return { delivered: true, sent_at: sentAt, payload };
}

/**
 * Dev 插件工厂：返回全新 KikoPlugin 实例（无内部状态，工厂仅为与
 * file 插件同构——单测可取干净实例，host 经 manifest.entry 加载单例）。
 * P-002 起 setup 快照 ctx.config（load 期一次；保存新值重启进程后生效）。
 */
export function createDevPlugin(): KikoPlugin {
  /** 配置快照（setup 时经 PluginContext.config 注入；缺省 {} 双保险） */
  let config: Record<string, unknown> = {};

  return {
    /** 快照注入的配置（P-002：dev.greeting 消费） */
    async setup(ctx: PluginContext): Promise<void> {
      config = ctx.config;
    },

    /** 能力执行入口：longtask 分段 sleep；greeting 配置组装；uitest 推送 */
    async handle(capabilityId: string, input: unknown, ctx: InvocationContext): Promise<unknown> {
      if (capabilityId === "dev.greeting") {
        return handleGreeting(input as GreetingInput, config, ctx);
      }
      if (capabilityId === "dev.uitest") {
        return handleUiTest(input as UiTestInput, ctx);
      }
      if (capabilityId !== "dev.longtask") {
        throw new RpcError(
          ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          `dev 插件不支持能力：${capabilityId}`,
        );
      }
      const params = input as LongTaskInput;
      // 防御性复检（正常链路 ajv 已拦截；绕过传输层的直接调用兜底）
      if (
        typeof params.duration_ms !== "number" ||
        !Number.isFinite(params.duration_ms) ||
        params.duration_ms < 0 ||
        params.duration_ms > MAX_DURATION_MS
      ) {
        throw new RpcError(
          ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          `duration_ms 必须为 0~${MAX_DURATION_MS} 的数值`,
        );
      }
      const ignoreCancel = params.ignore_cancel === true;
      const progressInterval =
        typeof params.progress_interval_ms === "number" && params.progress_interval_ms >= 1
          ? params.progress_interval_ms
          : DEFAULT_PROGRESS_INTERVAL_MS;

      const start = Date.now();
      let lastProgressAt = 0;
      // 主循环：分段 sleep，每步一个取消检查点 + 周期 progress 上报
      for (;;) {
        const elapsed = Date.now() - start;
        const remain = params.duration_ms - elapsed;
        if (remain <= 0) break;
        await sleep(Math.min(STEP_MS, remain));

        // 取消检查点（5.3.6 协作取消）：抛出 → host 按 cancelled 上报。
        // ignore_cancel 模拟不协作插件：跳过检查点，交由主进程宽限强杀
        if (!ignoreCancel && ctx.isCancelled()) {
          throw new Error(`dev.longtask 在 ${Date.now() - start}ms 检查点响应取消`);
        }

        const nowElapsed = Date.now() - start;
        if (nowElapsed - lastProgressAt >= progressInterval) {
          lastProgressAt = nowElapsed;
          // percent 单调递增至 ~100（整除时可达 100，无碍）
          const percent = Math.min(100, Math.floor((nowElapsed / params.duration_ms) * 100));
          ctx.progress(percent, `running ${nowElapsed}ms / ${params.duration_ms}ms`);
        }
      }
      return { slept_ms: Date.now() - start };
    },
  };
}

// host 经 manifest.entry 动态加载：default 导出插件单例
export default createDevPlugin();
