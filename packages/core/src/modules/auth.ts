/**
 * access_token 生成与持久化（设计文档 5.1 M2 鉴权 / 7.4.1 settings.json）
 *
 * 5.1 原文："首次启动生成 access_token 持久化到配置"。
 * 配置载体为 userData 的 settings.json（与工作空间根目录位置同文件，
 * 7.4.1），写入策略为读-改-写（保留文件内其他字段，不整体覆写）。
 *
 * 纯 Node 实现（node:fs / node:crypto），不依赖 Electron——
 * settings.json 路径由宿主（headless / M2-06 Electron 壳）注入。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** settings.json 中 access_token 的字段名（唯一权威来源） */
export const ACCESS_TOKEN_KEY = "access_token";

/** token 长度（hex 编码后 64 字符；32 字节熵） */
const TOKEN_BYTES = 32;

/** settings.json 的已知形状（未知字段经读-改-写保留） */
interface SettingsFile {
  [key: string]: unknown;
}

/**
 * 加载（或首次生成）access_token。
 *
 * 行为：
 *   - 文件不存在 / 无 access_token 字段 → 生成 32 字节随机 hex 并写回
 *     （保留文件内其他字段；父目录不存在则创建）
 *   - 已有 access_token → 原样返回（重启 token 稳定，客户端免重新配置）
 *
 * @param settingsPath settings.json 绝对路径（宿主注入）
 * @returns 生效的 access_token
 * @throws settings.json 存在但不是合法 JSON 时抛 SyntaxError（外部干预
 *         产生的损坏配置应快死暴露，静默覆写会丢失用户其他设置）
 */
export function loadOrCreateAccessToken(settingsPath: string): string {
  let settings: SettingsFile = {};
  if (existsSync(settingsPath)) {
    // 损坏 JSON 让 JSON.parse 自然抛 SyntaxError（快死策略，见函数注释）
    settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as SettingsFile;
  }

  const existing = settings[ACCESS_TOKEN_KEY];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  // 首次生成：32 字节熵 → 64 字符 hex（本地单机鉴权，足够不可猜测）
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  settings[ACCESS_TOKEN_KEY] = token;

  // 读-改-写：保留其他字段；写失败（目录缺失 / 权限）向上抛（快死）
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return token;
}
