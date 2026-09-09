/**
 * plugin-host 运行时单测（M1-07 验收锚点）
 *
 * 验收标准（任务清单 M1-07，对照设计文档）：
 *   - resolveSafe 单点路径校验在 host 集成路径生效（`..` 注入/绝对路径/越界全拒）
 *   - artifacts.save 同名改名 (2)(3) 递增（7.4.2）
 *   - 插件异常不致 host 退出：error 上报后仍可继续处理新命令（8.5）
 *   - load/invoke/cancel/shutdown 消息协议（6.3）逐分支覆盖
 *
 * 测试策略：真实文件系统 + 临时目录（mkdtemp）；模块加载器按需注入
 * （错误路径 / 取消路径注入内存插件对象，load 路径走真实动态 import）。
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ERROR_CODES, RpcError, type ArtifactInfo } from "@kiko-workbench/protocol";
import { PluginHost, type HostCommand, type HostEvent, type ModuleLoader } from "./host.js";
import type { KikoPlugin, PluginContext } from "./types.js";

/** 测试临时根（用例结束后统一清理） */
const tempDirs: string[] = [];

/** 收集上行事件的通道 + 宿主工厂（uiSendTimeoutMs 供 ui.send 超时路径注入短值） */
function makeHost(loadModule?: ModuleLoader, uiSendTimeoutMs?: number) {
  const events: HostEvent[] = [];
  const host = new PluginHost({
    send: (event) => events.push(event),
    loadModule,
    uiSendTimeoutMs,
  });
  return { host, events };
}

/** 在临时目录落一个最小插件包（manifest + capabilities），entry 由调用方写入 */
async function makePluginDir(pluginId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `kiko-host-${pluginId}-`));
  tempDirs.push(dir);
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: "1.0.0",
      entry: "index.mjs",
      permissions: [],
    }),
  );
  await writeFile(
    join(dir, "capabilities.json"),
    JSON.stringify([{ id: `${pluginId}.echo` }, { id: `${pluginId}.noop` }]),
  );
  return dir;
}

/** 工作空间临时目录（产物落盘目标） */
async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kiko-ws-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 便捷：load 命令构造（documentsDir M1-09 / userPluginsRoot S2 /
 * esbuildBinaryPath S8 / config P-002 扩展字段）。config 缺省 {}——
 * 主进程对未声明配置的插件即注入空对象（方案草案 §3.4）。
 */
const loadCmd = (
  dir: string,
  pluginId: string,
  workspaceRoot: string,
  config: Record<string, unknown> = {},
): HostCommand => ({
  type: "load",
  manifestPath: join(dir, "manifest.json"),
  pluginId,
  workspaceRoot,
  documentsDir: join(dir, "..", "documents"),
  userPluginsRoot: join(dir, "..", "user-plugins"),
  esbuildBinaryPath: "/fake/esbuild.exe",
  config,
});

afterAll(async () => {
  // 统一清理临时目录（best effort，失败不影响测试结论）
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// load 路径（真实文件 + 真实动态 import）
// ---------------------------------------------------------------------------

describe("load：加载与失败上报（6.3 load / load-error / loaded）", () => {
  it("真实插件目录动态 import 成功 → loaded 携带能力 id 列表，setup 收到 PluginContext", async () => {
    const dir = await makePluginDir("ok");
    const workspaceRoot = await makeWorkspace();
    // 插件把 setup 收到的 ctx 落盘，供测试断言桥接内容
    await writeFile(
      join(dir, "index.mjs"),
      `export default {
        async setup(ctx) {
          await import("node:fs/promises").then((fs) =>
            fs.writeFile(${JSON.stringify(join(dir, "setup.json"))}, JSON.stringify(ctx)),
          );
        },
        async handle(capabilityId, input) { return { capabilityId, input }; },
      };`,
    );
    const { host, events } = makeHost();

    await host.handleCommand(loadCmd(dir, "ok", workspaceRoot));

    expect(events).toEqual([{ type: "loaded", capabilities: ["ok.echo", "ok.noop"] }]);
    const setupCtx = JSON.parse(readFileSync(join(dir, "setup.json"), "utf8")) as PluginContext;
    expect(setupCtx).toEqual({
      pluginId: "ok",
      workspaceRoot,
      documentsDir: join(dir, "..", "documents"),
      userPluginsRoot: join(dir, "..", "user-plugins"),
      esbuildBinaryPath: "/fake/esbuild.exe",
      config: {},
      // ui.send 为函数，JSON 序列化落盘后剩空对象——字段存在性即桥接证明
      ui: {},
    });
  });

  it("load 携带 config → setup 的 ctx.config 原样注入（P-002 §3.4）", async () => {
    const dir = await makePluginDir("cfg");
    const workspaceRoot = await makeWorkspace();
    // 插件把 setup 收到的 config 落盘，供测试断言桥接内容
    await writeFile(
      join(dir, "index.mjs"),
      `export default {
        async setup(ctx) {
          await import("node:fs/promises").then((fs) =>
            fs.writeFile(${JSON.stringify(join(dir, "config.json"))}, JSON.stringify(ctx.config)),
          );
        },
        async handle() { return {}; },
      };`,
    );
    const { host, events } = makeHost();

    await host.handleCommand(
      loadCmd(dir, "cfg", workspaceRoot, {
        api_key: "sk-test",
        retries: 3,
        verbose: true,
      }),
    );

    expect(events.map((e) => e.type)).toEqual(["loaded"]);
    // host 零加工透传：default 合并 / 未知字段透传均归主进程读侧职责
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({
      api_key: "sk-test",
      retries: 3,
      verbose: true,
    });
  });

  it("manifest.id 与 load.pluginId 不一致 → load-error，host 存活可再加载", async () => {
    const dir = await makePluginDir("real");
    const workspaceRoot = await makeWorkspace();
    await writeFile(join(dir, "index.mjs"), "export default { async handle() { return {}; } };");
    const { host, events } = makeHost();

    await host.handleCommand(loadCmd(dir, "mismatch", workspaceRoot)); // id 不一致
    expect(events.map((e) => e.type)).toEqual(["load-error"]);

    // host 未死：同一宿主用正确 id 再加载成功
    await host.handleCommand(loadCmd(dir, "real", workspaceRoot));
    expect(events.map((e) => e.type)).toEqual(["load-error", "loaded"]);
  });

  it("entry 缺 handle 函数 → load-error（接口形状校验）", async () => {
    const dir = await makePluginDir("bad");
    const workspaceRoot = await makeWorkspace();
    await writeFile(join(dir, "index.mjs"), "export default { notHandle: 1 };");
    const { host, events } = makeHost();

    await host.handleCommand(loadCmd(dir, "bad", workspaceRoot));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("load-error");
    expect((events[0] as { message: string }).message).toContain("handle");
  });

  it("非法 pluginId（含路径分隔符 / ..）→ load-error（产物目录安全前提）", async () => {
    const dir = await makePluginDir("safe");
    const workspaceRoot = await makeWorkspace();
    const { host, events } = makeHost();

    await host.handleCommand(loadCmd(dir, "../evil", workspaceRoot));
    await host.handleCommand(loadCmd(dir, "a/b", workspaceRoot));

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "load-error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invoke / error / cancel（注入内存插件，聚焦 host 逻辑）
// ---------------------------------------------------------------------------

describe("invoke：执行与异常上报（8.5 异常不致 host 退出）", () => {
  /** 注入式宿主：loadModule 直接返回插件对象，绕过磁盘 entry */
  async function setupWithPlugin(plugin: KikoPlugin, pluginId = "p") {
    const { host, events } = makeHost(async () => ({ default: plugin }));
    const dir = await makePluginDir(pluginId);
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, pluginId, workspaceRoot));
    return { host, events, workspaceRoot, pluginId };
  }

  it("handle 正常返回 → result 携带返回值", async () => {
    const { host, events } = await setupWithPlugin({
      async handle(capabilityId, input) {
        return { capabilityId, echoed: input };
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: { x: 1 },
    });
    await host.idle();

    expect(events.at(-1)).toEqual({
      type: "result",
      invocationId: "inv_1",
      result: { capabilityId: "p.echo", echoed: { x: 1 } },
    });
  });

  it("未加载即 invoke → error 40005（插件不可用）", async () => {
    const { host, events } = makeHost(); // 不 load
    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();

    expect(events.at(-1)).toEqual({
      type: "error",
      invocationId: "inv_1",
      error: { code: ERROR_CODES.PLUGIN_UNAVAILABLE, message: "插件未加载，无法执行能力" },
    });
  });

  it("handle 抛普通 Error → error 50001（统一包装）", async () => {
    const { host, events } = await setupWithPlugin({
      async handle() {
        throw new Error("boom");
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();

    expect(events.at(-1)).toEqual({
      type: "error",
      invocationId: "inv_1",
      error: { code: ERROR_CODES.PLUGIN_EXECUTION_ERROR, message: "boom" },
    });
  });

  it("handle 抛 RpcError → code/message 原样透传（不被包装为 50001）", async () => {
    const { host, events } = await setupWithPlugin({
      async handle() {
        throw new RpcError(ERROR_CODES.EXECUTION_TIMEOUT, "自定义超时");
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();

    expect(events.at(-1)).toEqual({
      type: "error",
      invocationId: "inv_1",
      error: { code: ERROR_CODES.EXECUTION_TIMEOUT, message: "自定义超时" },
    });
  });

  it("异常后 host 不退出：同一宿主继续处理新 invoke 成功", async () => {
    let shouldThrow = true;
    const { host, events } = await setupWithPlugin({
      async handle() {
        if (shouldThrow) throw new Error("first fails");
        return { ok: true };
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();
    shouldThrow = false;
    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_2",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();

    expect(events.at(-2)?.type).toBe("error"); // 第一次失败
    expect(events.at(-1)).toEqual({ type: "result", invocationId: "inv_2", result: { ok: true } });
  });

  it("ctx.progress / ctx.log 桥接为上行消息（message 缺省不输出字段）", async () => {
    const { host, events } = await setupWithPlugin({
      async handle(_cap, _input, ctx) {
        ctx.log("starting");
        ctx.progress(50);
        ctx.progress(100, "done");
        return null;
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();

    expect(events.filter((e) => e.type === "log")).toEqual([
      { type: "log", invocationId: "inv_1", message: "starting" },
    ]);
    expect(events.filter((e) => e.type === "progress")).toEqual([
      { type: "progress", invocationId: "inv_1", percent: 50 },
      { type: "progress", invocationId: "inv_1", percent: 100, message: "done" },
    ]);
  });

  it("并发两个 invocation：各自独立 result，互不串扰", async () => {
    const { host, events } = await setupWithPlugin({
      async handle(capabilityId, input) {
        // 模拟不同耗时：x=1 先完成
        const ms = (input as { x: number }).x === 1 ? 5 : 20;
        await new Promise((r) => setTimeout(r, ms));
        return { x: (input as { x: number }).x, capabilityId };
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: { x: 1 },
    });
    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_2",
      capabilityId: "p.echo",
      input: { x: 2 },
    });
    await host.idle();

    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(2);
    expect(results.map((e) => (e as { invocationId: string }).invocationId)).toEqual([
      "inv_1",
      "inv_2",
    ]);
  });
});

describe("cancel：协作取消（isCancelled 检查点 → cancelled 上报）", () => {
  async function setupPollingPlugin(pluginId = "p") {
    const { host, events } = makeHost(async () => ({
      default: {
        // 轮询取消检查点的长任务：取消生效即抛错（协作取消的典型实现形态）
        async handle(_cap: string, _input: unknown, ctx: { isCancelled(): boolean }) {
          while (!ctx.isCancelled()) {
            await new Promise((r) => setTimeout(r, 2));
          }
          throw new Error("stopped at checkpoint");
        },
      } satisfies KikoPlugin,
    }));
    const dir = await makePluginDir(pluginId);
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, pluginId, workspaceRoot));
    return { host, events };
  }

  it("running 中 cancel → 插件检查点停止 → cancelled 消息（而非 error）", async () => {
    const { host, events } = await setupPollingPlugin();

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await new Promise((r) => setTimeout(r, 10)); // 让插件先进入轮询
    await host.handleCommand({ type: "cancel", invocationId: "inv_1" });
    await host.idle();

    expect(events.at(-1)).toEqual({ type: "cancelled", invocationId: "inv_1" });
    // 不应出现 error：取消路径优先于异常包装
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("未知 / 已结束的 invocationId cancel → 忽略（合法性由主进程裁决）", async () => {
    const { host, events } = await setupPollingPlugin();

    await host.handleCommand({ type: "cancel", invocationId: "inv_unknown" });
    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await new Promise((r) => setTimeout(r, 5));
    await host.handleCommand({ type: "cancel", invocationId: "inv_1" });
    await host.idle();
    await host.handleCommand({ type: "cancel", invocationId: "inv_1" }); // 已 settle，再 cancel

    expect(events.filter((e) => e.type === "cancelled")).toEqual([
      { type: "cancelled", invocationId: "inv_1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// artifacts（真实文件系统：落盘 / 同名改名 / 路径校验 / 登记）
// ---------------------------------------------------------------------------

describe("ctx.artifacts.save / register（7.4 产物管理）", () => {
  async function setupWithPlugin(plugin: KikoPlugin, pluginId = "p") {
    const { host, events } = makeHost(async () => ({ default: plugin }));
    const dir = await makePluginDir(pluginId);
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, pluginId, workspaceRoot));
    const invoke = async (invocationId: string, input: unknown) => {
      await host.handleCommand({
        type: "invoke",
        invocationId,
        capabilityId: `${pluginId}.echo`,
        input,
      });
      await host.idle();
    };
    return { host, events, workspaceRoot, invoke, pluginId };
  }

  it("save：落盘 workspace/<plugin_id>/ + artifact 消息 + 返回 ArtifactInfo", async () => {
    const {
      host: _host,
      events,
      workspaceRoot,
      invoke,
      pluginId,
    } = await setupWithPlugin({
      async handle(_cap, input, ctx) {
        const info = await ctx.artifacts.save(
          (input as { filename: string }).filename,
          "hello kiko",
          "text/plain",
        );
        return { saved: info };
      },
    });
    void _host;

    await invoke("inv_1", { filename: "notes.txt" });

    const artifact = events.find((e) => e.type === "artifact");
    expect(artifact).toEqual({
      type: "artifact",
      invocationId: "inv_1",
      file: join(workspaceRoot, pluginId, "notes.txt"),
      relativePath: `${pluginId}/notes.txt`,
      filename: "notes.txt",
      mimeType: "text/plain",
      size: "hello kiko".length,
    });
    // 磁盘真实落盘
    expect(readFileSync(join(workspaceRoot, pluginId, "notes.txt"), "utf8")).toBe("hello kiko");
    // result 携带 save 返回的 ArtifactInfo（filename 为实际落盘名）
    const result = events.find((e) => e.type === "result") as {
      result: { saved: ArtifactInfo };
    };
    expect(result.result.saved).toEqual({
      file: join(workspaceRoot, pluginId, "notes.txt"),
      relative_path: `${pluginId}/notes.txt`,
      filename: "notes.txt",
      mime_type: "text/plain",
      size: 10, // "hello kiko".length
    });
  });

  it("save 同名冲突：两次保存 → 第二次自动改名 notes (2).txt，两文件并存（7.4.2）", async () => {
    const { events, workspaceRoot, invoke, pluginId } = await setupWithPlugin({
      async handle(_cap, input, ctx) {
        return await ctx.artifacts.save((input as { filename: string }).filename, "data");
      },
    });

    await invoke("inv_1", { filename: "report.txt" });
    await invoke("inv_2", { filename: "report.txt" });

    // 两次 artifact 上报：原名 + (2) 改名
    const artifacts = events.filter((e) => e.type === "artifact");
    expect(artifacts.map((e) => (e as { filename: string }).filename)).toEqual([
      "report.txt",
      "report (2).txt",
    ]);
    // 磁盘两文件并存，内容各自完整（永不静默覆盖）
    expect(existsSync(join(workspaceRoot, pluginId, "report.txt"))).toBe(true);
    expect(existsSync(join(workspaceRoot, pluginId, "report (2).txt"))).toBe(true);
  });

  it("save 非法文件名（路径分隔符）→ 50001 error（不落盘）", async () => {
    const { events, workspaceRoot, invoke } = await setupWithPlugin({
      async handle(_cap, input, ctx) {
        await ctx.artifacts.save((input as { filename: string }).filename, "x");
        return null;
      },
    });

    await invoke("inv_1", { filename: "../escape.txt" });

    expect(events.at(-1)).toEqual({
      type: "error",
      invocationId: "inv_1",
      error: {
        code: ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        message: expect.stringContaining("非法产物文件名"),
      },
    });
    // 未在工作空间外产生任何文件
    expect(existsSync(join(workspaceRoot, "..", "escape.txt"))).toBe(false);
  });

  it("register：工作空间内路径登记成功，越界路径拒绝 50001（7.4.3 路径校验单点）", async () => {
    const { events, workspaceRoot, invoke, pluginId } = await setupWithPlugin({
      async handle(_cap, input, ctx) {
        const target = input as { file: string };
        ctx.artifacts.register(target.file, "reg.txt", "text/plain", 3);
        return null;
      },
    });

    // 合法：工作空间内绝对路径
    await invoke("inv_1", { file: join(workspaceRoot, pluginId, "reg.txt") });
    // 非法：工作空间外（系统临时目录本身）
    await invoke("inv_2", { file: join(tmpdir(), "outside.txt") });

    const artifacts = events.filter((e) => e.type === "artifact");
    expect(artifacts).toEqual([
      {
        type: "artifact",
        invocationId: "inv_1",
        file: join(workspaceRoot, pluginId, "reg.txt"),
        relativePath: `${pluginId}/reg.txt`,
        filename: "reg.txt",
        mimeType: "text/plain",
        size: 3,
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      invocationId: "inv_2",
      error: { code: ERROR_CODES.PLUGIN_EXECUTION_ERROR },
    });
  });
});

// ---------------------------------------------------------------------------
// ctx.ui.send（P-003 v1：ui-send 上行 + ui-send-result 回执）
// ---------------------------------------------------------------------------

describe("ctx.ui.send：微应用消息下发（P-003 v1）", () => {
  /** 注入式宿主：插件 handle 中调用 ctx.ui.send，测试模拟主进程回执 */
  async function setupWithUiPlugin(
    plugin: KikoPlugin,
    uiSendTimeoutMs = 10_000,
  ) {
    const { host, events } = makeHost(async () => ({ default: plugin }), uiSendTimeoutMs);
    const dir = await makePluginDir("p");
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, "p", workspaceRoot));
    return { host, events };
  }

  it("handle 内 send → ui-send 上行携带 requestId/payload；回执 ok → resolve", async () => {
    const { host, events } = await setupWithUiPlugin({
      async handle(_cap, input, ctx) {
        await ctx.ui.send(input);
        return { delivered: true };
      },
    });

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: { text: "hello ui" },
    });
    // 先等 ui-send 上行出现（handle 此时挂起等回执，idle 会死等）
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "ui-send")).toBe(true);
    });

    // 1) ui-send 上行消息（requestId 从 1 起，payload 原样）
    const uiSend = events.find((e) => e.type === "ui-send");
    expect(uiSend).toEqual({ type: "ui-send", requestId: 1, payload: { text: "hello ui" } });
    // 2) 模拟主进程回执 ok → host 继续执行，handle 返回 result
    await host.handleCommand({ type: "ui-send-result", requestId: 1, ok: true });
    await host.idle();
    expect(events.at(-1)).toEqual({ type: "result", invocationId: "inv_1", result: { delivered: true } });
  });

  it("回执 ok=false 40010 → send reject RpcError（handle 异常路径上报 40010）", async () => {
    // 插件先 send 并捕获异常，把错误信息带回 result 以便断言
    const { host, events } = makeHost(async () => ({
      default: {
        async handle(_cap: string, _input: unknown, ctx: { ui: { send(p: unknown): Promise<void> } }) {
          try {
            await ctx.ui.send({ ping: 1 });
            return { failed: false };
          } catch (e) {
            return {
              failed: true,
              name: e instanceof Error ? e.constructor.name : String(e),
              code: (e as { code?: number }).code,
              message: e instanceof Error ? e.message : String(e),
            };
          }
        },
      } satisfies KikoPlugin,
    }));
    const dir = await makePluginDir("p");
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, "p", workspaceRoot));

    // 插件先发起 invoke；等 ui-send 出现后回执 40010（界面未打开）
    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "ui-send")).toBe(true);
    });
    await host.handleCommand({
      type: "ui-send-result",
      requestId: 1,
      ok: false,
      error: { code: ERROR_CODES.PLUGIN_UI_NOT_OPEN, message: "插件界面未打开" },
    });
    await host.idle();

    // send reject 的是 RpcError（code 40010 透传，非 50001 包装）
    const result = events.find((e) => e.type === "result") as {
      result: { failed: boolean; name: string; code?: number };
    };
    expect(result.result).toEqual({
      failed: true,
      name: "RpcError",
      code: ERROR_CODES.PLUGIN_UI_NOT_OPEN,
      message: "插件界面未打开",
    });
  });

  it("主进程未回执 → 超时兜底 reject（普通 Error，防 await 永久挂起）", async () => {
    const { host, events } = makeHost(
      async () => ({
        default: {
          async handle(_cap: string, _input: unknown, ctx: { ui: { send(p: unknown): Promise<void> } }) {
            try {
              await ctx.ui.send({ slow: true });
              return { timedOut: false };
            } catch {
              return { timedOut: true };
            }
          },
        } satisfies KikoPlugin,
      }),
      20, // 20ms 短超时，加速超时路径
    );
    const dir = await makePluginDir("p");
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, "p", workspaceRoot));

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle(); // 不回执，等待超时触发

    const result = events.find((e) => e.type === "result") as {
      result: { timedOut: boolean };
    };
    expect(result.result).toEqual({ timedOut: true });
  });

  it("并发两次 send：requestId 递增，回执乱序到达也正确配对", async () => {
    const { host, events } = makeHost(async () => ({
      default: {
        async handle(_cap: string, _input: unknown, ctx: { ui: { send(p: unknown): Promise<void> } }) {
          // 并发两次 send（不 await 第一个），模拟推送两条消息
          const p1 = ctx.ui.send({ seq: 1 }).then(() => "ok1", () => "fail1");
          const p2 = ctx.ui.send({ seq: 2 }).then(() => "ok2", () => "fail2");
          return { r1: await p1, r2: await p2 };
        },
      } satisfies KikoPlugin,
    }));
    const dir = await makePluginDir("p");
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, "p", workspaceRoot));

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "ui-send")).toHaveLength(2);
    });
    // 乱序回执：先回 requestId=2（ok），再回 requestId=1（ok）
    await host.handleCommand({ type: "ui-send-result", requestId: 2, ok: true });
    await host.handleCommand({ type: "ui-send-result", requestId: 1, ok: true });
    await host.idle();

    const sends = events.filter((e) => e.type === "ui-send");
    expect(sends.map((e) => (e as { requestId: number }).requestId)).toEqual([1, 2]);
    const result = events.find((e) => e.type === "result") as {
      result: { r1: string; r2: string };
    };
    expect(result.result).toEqual({ r1: "ok1", r2: "ok2" });
  });

  it("未知 requestId 回执（已超时清理）→ 忽略，不击穿 host", async () => {
    const { host, events } = await setupWithUiPlugin({
      async handle() {
        return { ok: true };
      },
    });

    // 直接投递一个没有对应在途请求的回执：应静默忽略（无异常无消息）
    await host.handleCommand({ type: "ui-send-result", requestId: 999, ok: true });
    expect(events.every((e) => e.type !== "ui-send")).toBe(true);

    // host 存活：继续 invoke 正常执行
    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.idle();
    expect(events.at(-1)?.type).toBe("result");
  });
});

// ---------------------------------------------------------------------------
// shutdown（teardown 钩子通道，偏差表 2026-08-20）
// ---------------------------------------------------------------------------

describe("shutdown：排空在途执行 + teardown + shutdown-complete", () => {
  it("teardown 被调用且在全部 invocation 结束后执行", async () => {
    const order: string[] = [];
    const { host, events } = makeHost(async () => ({
      default: {
        async handle() {
          await new Promise((r) => setTimeout(r, 10));
          order.push("handle-done");
          return null;
        },
        async teardown() {
          order.push("teardown");
        },
      } satisfies KikoPlugin,
    }));
    const dir = await makePluginDir("p");
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, "p", workspaceRoot));

    await host.handleCommand({
      type: "invoke",
      invocationId: "inv_1",
      capabilityId: "p.echo",
      input: {},
    });
    await host.handleCommand({ type: "shutdown" });

    expect(order).toEqual(["handle-done", "teardown"]); // 排空后再 teardown
    expect(events.at(-1)).toEqual({ type: "shutdown-complete" });
  });

  it("teardown 抛错不阻塞回收：仍上报 shutdown-complete", async () => {
    const { host, events } = makeHost(async () => ({
      default: {
        async handle() {
          return null;
        },
        async teardown() {
          throw new Error("teardown boom");
        },
      } satisfies KikoPlugin,
    }));
    const dir = await makePluginDir("p");
    const workspaceRoot = await makeWorkspace();
    await host.handleCommand(loadCmd(dir, "p", workspaceRoot));

    await host.handleCommand({ type: "shutdown" });

    expect(events.at(-1)).toEqual({ type: "shutdown-complete" });
  });
});
