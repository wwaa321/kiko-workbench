/**
 * file 插件单测（M1-10 验收锚点）
 *
 * 验收锚点（任务清单 M1-10 / 设计文档 8.6 / 7.4.3）：
 *   - 三能力正常路径（read / write / list）
 *   - 越界读写全拒（50001）：读/列越出文档目录、写越出工作空间
 *   - file.write 覆盖语义 + ctx.artifacts.register 登记（M1 内存态）
 *   - 沙箱基座经 setup 注入（documentsDir / workspaceRoot 分离）
 *
 * 测试直接驱动插件对象（工厂取干净实例），fake InvocationContext
 * 收集 register 调用；真实文件系统用临时目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilePlugin } from "./index.js";
import {
  ERROR_CODES,
  RpcError,
  type InvocationContext,
  type PluginContext,
} from "@kiko-workbench/plugin-sdk";

/** 临时目录基座（documents 与 workspace 分离，沙箱边界即目录边界） */
let documentsDir: string;
let workspaceRoot: string;

beforeEach(async () => {
  documentsDir = await mkdtemp(join(tmpdir(), "kiko-file-docs-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "kiko-file-ws-"));
});

afterEach(async () => {
  await rm(documentsDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** fake InvocationContext：register 调用全收集（save 不应被 file 插件使用） */
function makeCtx() {
  const registered: Array<{ file: string; filename: string; mime_type: string; size: number }> = [];
  const ctx: InvocationContext = {
    progress: () => undefined,
    log: () => undefined,
    isCancelled: () => false,
    artifacts: {
      save: () => {
        throw new Error("file 插件不应调用 artifacts.save（覆盖语义走 register）");
      },
      register: (file, filename, mime_type, size) => {
        registered.push({ file, filename, mime_type, size });
      },
    },
  };
  return { ctx, registered };
}

/** 组装已 setup 的插件 + PluginContext */
async function makePlugin() {
  const plugin = createFilePlugin();
  const pluginCtx: PluginContext = {
    pluginId: "file",
    workspaceRoot,
    documentsDir,
    // S2 扩展字段：file 插件不消费，仅为满足必填类型（sdk 插件才用）
    userPluginsRoot: "D:/unused-user-plugins",
  };
  // setup 为 KikoPlugin 可选钩子（工厂实现必定义），可选调用即可满足类型
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
  it("未经 setup 直接 handle → 50005 防御（host 协议违例不可达路径）", async () => {
    const plugin = createFilePlugin(); // 干净实例：未 setup
    await expectRpcError(
      plugin.handle("file.read", { path: "a.txt" }, makeCtx().ctx),
      ERROR_CODES.PLUGIN_UNAVAILABLE,
    );
  });

  it("未知能力 id → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("file.delete", {}, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });
});

describe("file.read（读文档目录内文件）", () => {
  it("正常路径：返回 { content, size }", async () => {
    await writeFile(join(documentsDir, "notes.txt"), "hello kiko", "utf-8");
    const plugin = await makePlugin();

    const result = (await plugin.handle("file.read", { path: "notes.txt" }, makeCtx().ctx)) as {
      content: string;
      size: number;
    };

    expect(result.content).toBe("hello kiko");
    expect(result.size).toBe(10);
  });

  it("子目录路径：documentsDir/sub/a.txt 可读", async () => {
    await mkdir(join(documentsDir, "sub"));
    await writeFile(join(documentsDir, "sub", "a.txt"), "abc", "utf-8");
    const plugin = await makePlugin();

    const result = (await plugin.handle("file.read", { path: "sub/a.txt" }, makeCtx().ctx)) as {
      content: string;
      size: number;
    };

    expect(result).toEqual({ content: "abc", size: 3 });
  });

  it("越界：../ 逃出文档目录 → 50001", async () => {
    // 在 documentsDir 之外放一个文件（workspace 目录作为越界目标）
    await writeFile(join(workspaceRoot, "secret.txt"), "x", "utf-8");
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("file.read", { path: "../../../tmp/secret.txt" }, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("越界：绝对路径指向文档目录外 → 50001（工作空间文件不可读）", async () => {
    await writeFile(join(workspaceRoot, "ws-only.txt"), "x", "utf-8");
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("file.read", { path: join(workspaceRoot, "ws-only.txt") }, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("文件不存在 → 50001（IO 错误包装）", async () => {
    const plugin = await makePlugin();
    const err = await expectRpcError(
      plugin.handle("file.read", { path: "ghost.txt" }, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(err.message).toContain("ghost.txt");
  });

  it("目标是目录 → 50001", async () => {
    await mkdir(join(documentsDir, "folder"));
    const plugin = await makePlugin();
    await expectRpcError(plugin.handle("file.read", { path: "folder" }, makeCtx().ctx), 50001);
  });
});

describe("file.write（写工作空间内文件，覆盖语义）", () => {
  it("正常路径：落盘 + register 登记 + 返回 { path, size }", async () => {
    const plugin = await makePlugin();
    const { ctx, registered } = makeCtx();

    const result = (await plugin.handle(
      "file.write",
      { path: "file/notes.txt", content: "你好 kiko" },
      ctx,
    )) as { path: string; size: number };

    // 落盘内容正确（父目录 file/ 自动创建）
    expect(await readFile(join(workspaceRoot, "file", "notes.txt"), "utf-8")).toBe("你好 kiko");
    // 返回相对路径（正斜杠）与字节数
    expect(result.path).toBe("file/notes.txt");
    expect(result.size).toBe(Buffer.byteLength("你好 kiko", "utf-8"));
    // register 恰好一次：绝对路径 + 纯文件名 + MIME + 字节数
    expect(registered).toEqual([
      {
        file: join(workspaceRoot, "file", "notes.txt"),
        filename: "notes.txt",
        mime_type: "text/plain",
        size: Buffer.byteLength("你好 kiko", "utf-8"),
      },
    ]);
  });

  it("覆盖语义：同一路径二次写入直接覆盖（不自动改名），register 每次登记", async () => {
    const plugin = await makePlugin();
    const { ctx, registered } = makeCtx();

    await plugin.handle("file.write", { path: "a.txt", content: "first" }, ctx);
    await plugin.handle("file.write", { path: "a.txt", content: "second" }, ctx);

    expect(await readFile(join(workspaceRoot, "a.txt"), "utf-8")).toBe("second");
    expect(registered).toHaveLength(2);
  });

  it("深层子目录自动创建", async () => {
    const plugin = await makePlugin();
    await plugin.handle("file.write", { path: "x/y/z/deep.txt", content: "d" }, makeCtx().ctx);
    expect(await readFile(join(workspaceRoot, "x", "y", "z", "deep.txt"), "utf-8")).toBe("d");
  });

  it("MIME 推断：.md → text/markdown；无扩展名 → application/octet-stream", async () => {
    const plugin = await makePlugin();
    const md = makeCtx();
    await plugin.handle("file.write", { path: "a.md", content: "x" }, md.ctx);
    const bare = makeCtx();
    await plugin.handle("file.write", { path: "noext", content: "x" }, bare.ctx);

    expect(md.registered[0]?.mime_type).toBe("text/markdown");
    expect(bare.registered[0]?.mime_type).toBe("application/octet-stream");
  });

  it("越界：../ 逃出工作空间 → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("file.write", { path: "../../escape.txt", content: "x" }, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("越界：绝对路径指向工作空间外 → 50001（documentsDir 不可写）", async () => {
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle(
        "file.write",
        { path: join(documentsDir, "docs-file.txt"), content: "x" },
        makeCtx().ctx,
      ),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });
});

describe("file.list（列文档目录内容）", () => {
  /** 预置目录结构：docs/{ b.txt, sub/{ c.txt } , a-dir/ } */
  async function seed(): Promise<void> {
    await writeFile(join(documentsDir, "b.txt"), "12345", "utf-8");
    await mkdir(join(documentsDir, "a-dir"));
    await mkdir(join(documentsDir, "sub"));
    await writeFile(join(documentsDir, "sub", "c.txt"), "ab", "utf-8");
  }

  it("非递归：目录在前排序，name 为条目名，size 正确", async () => {
    await seed();
    const plugin = await makePlugin();

    const result = (await plugin.handle("file.list", {}, makeCtx().ctx)) as {
      entries: Array<{ name: string; is_dir: boolean; size: number }>;
    };

    // 排序约定：目录在前、同组内按名字典序
    expect(result.entries).toEqual([
      { name: "a-dir", is_dir: true, size: 0 },
      { name: "sub", is_dir: true, size: 0 },
      { name: "b.txt", is_dir: false, size: 5 },
    ]);
  });

  it("递归：子目录条目带相对路径（正斜杠前缀）", async () => {
    await seed();
    const plugin = await makePlugin();

    const result = (await plugin.handle("file.list", { recursive: true }, makeCtx().ctx)) as {
      entries: Array<{ name: string; is_dir: boolean; size: number }>;
    };

    const names = result.entries.map((e) => e.name);
    expect(names).toContain("sub/c.txt");
    expect(names).toContain("a-dir");
    expect(names).not.toContain("c.txt"); // 递归模式下子目录文件带前缀
    const c = result.entries.find((e) => e.name === "sub/c.txt");
    expect(c).toEqual({ name: "sub/c.txt", is_dir: false, size: 2 });
  });

  it("path 缺省列文档目录根；显式子目录路径亦可", async () => {
    await seed();
    const plugin = await makePlugin();

    const sub = (await plugin.handle("file.list", { path: "sub" }, makeCtx().ctx)) as {
      entries: Array<{ name: string }>;
    };
    expect(sub.entries.map((e) => e.name)).toEqual(["c.txt"]);

    const root = (await plugin.handle("file.list", {}, makeCtx().ctx)) as {
      entries: Array<{ name: string }>;
    };
    expect(root.entries.map((e) => e.name)).toContain("sub");
  });

  it("越界：../ 逃出文档目录 → 50001", async () => {
    const plugin = await makePlugin();
    await expectRpcError(plugin.handle("file.list", { path: "../" }, makeCtx().ctx), 50001);
  });

  it("目录不存在 → 50001（IO 错误包装）", async () => {
    const plugin = await makePlugin();
    await expectRpcError(plugin.handle("file.list", { path: "ghost" }, makeCtx().ctx), 50001);
  });

  it("目标是文件（非目录）→ 50001", async () => {
    await writeFile(join(documentsDir, "plain.txt"), "x", "utf-8");
    const plugin = await makePlugin();
    await expectRpcError(
      plugin.handle("file.list", { path: "plain.txt" }, makeCtx().ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });
});
