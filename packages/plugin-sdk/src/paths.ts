/**
 * 路径安全校验（设计文档 7.4.3：plugin-host 单点实现）
 *
 * 职责：所有插件文件操作的路径必须经 resolveSafe(base, target) 校验——
 * 规范化后必须以 base 为前缀，防 `..` 注入、绝对路径注入、越界。
 * 越界抛 RpcError(50001)。
 *
 * 同时提供产物文件名安全化与同名冲突序号生成（设计文档 7.4.2）：
 *   - safeFilename：纯文件名校验（禁止路径分隔符与 ".."）
 *   - nextConflictName：青岛旅行计划.docx → 青岛旅行计划 (2).docx → (3)…
 */
import { resolve, dirname, sep } from "node:path";
import { ERROR_CODES, RpcError } from "@kiko-workbench/protocol";

/**
 * 解析并校验 target 位于 base 目录内（含 base 本身）。
 * target 允许是相对路径（相对 base）或绝对路径（必须落在 base 下）。
 * 返回规范化后的绝对路径；越界抛 RpcError(50001)。
 */
export function resolveSafe(base: string, target: string): string {
  // base 自身先规范化（消除尾部分隔符差异、.. 等）
  const normalizedBase = resolve(base);
  // target 相对 base 解析为绝对路径（绝对 target 直接规范化）
  const resolved = resolve(normalizedBase, target);
  // 前缀判定：resolved 必须等于 base 或位于 base + sep 之下
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + sep)) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `路径越界：${target} 不在允许目录 ${normalizedBase} 内`,
    );
  }
  return resolved;
}

/**
 * 校验产物文件名为纯文件名（无目录部分、无 ".."）。
 * 返回去空白后的文件名；非法抛 RpcError(50001)。
 */
export function safeFilename(filename: string): string {
  const trimmed = filename.trim();
  // 含路径分隔符（/ 或 \）或为空 → 拒绝；"." / ".." 保留名 → 拒绝
  if (
    trimmed.length === 0 ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new RpcError(
      ERROR_CODES.PLUGIN_EXECUTION_ERROR,
      `非法产物文件名：${filename}（仅允许纯文件名）`,
    );
  }
  return trimmed;
}

/**
 * 生成同名冲突文件名：存在 name.ext 时返回 "name (2).ext"；
 * 再冲突则 (3)、(4)…（设计文档 7.4.2，永不静默覆盖）。
 * exists：同步存在性检查（fs.existsSync 或测试注入）。
 */
export function nextConflictName(original: string, exists: (name: string) => boolean): string {
  // 无冲突直接返回原名
  if (!exists(original)) return original;
  // 拆分扩展名：取最后一个 "." 且不在首位（无扩展名文件 → ext 为空）
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : "";
  // 序号递增探测，从 2 开始；上限防御（避免异常场景死循环）
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new RpcError(ERROR_CODES.PLUGIN_EXECUTION_ERROR, `同名产物序号探测超限：${original}`);
}

/** 仅供测试使用的辅助：取 dirname（避免在非测试代码中引用本导出） */
export const _internal = { dirname };
