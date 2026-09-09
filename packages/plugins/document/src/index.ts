/**
 * @kiko-workbench/plugin-document —— Document 内置插件（设计文档 8.3 / 8.6 / ADR-006）
 *
 * 能力清单：
 *   - document.create —— Markdown 子集 → docx 落盘工作空间
 *       输入 { content, filename, format? } → 输出 { file, filename, mime_type }
 *       产物经 ctx.artifacts.save 落盘（workspace/document/ 子目录，
 *       同名冲突自动追加序号 "(2)" 递增，永不覆盖——7.4.2）
 *
 * R2 风险应对：docx 中文渲染异常（字体回退）——每个 TextRun 显式设置
 * 四槽字体（ascii/eastAsia/hAnsi/cs = 微软雅黑），不依赖 Word 字体回退。
 *
 * 插件只依赖 plugin-sdk + docx（第 4 节依赖约束），零 electron / core。
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import {
  ERROR_CODES,
  RpcError,
  type ArtifactInfo,
  type InvocationContext,
  type KikoPlugin,
} from "@kiko-workbench/plugin-sdk";
import { parseMarkdown, type Block, type InlineRun } from "./markdown.js";

/** docx MIME（设计文档 5.3.4 示例同款全称） */
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** 东亚字体（R2）：微软雅黑——Windows 默认中文字体，显式声明防回退 */
const EAST_ASIA_FONT = "Microsoft YaHei";

/** 有序列表 numbering 引用名（Document config 与段落引用配对，常量防拼错） */
const ORDERED_LIST_REF = "kiko-ordered-list";

/**
 * 显式四槽字体（R2 锚点）：ascii/hAnsi 管西文、eastAsia 管中日韩、cs 管复杂
 * 文字——全部指向同一字体，中文渲染不依赖 Word 回退链。
 */
export function runFont(): { ascii: string; eastAsia: string; hAnsi: string; cs: string } {
  return {
    ascii: EAST_ASIA_FONT,
    eastAsia: EAST_ASIA_FONT,
    hAnsi: EAST_ASIA_FONT,
    cs: EAST_ASIA_FONT,
  };
}

/** 字号表（docx 半点单位：size = pt × 2；正文取中文五号 10.5pt） */
const SIZE_BY_LEVEL: Record<1 | 2 | 3, number> = { 1: 32, 2: 26, 3: 24 };
const BODY_SIZE = 21;

/**
 * InlineRun → TextRun 构造参数（导出供 R2 单测锚定：任一样式组合的
 * run 均携带显式四槽东亚字体）。
 */
export function toRunOptions(
  run: InlineRun,
  extra: { size: number; bold?: boolean; color?: string } = { size: BODY_SIZE },
): {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  color: string;
  font: ReturnType<typeof runFont>;
} {
  return {
    text: run.text,
    bold: extra.bold === true || run.bold === true,
    italic: run.italic === true,
    size: extra.size,
    color: extra.color ?? "000000",
    font: runFont(),
  };
}

/** AST → docx 段落数组（标题 / 段落 / 有序与无序列表） */
function buildParagraphs(blocks: Block[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const level = block.level;
        paragraphs.push(
          new Paragraph({
            // heading 样式保留大纲级别（Word 导航窗格可用）；字体/字号/颜色
            // 在 run 层显式覆盖（heading 默认主题字体不含东亚槽位，R2）
            heading:
              level === 1
                ? HeadingLevel.HEADING_1
                : level === 2
                  ? HeadingLevel.HEADING_2
                  : HeadingLevel.HEADING_3,
            children: block.runs.map(
              (r) =>
                new TextRun(
                  toRunOptions(r, {
                    size: SIZE_BY_LEVEL[level],
                    bold: true,
                  }),
                ),
            ),
          }),
        );
        break;
      }
      case "paragraph": {
        paragraphs.push(
          new Paragraph({
            children: block.runs.map((r) => new TextRun(toRunOptions(r))),
          }),
        );
        break;
      }
      case "list": {
        for (const item of block.items) {
          paragraphs.push(
            new Paragraph({
              // 有序：numbering 引用 Document config；无序：内置 bullet
              ...(block.ordered
                ? { numbering: { reference: ORDERED_LIST_REF, level: 0 } }
                : { bullet: { level: 0 } }),
              children: item.map((r) => new TextRun(toRunOptions(r))),
            }),
          );
        }
        break;
      }
    }
  }
  return paragraphs;
}

/** AST → docx Document（含有序列表编号定义） */
export function buildDocument(blocks: Block[]): Document {
  return new Document({
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [{ children: buildParagraphs(blocks) }],
  });
}

/** document.create 输入形状（ajv 在主进程校验，此处类型收窄用） */
interface CreateInput {
  content: string;
  filename: string;
  format?: string;
}

/**
 * Document 插件工厂：返回全新 KikoPlugin 实例（内部状态闭包隔离）。
 * 无 setup 依赖（落盘走 ctx.artifacts.save，无需 documentsDir 基座）。
 */
export function createDocumentPlugin(): KikoPlugin {
  return {
    /** 能力执行入口：仅支持 document.create */
    async handle(capabilityId: string, input: unknown, ctx: InvocationContext): Promise<unknown> {
      if (capabilityId !== "document.create") {
        throw new RpcError(
          ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          `document 插件不支持能力：${capabilityId}`,
        );
      }
      const params = input as CreateInput;
      // 防御：format 枚举由 ajv 挡在主进程（40002），绕过协议直接调用时兜底
      if (params.format !== undefined && params.format !== "docx") {
        throw new RpcError(
          ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          `不支持的文档格式：${params.format}（M2 仅支持 docx，ADR-006）`,
        );
      }

      // 1. 解析（progress 链路是 M2-03 事件推送的真实消费场景）
      ctx.progress(20, "解析 Markdown");
      const blocks = parseMarkdown(params.content);

      // 2. 构建 docx（AST → Document → zip Buffer）
      ctx.progress(50, `生成 docx（${blocks.length} 块）`);
      let buffer: Buffer;
      try {
        buffer = await Packer.toBuffer(buildDocument(blocks));
      } catch (e) {
        // docx 构建异常（AST 异常形状等理论场景）统一 50001
        throw new RpcError(
          ERROR_CODES.PLUGIN_EXECUTION_ERROR,
          `docx 生成失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // 3. 落盘工作空间（ctx.artifacts.save 唯一合法入口：路径校验 +
      //    同名自动改名 + artifact 上报登记，7.4.2——不覆盖首份）
      ctx.progress(80, "写入工作空间");
      const info: ArtifactInfo = await ctx.artifacts.save(params.filename, buffer, DOCX_MIME);
      ctx.progress(100, "完成");
      return { file: info.file, filename: info.filename, mime_type: info.mime_type };
    },
  };
}

// host 经 manifest.entry 动态加载：default 导出插件单例
//（CJS 互兼容由 host 的 extractPlugin 处理，ESM 侧直接 default）
export default createDocumentPlugin();
