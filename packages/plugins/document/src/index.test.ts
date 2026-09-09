/**
 * document 插件单测（M2-05 验收锚点）
 *
 * 验收锚点（任务清单 M2-05 / 设计文档 8.3 / R2）：
 *   - 正常路径：Markdown → docx Buffer（合法 zip：PK 魔数）→
 *     ctx.artifacts.save 落盘 → 返回 { file, filename, mime_type }
 *   - R2：任一样式 run 显式四槽东亚字体（ascii/eastAsia/hAnsi/cs）
 *   - progress 上报链路（M2-03 事件推送的真实消费场景）
 *   - 防御：未知能力 / format 非 docx → 50001
 *
 * 落盘冲突改名语义（(2) 递增）属 host saveArtifact（paths.test 已覆盖），
 * 此处仅断言插件把 filename 原样交予 save、返回值来自 save 的登记信息。
 */
import { describe, expect, it } from "vitest";
import { createDocumentPlugin, runFont, toRunOptions } from "./index.js";
import {
  ERROR_CODES,
  RpcError,
  type ArtifactInfo,
  type InvocationContext,
} from "@kiko-workbench/plugin-sdk";

/** fake InvocationContext：artifacts.save 捕获调用并返回可控登记信息 */
function makeCtx() {
  const progresses: Array<{ percent: number; message?: string }> = [];
  const saves: Array<{ filename: string; data: Buffer; mime_type?: string }> = [];
  /** save 返回的登记信息（可按用例覆写 finalFilename 模拟冲突改名） */
  let saveResult: ArtifactInfo = {
    file: "D:/ws/document/青岛旅行计划.docx",
    relative_path: "document/青岛旅行计划.docx",
    filename: "青岛旅行计划.docx",
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 1024,
  };
  const ctx: InvocationContext = {
    progress: (percent, message) => {
      progresses.push(message === undefined ? { percent } : { percent, message });
    },
    log: () => undefined,
    isCancelled: () => false,
    artifacts: {
      save: async (filename, data, mime_type) => {
        saves.push({ filename, data, mime_type });
        return saveResult;
      },
      register: () => {
        throw new Error("document 插件不应调用 artifacts.register（统一走 save）");
      },
    },
  };
  return {
    ctx,
    progresses,
    saves,
    setSaveResult: (info: ArtifactInfo) => {
      saveResult = info;
    },
  };
}

/** 断言 promise 抛 RpcError 且 code 匹配 */
async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
  throw new Error("预期抛出 RpcError，实际未抛出");
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("document.create（M2-05 主链路）", () => {
  it("Markdown → docx Buffer（合法 zip）→ save 落盘 → 返回登记信息", async () => {
    const plugin = createDocumentPlugin();
    const { ctx, saves } = makeCtx();
    const result = (await plugin.handle(
      "document.create",
      {
        content: "# 青岛三日旅行计划\n\n行程安排。\n\n1. 栈桥\n2. 崂山\n",
        filename: "青岛旅行计划.docx",
      },
      ctx,
    )) as { file: string; filename: string; mime_type: string };

    // save 恰好一次：filename 原样交予 host（冲突改名是 host 职责）
    expect(saves).toHaveLength(1);
    expect(saves[0]?.filename).toBe("青岛旅行计划.docx");
    expect(saves[0]?.mime_type).toBe(DOCX_MIME);
    // Buffer 合法 zip（docx = zip 包，魔数 PK\x03\x04）且非空
    expect(saves[0]?.data.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(saves[0]?.data.length ?? 0).toBeGreaterThan(1000);

    // 返回值 = save 的登记信息直通（file/filename/mime_type 三字段）
    expect(result).toEqual({
      file: "D:/ws/document/青岛旅行计划.docx",
      filename: "青岛旅行计划.docx",
      mime_type: DOCX_MIME,
    });
  });

  it("progress 上报：解析 → 生成 → 写入 → 完成（percent 单调递增）", async () => {
    const plugin = createDocumentPlugin();
    const { ctx, progresses } = makeCtx();
    await plugin.handle("document.create", { content: "段落", filename: "a.docx" }, ctx);
    const percents = progresses.map((p) => p.percent);
    expect(percents).toEqual([20, 50, 80, 100]);
  });

  it("save 返回改名结果时（同名冲突场景）→ 插件如实透传最终文件名", async () => {
    const plugin = createDocumentPlugin();
    const { ctx, setSaveResult } = makeCtx();
    // host 侧冲突改名的登记结果（(2) 序号由 nextConflictName 生成）
    setSaveResult({
      file: "D:/ws/document/青岛旅行计划 (2).docx",
      relative_path: "document/青岛旅行计划 (2).docx",
      filename: "青岛旅行计划 (2).docx",
      mime_type: DOCX_MIME,
      size: 1024,
    });
    const result = (await plugin.handle(
      "document.create",
      { content: "第二份", filename: "青岛旅行计划.docx" },
      ctx,
    )) as { filename: string };
    expect(result.filename).toBe("青岛旅行计划 (2).docx");
  });

  it("format 缺省 docx；显式 docx 等价（ADR-006 唯一格式）", async () => {
    const plugin = createDocumentPlugin();
    const { ctx } = makeCtx();
    await plugin.handle(
      "document.create",
      { content: "x", filename: "a.docx", format: "docx" },
      ctx,
    );
  });

  it("防御：未知能力 → 50001", async () => {
    const plugin = createDocumentPlugin();
    const { ctx } = makeCtx();
    await expectRpcError(
      plugin.handle("document.convert", { content: "x" }, ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
  });

  it("防御：format 非 docx（绕过 ajv 的直接调用）→ 50001", async () => {
    const plugin = createDocumentPlugin();
    const { ctx } = makeCtx();
    const e = await expectRpcError(
      plugin.handle("document.create", { content: "x", filename: "a.docx", format: "pdf" }, ctx),
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
    );
    expect(e.message).toContain("pdf");
  });
});

describe("R2 锚点：显式东亚字体（中文渲染不依赖字体回退）", () => {
  it("runFont 四槽齐备：ascii / eastAsia / hAnsi / cs 同字体", () => {
    const font = runFont();
    expect(font.eastAsia).toBe("Microsoft YaHei");
    expect(font.ascii).toBe("Microsoft YaHei");
    expect(font.hAnsi).toBe("Microsoft YaHei");
    expect(font.cs).toBe("Microsoft YaHei");
  });

  it("toRunOptions：普通 / 粗体 / 斜体 run 均携带显式东亚字体", () => {
    for (const run of [
      { text: "普通" },
      { text: "粗体", bold: true },
      { text: "斜体", italic: true },
    ]) {
      const options = toRunOptions(run);
      expect(options.font.eastAsia).toBe("Microsoft YaHei");
      expect(options.font.hAnsi).toBe("Microsoft YaHei");
    }
  });

  it("标题 run 继承显式字体与加粗（heading 样式仅控制大纲级别）", () => {
    const options = toRunOptions({ text: "标题" }, { size: 32, bold: true });
    expect(options.bold).toBe(true);
    expect(options.size).toBe(32);
    expect(options.font.eastAsia).toBe("Microsoft YaHei");
  });
});
