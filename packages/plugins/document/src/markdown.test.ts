/**
 * Markdown 子集解析器单测（设计文档 8.3 子集定义逐项锁定）
 *
 * 覆盖：
 *   行内：粗体 / 斜体（两种标记）/ 未闭合宽容 / 纯文本
 *   块级：h1-h3 / ####+ 降级段落 / 段落合并（连续行空格连接）/
 *         有序与无序列表 / 列表类型切换分块 / 空行分隔
 */
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.js";

describe("parseInline（行内子集）", () => {
  it("纯文本 → 单普通 run", () => {
    expect(parseInline("青岛三日旅行计划")).toEqual([{ text: "青岛三日旅行计划" }]);
  });

  it("粗体 **text** → bold run", () => {
    expect(parseInline("前置**重点**后置")).toEqual([
      { text: "前置" },
      { text: "重点", bold: true },
      { text: "后置" },
    ]);
  });

  it("斜体 *text* 与 _text_ → italic run", () => {
    expect(parseInline("这是*强调*内容")).toEqual([
      { text: "这是" },
      { text: "强调", italic: true },
      { text: "内容" },
    ]);
    expect(parseInline("这是_强调_内容")).toEqual([
      { text: "这是" },
      { text: "强调", italic: true },
      { text: "内容" },
    ]);
  });

  it("混合粗体 + 斜体（不同片段）", () => {
    expect(parseInline("**粗**和*斜*")).toEqual([
      { text: "粗", bold: true },
      { text: "和" },
      { text: "斜", italic: true },
    ]);
  });

  it("未闭合标记宽容：星号原样保留为普通文本", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }]);
    expect(parseInline("**未闭合")).toEqual([{ text: "**未闭合" }]);
    expect(parseInline("_ lone underscore")).toEqual([{ text: "_ lone underscore" }]);
  });

  it("空标记 ** 不产生空 run（close > i+1 保证）", () => {
    expect(parseInline("****")).toEqual([{ text: "****" }]);
  });
});

describe("parseMarkdown（块级子集）", () => {
  it("标题 h1-h3 各级识别 + 行内样式透传", () => {
    const blocks = parseMarkdown("# 一级\n## 二级\n### 三级 **加粗**");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "一级" }] },
      { kind: "heading", level: 2, runs: [{ text: "二级" }] },
      {
        kind: "heading",
        level: 3,
        runs: [{ text: "三级 " }, { text: "加粗", bold: true }],
      },
    ]);
  });

  it("#### 及以上不支持 → 降级为段落文本（宽容）", () => {
    const blocks = parseMarkdown("#### 四级标题");
    expect(blocks).toEqual([{ kind: "paragraph", runs: [{ text: "#### 四级标题" }] }]);
  });

  it("连续文本行合并为一个段落（空格连接）", () => {
    const blocks = parseMarkdown("第一行\n第二行\n\n第二段");
    expect(blocks).toEqual([
      { kind: "paragraph", runs: [{ text: "第一行 第二行" }] },
      { kind: "paragraph", runs: [{ text: "第二段" }] },
    ]);
  });

  it("无序列表：- 与 * 前缀，连续行合并一个块", () => {
    const blocks = parseMarkdown("- 天一\n- 栈桥\n* 八大关");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ text: "天一" }], [{ text: "栈桥" }], [{ text: "八大关" }]],
      },
    ]);
  });

  it("有序列表：数字前缀，序号不要求连续", () => {
    const blocks = parseMarkdown("1. 第一天\n2. 第二天\n5. 第五天");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [[{ text: "第一天" }], [{ text: "第二天" }], [{ text: "第五天" }]],
      },
    ]);
  });

  it("有序 ↔ 无序切换分块；空行终结列表", () => {
    const blocks = parseMarkdown("- 无序一\n1. 有序一\n2. 有序二\n\n- 新列表");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: [[{ text: "无序一" }]] },
      {
        kind: "list",
        ordered: true,
        items: [[{ text: "有序一" }], [{ text: "有序二" }]],
      },
      { kind: "list", ordered: false, items: [[{ text: "新列表" }]] },
    ]);
  });

  it("列表项后直接跟普通文本行 → 列表中断，文本开新段", () => {
    const blocks = parseMarkdown("- 项目\n接续文本");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: [[{ text: "项目" }]] },
      { kind: "paragraph", runs: [{ text: "接续文本" }] },
    ]);
  });

  it("列表项行内样式解析（粗体/斜体）", () => {
    const blocks = parseMarkdown("- **必去**：栈桥\n- *可选*：极地海洋世界");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ text: "必去", bold: true }, { text: "：栈桥" }],
          [{ text: "可选", italic: true }, { text: "：极地海洋世界" }],
        ],
      },
    ]);
  });

  it("PRD 12 场景形状：标题 + 段落 + 列表混合 + CRLF 容忍", () => {
    const md =
      "# 青岛三日旅行计划\r\n\r\n海滨之城行程安排。\r\n\r\n## 每日安排\r\n1. 第一天 栈桥\r\n2. 第二天 崂山\r\n";
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "heading", "list"]);
    const list = blocks[3] as Extract<BlockKind, { kind: "list" }>;
    expect(list.items).toHaveLength(2);
  });

  it("空内容 → 空块数组", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});

/** 本测试文件内使用的 Block 类型别名（避免重复 import 类型约束） */
type BlockKind = import("./markdown.js").Block;
