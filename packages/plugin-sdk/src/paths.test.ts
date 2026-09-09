/**
 * 路径安全校验单测（M1-03 / M1-07 验收锚点）
 * 覆盖：`..` 注入、绝对路径越界、Windows 分隔符、同名冲突序号
 */
import { describe, expect, it } from "vitest";
import { nextConflictName, resolveSafe, safeFilename } from "./paths.js";
import { ERROR_CODES, RpcError } from "@kiko-workbench/protocol";

// Windows 环境下测试统一使用 win32 风格路径
const BASE = "D:\\workspace\\kiko";

/** 断言抛出 RpcError 且 code 为 50001 */
function expectPluginError(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("应当抛出 RpcError");
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(ERROR_CODES.PLUGIN_EXECUTION_ERROR);
  }
}

describe("resolveSafe（设计文档 7.4.3）", () => {
  it("base 内相对路径 → 返回规范化绝对路径", () => {
    expect(resolveSafe(BASE, "document\\青岛.docx")).toBe(`${BASE}\\document\\青岛.docx`);
  });

  it("正斜杠分隔符同样接受（规范化为 win32 sep）", () => {
    expect(resolveSafe(BASE, "document/青岛.docx")).toBe(`${BASE}\\document\\青岛.docx`);
  });

  it("target 等于 base 本身 → 允许（file.list 根目录场景）", () => {
    expect(resolveSafe(BASE, ".")).toBe(BASE);
  });

  it("base 内绝对路径 → 允许并规范化", () => {
    expect(resolveSafe(BASE, `${BASE}\\file\\notes.txt`)).toBe(`${BASE}\\file\\notes.txt`);
  });

  it("`..` 注入越界 → RpcError(50001)", () => {
    expectPluginError(() => resolveSafe(BASE, "..\\..\\windows\\system32\\cmd.exe"));
  });

  it("`..` 落回 base 内子目录 → 允许（规范化后仍在界内）", () => {
    expect(resolveSafe(BASE, "document\\..\\file\\a.txt")).toBe(`${BASE}\\file\\a.txt`);
  });

  it("base 外绝对路径 → RpcError(50001)", () => {
    expectPluginError(() => resolveSafe(BASE, "C:\\Users\\secret.txt"));
  });

  it("前缀字符串相似但非真前缀 → RpcError(50001)（防 D:\\workspace\\kiko-evil 绕过）", () => {
    expectPluginError(() => resolveSafe(BASE, "D:\\workspace\\kiko-evil\\x.txt"));
  });
});

describe("safeFilename（产物文件名校验，设计文档 7.4.2）", () => {
  it("合法文件名原样返回（去首尾空白）", () => {
    expect(safeFilename("  青岛旅行计划.docx ")).toBe("青岛旅行计划.docx");
  });

  it.each([
    ["含正斜杠", "a/b.docx"],
    ["含反斜杠", "a\\b.docx"],
    ["空字符串", ""],
    ["纯空白", "   "],
    ["当前目录", "."],
    ["父目录", ".."],
  ])("%s → RpcError(50001)", (_label, filename) => {
    expectPluginError(() => safeFilename(filename));
  });
});

describe("nextConflictName（同名冲突序号，设计文档 7.4.2）", () => {
  it("无冲突 → 返回原名", () => {
    expect(nextConflictName("青岛旅行计划.docx", () => false)).toBe("青岛旅行计划.docx");
  });

  it('一次冲突 → " (2)" 序号', () => {
    const exists = (name: string) => name === "青岛旅行计划.docx";
    expect(nextConflictName("青岛旅行计划.docx", exists)).toBe("青岛旅行计划 (2).docx");
  });

  it("连续冲突 → (2)(3) 递增", () => {
    const taken = new Set(["青岛旅行计划.docx", "青岛旅行计划 (2).docx"]);
    const exists = (name: string) => taken.has(name);
    expect(nextConflictName("青岛旅行计划.docx", exists)).toBe("青岛旅行计划 (3).docx");
  });

  it("无扩展名文件 → 序号直接追加", () => {
    const exists = (name: string) => name === "notes";
    expect(nextConflictName("notes", exists)).toBe("notes (2)");
  });

  it("隐藏文件（点开头，无 stem）→ 不拆分，序号追加整名", () => {
    const exists = (name: string) => name === ".gitignore";
    expect(nextConflictName(".gitignore", exists)).toBe(".gitignore (2)");
  });
});
