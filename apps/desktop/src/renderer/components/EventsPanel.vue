<script setup lang="ts">
/**
 * 实时事件面板（原 App.vue 事件区块原样迁移）
 *
 * 数据经 events store 滚动缓冲（订阅常驻 App.vue，页面切换不中断）；
 * 本组件纯视图，无生命周期逻辑。
 */
import { events } from "../stores/events.js";
import { timeText } from "../format.js";
</script>

<template>
  <section class="page-panel">
    <h2>实时事件</h2>
    <p v-if="events.length === 0" class="empty">等待事件推送</p>
    <ul v-else class="event-list">
      <li v-for="(ev, i) in events" :key="`${ev.timestamp}-${i}`" class="event-item">
        <span class="event-time">{{ timeText(ev.timestamp) }}</span>
        <span class="event-type">{{ ev.event }}</span>
        <span class="event-invocation">{{ ev.invocation_id }}</span>
      </li>
    </ul>
  </section>
</template>
