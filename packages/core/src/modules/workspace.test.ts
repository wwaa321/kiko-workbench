/**
 * WorkspaceManager 单测（M1-08 验收锚点）
 *
 * 验收标准（任务清单 M1-08，对照设计文档 6.7 / 7.4）：
 *   - documents 路径注入式设计：注入临时目录即可单测（core 零 electron import）
 *   - 默认工作空间根目录 <documents>/Kiko Workbench/（7.4.1）
 *   - pluginArtifactDir 按 plugin_id 归档，非法 id 全拒
 *   - validateArtifactPath 越界全拒（documents 根 / 相似前缀 / .. 注入 / 空间根本身）
 *
 * 本模块纯路径运算零 fs 副作用，测试用临时目录风格的绝对路径即可，无需真实落盘。
 */
import { describe, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { ERROR_CODES, RpcError } from "@kiko-workbench/protocol";
import { DEFAULT_WORKSPACE_DIR_NAME, WorkspaceManager } from "./workspace.js";

/** 每个用例独立的伪文档目录（无需真实创建——纯路径运算不触盘） */
function docs(caseName: string): string {
  return join(tmpdir(), "kiko-ws-test", caseName);
}

/** 断言抛出 RpcError 且 code 为 50001 */
function expectPathViolation(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("应当抛出 RpcError(50001)");
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(ERROR_CODES.PLUGIN_EXECUTION_ERROR);
  }
}

describe("构造与根目录维护（6.7）", () => {
  it("documentsDir 注入 + 默认工作空间根目录 <documents>/Kiko Workbench/（7.4.1）", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("default") });
    expect(ws.documentsDir).toBe(resolve(docs("default")));
    expect(ws.workspaceRoot).toBe(join(resolve(docs("default")), DEFAULT_WORKSPACE_DIR_NAME));
  });

  it("workspaceRoot 显式覆写优先（测试注入 / M2 settings.json 读取路径）", () => {
    const custom = join(docs("custom-parent"), "my-workspace");
    const ws = new WorkspaceManager({ documentsDir: docs("custom"), workspaceRoot: custom });
    expect(ws.workspaceRoot).toBe(resolve(custom));
  });

  it("构造期路径规范化：尾分隔符 / .. 段消除", () => {
    // 拼入杂质段与尾分隔符，构造后应为干净绝对路径
    const dirty = join(docs("normalize"), "sub", "..") + sep;
    const ws = new WorkspaceManager({ documentsDir: dirty });
    expect(ws.documentsDir).toBe(resolve(dirty));
    expect(ws.documentsDir.endsWith(sep)).toBe(false);
    expect(ws.documentsDir).toBe(resolve(docs("normalize")));
  });
});

describe("pluginArtifactDir（7.4.1 按插件 id 归档）", () => {
  it("正常解析：workspace/<plugin_id>/", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("artifact-dir") });
    expect(ws.pluginArtifactDir("file")).toBe(join(ws.workspaceRoot, "file"));
    expect(ws.pluginArtifactDir("document")).toBe(join(ws.workspaceRoot, "document"));
  });

  it("含点子串的合法目录名放行（a..b 非 .. 穿越）", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("dotted") });
    expect(ws.pluginArtifactDir("a..b")).toBe(join(ws.workspaceRoot, "a..b"));
  });

  it("非法 pluginId 全拒（50001）：空 / . / .. / 路径分隔符 / .. 注入", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("bad-ids") });
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil", ".."]) {
      expectPathViolation(() => ws.pluginArtifactDir(bad));
    }
  });
});

describe("validateArtifactPath（6.7 M1：路径解析与校验）", () => {
  it("工作空间内绝对路径 → 规范化 file + 正斜杠 relative_path", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("valid") });
    const r = ws.validateArtifactPath(join(ws.workspaceRoot, "file", "notes.txt"));
    expect(r.file).toBe(join(ws.workspaceRoot, "file", "notes.txt"));
    expect(r.relative_path).toBe("file/notes.txt");
  });

  it("嵌套子目录保留层级（file.write 工作空间内任意子目录，7.4.3）", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("deep") });
    const deep = join(ws.workspaceRoot, "a", "b", "c.txt");
    expect(ws.validateArtifactPath(deep).relative_path).toBe("a/b/c.txt");
  });

  it("越界全拒（50001）：documents 根 / 相似前缀兄弟目录 / 系统临时目录", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("outside") });
    // 工作空间的父目录（documents 根）
    expectPathViolation(() => ws.validateArtifactPath(ws.documentsDir));
    // 相似前缀绕过：<documents>/Kiko Workbench-evil/x.txt
    expectPathViolation(() =>
      ws.validateArtifactPath(join(ws.documentsDir, `${DEFAULT_WORKSPACE_DIR_NAME}-evil`, "x.txt")),
    );
    // 系统临时目录（工作空间外任意位置）
    expectPathViolation(() => ws.validateArtifactPath(join(tmpdir(), "escape.txt")));
  });

  it("`..` 注入回逃工作空间 → 50001", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("dotdot") });
    expectPathViolation(() => ws.validateArtifactPath(join(ws.workspaceRoot, "..", "escape.txt")));
    expectPathViolation(() =>
      ws.validateArtifactPath(`${ws.workspaceRoot}${sep}..${sep}..${sep}etc${sep}passwd`),
    );
  });

  it("工作空间根本身不是合法产物路径 → 50001（产物必须是空间内具体文件）", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("root-self") });
    expectPathViolation(() => ws.validateArtifactPath(ws.workspaceRoot));
    // 尾分隔符输入规范化后同上
    expectPathViolation(() => ws.validateArtifactPath(`${ws.workspaceRoot}${sep}`));
  });

  it("相对路径输入按工作空间根解析（与 plugin-sdk resolveSafe 语义对齐）", () => {
    const ws = new WorkspaceManager({ documentsDir: docs("relative") });
    const r = ws.validateArtifactPath(join("file", "notes.txt"));
    expect(r.file).toBe(join(ws.workspaceRoot, "file", "notes.txt"));
    expect(r.relative_path).toBe("file/notes.txt");
    // 相对路径回逃同样拒绝
    expectPathViolation(() => ws.validateArtifactPath(join("..", "escape.txt")));
  });
});
