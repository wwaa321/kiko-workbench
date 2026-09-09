/**
 * 渲染层共享格式化工具（原 App.vue 单文件内的纯函数）
 *
 * 抽出动机：页面组件拆分后，时间/大小/JSON 展示格式被多个面板共用
 * （事件流 / 历史 / Trace / 产出物），收敛单点避免格式漂移。
 */
import type { ExecutionEvent, InvocationListItem } from "../shared.js";

/** ISO 时间 → 本地时分秒（"HH:mm:ss"，24 小时制） */
export function timeOfDay(d: Date): string {
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * ISO 时间 → 展示文本（事件流 / 历史列表 / Trace 时间线 / 产出物共用）：
 *   - 当天记录：仅时分秒（列宽紧凑，实时事件区绝大多数场景）
 *   - 跨天记录：MM-DD HH:mm:ss（历史/产物翻页到往日条目时日期必须可见）
 *   - 跨年记录：YYYY-MM-DD HH:mm:ss（绝对定位，杜绝歧义）
 */
export function timeText(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return timeOfDay(d);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear()) return `${md} ${timeOfDay(d)}`;
  return `${d.getFullYear()}-${md} ${timeOfDay(d)}`;
}

/** 耗时展示（ms → 秒级缩写） */
export function durationText(item: InvocationListItem): string {
  if (item.duration_ms === undefined) return "-";
  return item.duration_ms >= 1000
    ? `${(item.duration_ms / 1000).toFixed(1)}s`
    : `${item.duration_ms}ms`;
}

/** 字节数 → 人类可读（产物列表展示） */
export function artifactSizeText(size: number): string {
  return size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
}

/** 事件 data 摘要（progress 的 percent/message 等；空 data 返回空串） */
export function eventSummary(ev: ExecutionEvent): string {
  const data = ev.data ?? {};
  const keys = Object.keys(data);
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}=${JSON.stringify(data[k])}`).join(" ");
}

/** JSON 美化（Result / Error 展示；undefined 兜底） */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
