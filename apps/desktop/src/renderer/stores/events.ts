/**
 * 实时事件 store（模块级单例）
 *
 * 原语义保持：固定容量滚动缓冲（最新在前，最多 50 条防长跑内存膨胀）。
 * 订阅常驻 App.vue（页面切换不影响滚动更新——"常驻滚动，永不积压"）。
 */
import { ref } from "vue";

/** 实时事件条目（invocation_id 截断 8 位展示） */
export interface LiveEvent {
  event: string;
  invocation_id: string;
  timestamp: string;
}

/** 缓冲容量上限（防事件风暴内存膨胀；旧事件滚动覆盖） */
const EVENT_BUFFER_MAX = 50;

/** 实时事件缓冲（最新在前） */
export const events = ref<LiveEvent[]>([]);

/** 订阅回调入口：unshift + 截断（O(1) 滚动，无论后台事件量级） */
export function pushEvent(ev: LiveEvent): void {
  events.value.unshift(ev);
  if (events.value.length > EVENT_BUFFER_MAX) events.value.length = EVENT_BUFFER_MAX;
}
