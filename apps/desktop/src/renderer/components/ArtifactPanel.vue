<script setup lang="ts">
/**
 * 产出物面板（新增）：跨 invocation 产物归集 + 筛选 + Trace 反查
 *
 * 设计要点：
 *   - 指标卡 / 筛选 / 表格全部分页 SQL 下推（永不全量拉取）
 *   - "打开所在文件夹"复用既有白名单通道（showArtifactInFolder）
 *   - "查看 Trace"跨页反查：切到调用历史页 + selectInvocationById
 *     （替代原"从历史翻产物"的逆路径）
 *   - onActivated/onDeactivated 维护 active 守卫：失活时事件驱动的
 *     刷新退化为轻量 stats 探测（徽标实时，列表等激活再拉）
 */
import { onActivated, onDeactivated, onMounted } from "vue";
import {
  applyArtifactFilters,
  artifactCapFilter,
  artifactCapabilities,
  artifactError,
  artifactHasMore,
  artifactLoading,
  artifactNameFilter,
  artifactPageActive,
  artifactStats,
  artifactTodayOnly,
  artifacts,
  fetchArtifacts,
  loadMoreArtifacts,
} from "../stores/artifacts.js";
import { openArtifact, openingArtifact, selectInvocationById } from "../stores/history.js";
import { activePage } from "../stores/ui.js";
import { artifactSizeText, timeText } from "../format.js";
import type { ArtifactListItem } from "../../shared.js";

/** 行内"打开所在文件夹"（复用历史面板同款处理；错误写入历史区错误面） */
function showInFolder(item: ArtifactListItem): void {
  void openArtifact({ ...item });
}

/**
 * Trace 反查：切到调用历史页并展开该产物的来源调用
 * （跨页导航经 ui store 单例；无 toggle 语义——重复点击保持展开刷新）
 */
function openTrace(item: ArtifactListItem): void {
  activePage.value = "history";
  void selectInvocationById(item.invocation_id);
}

// 首次挂载拉第一页（KeepAlive 失活不卸载，此后由激活钩子/事件驱动刷新）
onMounted(() => {
  void fetchArtifacts(true);
});

// KeepAlive 生命周期：active 守卫 + 激活即刷新（呈现最新态）
onActivated(() => {
  artifactPageActive.value = true;
  void fetchArtifacts(true);
});
onDeactivated(() => {
  artifactPageActive.value = false;
});
</script>

<template>
  <section class="page-panel">
    <!-- 指标卡（全量口径，与筛选无关；数据来自随行 stats） -->
    <div class="artifact-summary">
      <div class="stat">
        <div class="stat-num">{{ artifactStats.total }}</div>
        <div class="stat-label">产出物总数</div>
      </div>
      <div class="stat">
        <div class="stat-num">{{ artifactStats.today }}</div>
        <div class="stat-label">今日新增</div>
      </div>
      <div class="stat">
        <div class="stat-num">{{ artifactSizeText(artifactStats.total_size) }}</div>
        <div class="stat-label">累计大小</div>
      </div>
    </div>

    <!-- 筛选栏（能力下拉 / 文件名子串 / 仅今天；变化即回第一页重查） -->
    <div class="history-toolbar">
      <select v-model="artifactCapFilter" class="history-select" @change="applyArtifactFilters">
        <option value="">全部能力</option>
        <option v-for="cap in artifactCapabilities" :key="cap" :value="cap">{{ cap }}</option>
      </select>
      <input
        v-model="artifactNameFilter"
        class="history-input"
        type="text"
        placeholder="文件名包含（回车筛选）"
        @change="applyArtifactFilters"
      />
      <label class="history-today">
        <input v-model="artifactTodayOnly" type="checkbox" @change="applyArtifactFilters" />
        <span>仅今天</span>
      </label>
      <span v-if="artifactLoading" class="history-hint">加载中</span>
    </div>

    <p v-if="artifactError !== null" class="action-error">{{ artifactError }}</p>

    <p v-if="!artifactLoading && artifacts.length === 0" class="empty">
      {{
        artifactCapFilter !== "" || artifactNameFilter.trim() !== "" || artifactTodayOnly
          ? "没有匹配的产出物"
          : "暂无产出物"
      }}
    </p>

    <table v-if="artifacts.length > 0" class="invocation-table artifact-table">
      <thead>
        <tr>
          <th>文件名</th>
          <th>来源能力</th>
          <th>大小</th>
          <th>生成时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in artifacts"
          :key="item.file"
          class="invocation-row"
          @click="openTrace(item)"
        >
          <td class="artifact-file">{{ item.filename }}</td>
          <td>{{ item.capability_id }}</td>
          <td>{{ artifactSizeText(item.size) }}</td>
          <td>{{ timeText(item.created_at) }}</td>
          <td>
            <span class="artifact-row-actions" @click.stop>
              <button
                class="artifact-open"
                :disabled="openingArtifact !== null"
                @click="showInFolder(item)"
              >
                打开所在文件夹
              </button>
              <button class="artifact-open" @click="openTrace(item)">查看 Trace</button>
            </span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 分页加载（has_more 由存储层 limit+1 探测驱动） -->
    <button
      v-if="artifactHasMore"
      class="load-more"
      :disabled="artifactLoading"
      @click="loadMoreArtifacts"
    >
      加载更多
    </button>
  </section>
</template>
