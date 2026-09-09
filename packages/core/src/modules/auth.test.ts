/**
 * access_token 生成与持久化单测（M2-02，设计文档 5.1 / 7.4.1）
 *
 * 验收锚点：
 *   - 首次调用生成 token 并写 settings.json（64 字符 hex）
 *   - 二次调用返回同一 token（跨重启稳定，客户端免重新配置）
 *   - 读-改-写保留其他字段（workspace_root 等不丢失）
 *   - 已有 token 的文件不重写（mtime 不变 / 内容字节级不变）
 *   - 损坏 JSON → SyntaxError 快死（静默覆写会丢用户设置）
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAccessToken } from "./auth.js";

let sandbox: string | undefined;

/** 每用例独立沙箱目录（settings.json 路径隔离） */
async function freshSettingsPath(): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), "kiko-auth-test-"));
  return join(sandbox, "settings.json");
}

afterEach(async () => {
  if (sandbox !== undefined) {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    sandbox = undefined;
  }
});

describe("loadOrCreateAccessToken（M2-02）", () => {
  it("文件不存在：生成 64 字符 hex 并写入 settings.json", async () => {
    const path = await freshSettingsPath();
    const token = loadOrCreateAccessToken(path);

    // 32 字节熵 → hex 64 字符（本地单机鉴权的不可猜测性下限）
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // 落盘核对（读-改-写产物包含 access_token 字段）
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["access_token"]).toBe(token);
  });

  it("二次调用返回同一 token（跨重启稳定）", async () => {
    const path = await freshSettingsPath();
    const first = loadOrCreateAccessToken(path);
    const second = loadOrCreateAccessToken(path);
    expect(second).toBe(first);
  });

  it("读-改-写保留其他字段（不整体覆写）", async () => {
    const path = await freshSettingsPath();
    // 预置既有配置（模拟 7.4.1 工作空间根目录位置）
    await writeFile(
      path,
      JSON.stringify({ workspace_root: "D:/custom-ws", theme: "mono" }, null, 2),
      "utf-8",
    );

    loadOrCreateAccessToken(path);

    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    expect(parsed["workspace_root"]).toBe("D:/custom-ws");
    expect(parsed["theme"]).toBe("mono");
    expect(typeof parsed["access_token"]).toBe("string");
  });

  it("已有 token 的文件不重写（内容字节级不变）", async () => {
    const path = await freshSettingsPath();
    loadOrCreateAccessToken(path);
    const before = await readFile(path, "utf-8");

    loadOrCreateAccessToken(path);
    const after = await readFile(path, "utf-8");
    expect(after).toBe(before);
  });

  it("损坏 JSON 抛 SyntaxError（快死，不静默覆写丢设置）", async () => {
    const path = await freshSettingsPath();
    await writeFile(path, "{ not valid json !!", "utf-8");

    expect(() => loadOrCreateAccessToken(path)).toThrow(SyntaxError);
    // 原始内容保留（未发生静默修复性覆写）
    expect(await readFile(path, "utf-8")).toBe("{ not valid json !!");
  });

  it("空串 / 非 string 的 access_token 字段视为缺失（重新生成）", async () => {
    const path = await freshSettingsPath();
    // 空串：外部干预产生的退化值，按缺失处理
    await writeFile(path, JSON.stringify({ access_token: "" }), "utf-8");
    const token = loadOrCreateAccessToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});
