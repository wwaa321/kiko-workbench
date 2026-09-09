/**
 * Markdown 子集解析器（设计文档 8.3：M2 明确子集）
 *
 * 支持范围：
 *   块级：标题 h1-h3（#/##/###）、段落（连续文本行合并）、
 *         有序列表（1. 2. …）/ 无序列表（- 或 * 前缀）
 *   行内：粗体（**text**）、斜体（*text* / _text_）
 *
 * 不支持（列 Backlog）：表格、图片、代码块、h4+、粗斜体组合、链接。
 * 不支持的输入按宽容策略处理（视为普通段落文本），不报错。
 */

/** 行内片段：普通 / 粗体 / 斜体三态 */
export interface InlineRun {
  text: string;
  bold?: true;
  italic?: true;
}

/** 块级节点（AST）：标题 / 段落 / 列表 */
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "list"; ordered: boolean; items: InlineRun[][] };

/**
 * 行内解析：`**bold**` 优先，其次 `*italic*` / `_italic_`。
 * 未闭合的标记按普通文本原样保留（宽容，不抛错）。
 */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let plain = ""; // 普通文本累积区
  let i = 0;
  const flush = () => {
    if (plain.length > 0) {
      runs.push({ text: plain });
      plain = "";
    }
  };

  while (i < text.length) {
    // 粗体：**...**（闭合的 ** 存在且内容非空才生效，否则星号原样入普通文本）
    if (text.startsWith("**", i)) {
      const close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        flush();
        runs.push({ text: text.slice(i + 2, close), bold: true });
        i = close + 2;
        continue;
      }
    }
    // 斜体：*text* / _text_（单标记配对）
    const ch = text[i];
    if (ch === "*" || ch === "_") {
      const close = text.indexOf(ch, i + 1);
      if (close > i + 1) {
        flush();
        runs.push({ text: text.slice(i + 1, close), italic: true });
        i = close + 1;
        continue;
      }
    }
    // 普通字符累积（到下一个潜在标记处再 flush）
    plain += ch;
    i += 1;
  }
  flush();
  return runs;
}

/** 标题行匹配：返回级别（1-3），非标题返回 undefined（####+ 不支持 → 段落） */
function headingLevel(line: string): 1 | 2 | 3 | undefined {
  if (line.startsWith("### ")) return 3;
  if (line.startsWith("## ")) return 2;
  if (line.startsWith("# ")) return 1;
  return undefined;
}

/** 列表项匹配：返回 { ordered, text }，非列表行返回 undefined */
function listItem(line: string): { ordered: boolean; text: string } | undefined {
  // 无序：- 或 * 后跟空格（避免与斜体标记混淆——行首场景无歧义）
  const unordered = line.match(/^[-*] (.*)$/);
  if (unordered !== null) return { ordered: false, text: unordered[1] ?? "" };
  // 有序：数字 + 点 + 空格（1. / 12. …）
  const ordered = line.match(/^\d+\. (.*)$/);
  if (ordered !== null) return { ordered: true, text: ordered[1] ?? "" };
  return undefined;
}

/**
 * 块级解析：逐行状态机。
 *   - 空行：结束当前列表（连续性中断）与段落
 *   - 连续文本行合并为一个段落（Markdown 标准语义，空格连接）
 *   - 连续同类型列表行合并为一个列表块；有序/无序混排时类型切换即新块
 */
export function parseMarkdown(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split(/\r?\n/);

  /** 当前正在累积的段落行（非空即累积中） */
  let paragraphLines: string[] = [];
  /** 当前正在累积的列表块（null = 不在列表中） */
  let currentList: { ordered: boolean; items: InlineRun[][] } | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", runs: parseInline(paragraphLines.join(" ")) });
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (currentList !== null) {
      blocks.push({ kind: "list", ordered: currentList.ordered, items: currentList.items });
      currentList = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    // 空行：段落与列表双终结（块间隔）
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = headingLevel(line);
    if (heading !== undefined) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading, runs: parseInline(line.slice(heading + 1)) });
      continue;
    }
    const item = listItem(line);
    if (item !== undefined) {
      flushParagraph();
      // 类型切换（有序 ↔ 无序）视为新列表块
      if (currentList === null || currentList.ordered !== item.ordered) {
        flushList();
        currentList = { ordered: item.ordered, items: [] };
      }
      currentList.items.push(parseInline(item.text));
      continue;
    }
    // 普通文本行：并入当前段落（列表项后直接跟文本 → 列表中断，文本开新段）
    flushList();
    paragraphLines.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}
