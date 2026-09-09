<script setup lang="ts">
/**
 * 调用历史面板（原 App.vue 历史区块 + Trace 面板原样迁移）
 *
 * KeepAlive 生命周期钩子维护 traceLive 守卫：失活时挂起事件驱动的
 * Trace 重拉（无效 IPC 往返）；激活时补一次刷新（失活期间错过的事件
 * 造成的差异立即对齐）。
 */
import { onActivated, onDeactivated } from "vue";
import {
  applyFilters,
  capabilityFilter,
  clearHistory,
  clearingHistory,
  confirmingClearHistory,
  hasMore,
  historyError,
  historyLoading,
  historyNotice,
  invocations,
  loadMore,
  openArtifact,
  openingArtifact,
  selectInvocation,
  statusFilter,
  todayOnly,
  trace,
  traceError,
  traceLoading,
  traceLive,
} from "../stores/history.js";
import { artifactSizeText, durationText, eventSummary, jsonText, timeText } from "../format.js";

// KeepAlive 生命周期：traceLive 守卫维护（失活挂起事件驱动重拉 / 激活补刷新）
onActivated(() => {
  traceLive.value = true;
});
onDeactivated(() => {
  traceLive.value = false;
});
</script>

<template>
  <section class="page-panel">
    <div class="block-head">
      <h2>调用历史</h2>
      <!-- 清空入口：仅清终态记录（运行中保留），两步确认防误清 -->
      <button
        v-if="!confirmingClearHistory"
        class="head-btn"
        :disabled="clearingHistory"
        @click="confirmingClearHistory = true"
      >
        清空历史
      </button>
      <div v-else class="head-confirm">
        <button class="plugin-btn danger solid" :disabled="clearingHistory" @click="clearHistory">
          确认清空
        </button>
        <button
          class="plugin-btn"
          :disabled="clearingHistory"
          @click="confirmingClearHistory = false"
        >
          取消
        </button>
      </div>
    </div>

    <!-- 筛选栏（M2-08：状态 / 能力子串 / 仅今天；变化即回第一页重查） -->
    <div class="history-toolbar">
      <select v-model="statusFilter" class="history-select" @change="applyFilters">
        <option value="">全部状态</option>
        <option value="pending">pending</option>
        <option value="running">running</option>
        <option value="completed">completed</option>
        <option value="failed">failed</option>
        <option value="cancelled">cancelled</option>
      </select>
      <input
        v-model="capabilityFilter"
        class="history-input"
        type="text"
        placeholder="能力关键字（回车筛选）"
        @change="applyFilters"
      />
      <label class="history-today">
        <input v-model="todayOnly" type="checkbox" @change="applyFilters" />
        <span>仅今天</span>
      </label>
      <span v-if="historyLoading" class="history-hint">加载中</span>
    </div>

    <p v-if="historyError !== null" class="action-error">{{ historyError }}</p>
    <p v-if="historyNotice !== null" class="action-notice">{{ historyNotice }}</p>

    <p v-if="!historyLoading && invocations.length === 0" class="empty">
      {{
        statusFilter !== "" || capabilityFilter.trim() !== "" || todayOnly
          ? "无匹配记录"
          : "暂无调用记录"
      }}
    </p>

    <table v-if="invocations.length > 0" class="invocation-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>能力</th>
          <th>状态</th>
          <th>耗时</th>
          <th>产物</th>
        </tr>
      </thead>
      <tbody>
        <!-- 行点击展开 Trace（同行再点收起）；选中行左侧深色边条指示 -->
        <tr
          v-for="item in invocations"
          :key="item.invocation_id"
          :class="{ selected: trace?.invocation_id === item.invocation_id }"
          class="invocation-row"
          @click="selectInvocation(item)"
        >
          <td>{{ timeText(item.created_at) }}</td>
          <td>{{ item.capability_id }}</td>
          <td>
            <span class="status-dot" :data-invocation="item.status"></span>
            {{ item.status }}
          </td>
          <td>{{ durationText(item) }}</td>
          <td>{{ item.artifact_count > 0 ? item.artifact_count : "-" }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 分页加载（has_more 由存储层 limit+1 探测驱动） -->
    <button v-if="hasMore" class="load-more" :disabled="historyLoading" @click="loadMore">
      加载更多
    </button>

    <!-- Execution Trace 面板（选中行下方展开） -->
    <div v-if="traceLoading" class="trace-panel trace-hint">Trace 加载中</div>
    <div v-else-if="traceError !== null" class="trace-panel trace-hint">
      Trace 拉取失败：{{ traceError }}
    </div>
    <div v-else-if="trace !== null" class="trace-panel">
      <div class="trace-head">
        <span class="trace-capability">{{ trace.capability_id }}</span>
        <span class="status-dot" :data-invocation="trace.status"></span>
        <span class="trace-status">{{ trace.status }}</span>
        <span class="trace-meta">{{ trace.mode }} · {{ timeText(trace.created_at) }}</span>
        <span class="trace-id">{{ trace.invocation_id.slice(0, 12) }}</span>
      </div>

      <div class="trace-section">
        <h3>事件时间线</h3>
        <ul v-if="(trace.events ?? []).length > 0" class="trace-events">
          <li v-for="(ev, i) in trace.events ?? []" :key="i">
            <span class="event-time">{{ timeText(ev.timestamp) }}</span>
            <span class="event-type">{{ ev.event }}</span>
            <span class="event-data">{{ eventSummary(ev) }}</span>
          </li>
        </ul>
        <p v-else class="empty">无事件</p>
      </div>

      <div class="trace-section">
        <h3>日志</h3>
        <ul v-if="(trace.logs ?? []).length > 0" class="trace-logs">
          <li v-for="(log, i) in trace.logs ?? []" :key="i">
            <span class="event-time">{{ timeText(log.timestamp) }}</span>
            <span class="log-message">{{ log.message }}</span>
          </li>
        </ul>
        <p v-else class="empty">无执行日志</p>
      </div>

      <div class="trace-section">
        <h3>Result</h3>
        <pre v-if="trace.result !== undefined && trace.result !== null" class="trace-json">{{
          jsonText(trace.result)
        }}</pre>
        <p v-else class="empty">无结果数据（未完成或失败）</p>
      </div>

      <div v-if="trace.error != null" class="trace-section">
        <h3>Error</h3>
        <pre class="trace-json">{{ jsonText(trace.error) }}</pre>
      </div>

      <div class="trace-section">
        <h3>产物（{{ (trace.artifacts ?? []).length }}）</h3>
        <ul v-if="(trace.artifacts ?? []).length > 0" class="trace-artifacts">
          <li v-for="a in trace.artifacts ?? []" :key="a.file" class="artifact-item">
            <span class="artifact-name">{{ a.filename }}</span>
            <span class="artifact-size">{{ artifactSizeText(a.size) }}</span>
            <button
              class="artifact-open"
              :disabled="openingArtifact !== null"
              @click="openArtifact(a)"
            >
              打开所在文件夹
            </button>
          </li>
        </ul>
        <p v-else class="empty">无产物</p>
      </div>
    </div>
  </section>
</template>
