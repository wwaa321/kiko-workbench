/**
 * dev 插件单测（M2-03 验收锚点）
 *
 * 验收锚点（任务清单 M2-03 / 设计文档 5.3.6 / 5.4）：
 *   - 正常路径：分段 sleep 完成 → { slept_ms }，progress 周期上报且 percent 单调递增
 *   - 协作取消：isCancelled 置位后检查点抛出（host 转 cancelled 上报）
 *   - ignore_cancel：跳过检查点照常完成（强杀路径的行为基座）
 *   - 参数防御：duration_ms 非法值拒绝（绕过 ajv 的直接调用兜底）
 *
 * 测试直接驱动插件对象（工厂取干净实例），fake InvocationContext
 * 收集 progress 调用；cancel 经可变 flag 模拟 host 置位。
 */
import { describe, expect, it } from "vitest";
import { createDevPlugin } from "./index.js";
import {
  ERROR_CODES,
  RpcError,
  type InvocationContext,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/** fake InvocationContext：progress 调用全收集；cancel 经 flag 模拟 host 置位；
 *  ui.send 行为可注入（缺省模拟"窗口未开"40010——P-003 uitest 测试锚点） */
function makeCtx(uiSend?: (payload: unknown) => Promise<void>) {
  const progresses: Array<{ percent: number; message?: string }> = [];
  const logs: string[] = [];
  const state = { cancelled: false };
  const sentPayloads: unknown[] = [];
  // 投递尝试统一记录（无论宿主侧成败——断言"插件发了什么"用）
  const sendImpl =
    uiSend ??
    (() =>
      Promise.reject(new RpcError(ERROR_CODES.PLUGIN_UI_NOT_OPEN, "插件界面未打开")));
  const ctx: InvocationContext = {
    progress: (percent, message) => {
      progresses.push(message === undefined ? { percent } : { percent, message });
    },
    log: (message) => {
      logs.push(message);
    },
    isCancelled: () => state.cancelled,
    artifacts: {
      save: () => {
        throw new Error("dev 插件不应调用 artifacts.save（无文件副作用）");
      },
      register: () => {
        throw new Error("dev 插件不应调用 artifacts.register（无文件副作用）");
      },
    },
    // P-003：微应用桥。缺省 reject 40010（宿主"窗口未开"语义），
    // 测试用例按场景覆盖为 resolve（窗口开着）或其他异常
    ui: {
      send: (payload: unknown) => {
        sentPayloads.push(payload);
        return sendImpl(payload);
      },
    },
  };
  return { ctx, progresses, logs, state, sentPayloads };
}

/** 组装已 setup 的插件 + PluginContext（P-002 起 config 可注入，缺省 {}） */
async function makePlugin(config: Record<string, unknown> = {}) {
  const plugin = createDevPlugin();
  const pluginCtx: PluginContext = {
    pluginId: "dev",
    workspaceRoot: "D:/unused-workspace",
    documentsDir: "D:/unused-documents",
    // S2 扩展字段：dev 插件不消费，仅为满足必填类型（sdk 插件才用）
    userPluginsRoot: "D:/unused-user-plugins",
    esbuildBinaryPath: "D:/unused-esbuild",
    // P-002 扩展字段：宿主 load 期注入（已保存 + default 合并值）
    config,
    // P-003 扩展字段：dev 插件 setup 不消费（handle 内走 InvocationContext.ui）
    ui: { send: () => Promise.resolve() },
  };
  await plugin.setup?.(pluginCtx);
  return plugin;
}

/** 断言 promise 抛 RpcError 且 code 匹配 */
async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcError> {
  try {
    await promise;
    expect.unreachable("应当抛出 RpcError");
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
}

// ---------------------------------------------------------------------------

describe("插件契约（8.4 KikoPlugin）", () => {
  it("未知能力 id → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("dev.echo", {}, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("duration_ms 防御复检：非数值 / 负数 / 超上限 → 50001（ajv 绕过兜底）", async () => {
    const plugin = await makePlugin();
    for (const bad of ["100" as unknown, -1, 100000]) {
      await expectRpcError(
        plugin.handle("dev.longtask", { duration_ms: bad }, makeCtx().ctx),
        ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      );
    }
  });
});

describe("dev.longtask 正常路径（progress 周期上报）", () => {
  it("duration=250ms interval=100ms → slept_ms ≥ 240，progress ≥ 2 次且 percent 单调递增", async () => {
    const plugin = await makePlugin();
    const { ctx, progresses } = makeCtx();

    const result = (await plugin.handle(
      "dev.longtask",
      { duration_ms: 250, progress_interval_ms: 100 },
      ctx,
    )) as { slept_ms: number };

    expect(result.slept_ms).toBeGreaterThanOrEqual(240);
    expect(progresses.length).toBeGreaterThanOrEqual(2);
    // percent 单调递增（分段上报不回退）
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]!.percent).toBeGreaterThan(progresses[i - 1]!.percent);
    }
    // 上报条目均带 message（进度可读性）
    expect(progresses.every((p) => typeof p.message === "string")).toBe(true);
  });

  it("duration=0 → 立即完成（零进度上报）", async () => {
    const plugin = await makePlugin();
    const { ctx, progresses } = makeCtx();

    const result = (await plugin.handle("dev.longtask", { duration_ms: 0 }, ctx)) as {
      slept_ms: number;
    };

    expect(result.slept_ms).toBeLessThan(50);
    expect(progresses).toEqual([]);
  });
});

describe("dev.longtask 协作取消（5.3.6 检查点）", () => {
  it("200ms 后置 cancel flag → 检查点抛出（耗时 < 600ms，远小于任务时长）", async () => {
    const plugin = await makePlugin();
    const { ctx, state } = makeCtx();
    // 模拟 host 收到 cancel 命令后置位（任务 2000ms，200ms 时取消）
    setTimeout(() => {
      state.cancelled = true;
    }, 200);

    const start = Date.now();
    await expect(plugin.handle("dev.longtask", { duration_ms: 2000 }, ctx)).rejects.toThrow(
      /检查点响应取消/,
    );
    expect(Date.now() - start).toBeLessThan(600);
  });

  it("ignore_cancel=true → 检查点跳过，flag 置位后照常完成（强杀路径行为基座）", async () => {
    const plugin = await makePlugin();
    const { ctx, state } = makeCtx();
    setTimeout(() => {
      state.cancelled = true;
    }, 100);

    const result = (await plugin.handle(
      "dev.longtask",
      { duration_ms: 300, ignore_cancel: true },
      ctx,
    )) as { slept_ms: number };

    expect(result.slept_ms).toBeGreaterThanOrEqual(290);
  });
});

describe("dev.greeting 声明式配置参考（P-002 Phase 1）", () => {
  it("关键配置缺失（api_token 未配置）→ 50001 + 含设置面板指引（Agent 转达闭环）", async () => {
    const plugin = await makePlugin();
    const { ctx } = makeCtx();

    const err = await expectRpcError(
      plugin.handle("dev.greeting", {}, ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(err.message).toContain("设置");
  });

  it("完整配置注入 → formal + exclaim + repeat 全量生效", async () => {
    const plugin = await makePlugin({
      greeting_name: "kiko",
      style: "formal",
      exclaim: true,
      repeat_times: 3,
      api_token: "sk-test-token",
    });
    const { ctx } = makeCtx();

    const result = (await plugin.handle("dev.greeting", {}, ctx)) as {
      greeting: string;
      repeated: string[];
      token_status: string;
    };

    expect(result.greeting).toBe("Good day, kiko.!");
    expect(result.repeated).toEqual(["Good day, kiko.!", "Good day, kiko.!", "Good day, kiko.!"]);
    expect(result.repeated).toHaveLength(3);
    expect(result.token_status).toBe("configured");
  });

  it("非关键配置缺省兜底：只配 token → casual 'hey world' 照常运行", async () => {
    const plugin = await makePlugin({ api_token: "sk-x" });
    const { ctx } = makeCtx();

    const result = (await plugin.handle("dev.greeting", {}, ctx)) as {
      greeting: string;
      config_used: Record<string, unknown>;
    };

    expect(result.greeting).toBe("hey world");
    expect(result.config_used).toEqual({
      greeting_name: "world",
      style: "casual",
      exclaim: false,
      repeat_times: 1,
    });
  });

  it("输入 name 覆盖配置 greeting_name（单次调用语义）", async () => {
    const plugin = await makePlugin({
      greeting_name: "config-name",
      api_token: "sk-x",
    });
    const { ctx } = makeCtx();

    const result = (await plugin.handle("dev.greeting", { name: "input-name" }, ctx)) as {
      greeting: string;
      config_used: Record<string, unknown>;
    };

    expect(result.greeting).toBe("hey input-name");
    expect(result.config_used.greeting_name).toBe("input-name");
  });

  it("secret 不泄露：返回值与日志均无 token 值（只有 token_status）", async () => {
    const plugin = await makePlugin({ api_token: "sk-super-secret-value" });
    const { ctx, logs } = makeCtx();

    const result = await plugin.handle("dev.greeting", {}, ctx);

    const serialized = JSON.stringify(result);
    expect(serialized.includes("sk-super-secret-value")).toBe(false);
    expect(logs.join("\n").includes("sk-super-secret-value")).toBe(false);
  });

  it("异常 config 类型（结构迁移残留）→ 防御回落缺省不崩溃", async () => {
    // greeting_name 传数字 / repeat_times 传超范围值——一律回落
    const plugin = await makePlugin({
      greeting_name: 42,
      style: "unknown-style",
      exclaim: "yes",
      repeat_times: 99,
      api_token: "sk-x",
    });
    const { ctx } = makeCtx();

    const result = (await plugin.handle("dev.greeting", {}, ctx)) as {
      greeting: string;
      config_used: Record<string, unknown>;
    };

    expect(result.greeting).toBe("hey world");
    expect(result.config_used).toEqual({
      greeting_name: "world",
      style: "casual",
      exclaim: false,
      repeat_times: 5, // 99 → 防御钳制到上限 5
    });
  });
});

describe("dev.uitest 微应用推送参考（P-003 v1）", () => {
  it("窗口开着（ui.send resolve）→ delivered + payload 回显（端到端比对锚点）", async () => {
    const plugin = await makePlugin();
    const { ctx, sentPayloads, logs } = makeCtx(() => Promise.resolve());

    const result = (await plugin.handle(
      "dev.uitest",
      { message: "第一条推送" },
      ctx,
    )) as { delivered: boolean; sent_at: string; payload: Record<string, unknown> };

    expect(result.delivered).toBe(true);
    // payload 回显与实际投递内容逐字段一致（调用方 ↔ 窗口渲染比对锚点）
    expect(result.payload).toEqual(sentPayloads[0]);
    expect(result.payload).toMatchObject({
      kind: "dev.uitest",
      message: "第一条推送",
    });
    expect(result.sent_at).toBe(result.payload.sent_at);
    // 推送留痕（调用日志可见链路动作）
    expect(logs.some((l) => l.includes("第一条推送"))).toBe(true);
  });

  it("message 缺省 → 自动生成带时间戳的消息（零参数可调用）", async () => {
    const plugin = await makePlugin();
    const { ctx, sentPayloads } = makeCtx(() => Promise.resolve());

    const result = (await plugin.handle("dev.uitest", {}, ctx)) as {
      payload: { message: string };
    };

    expect(result.payload.message).toMatch(/^hello from dev\.uitest at /);
    expect(sentPayloads).toHaveLength(1);
  });

  it("窗口未开（ui.send reject 40010）→ 40010 透传 + 含「打开界面」指引", async () => {
    const plugin = await makePlugin();
    // makeCtx 缺省 ui.send 即 reject 40010（宿主"窗口未开"语义）
    const { ctx } = makeCtx();

    const err = await expectRpcError(
      plugin.handle("dev.uitest", {}, ctx),
      ERROR_CODES.PLUGIN_UI_NOT_OPEN,
    );
    expect(err.message).toContain("打开界面");
  });

  it("宿主投递异常（非 40010）→ 原样透传不吞（排障信息完整）", async () => {
    const plugin = await makePlugin();
    const { ctx } = makeCtx(() =>
      Promise.reject(new Error("宿主 webContents 投递故障（模拟）")),
    );

    await expect(plugin.handle("dev.uitest", {}, ctx)).rejects.toThrow(
      /宿主 webContents 投递故障/,
    );
  });
});
