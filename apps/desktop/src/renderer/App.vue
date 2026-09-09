<script setup lang="ts">
/**
 * 应用骨架（UI 升级：侧边栏 + 页面化布局）
 *
 * 演进自 M2-06 单页三区块骨架：插件 / 实时事件 / 调用历史原区块拆分为
 * 独立面板组件（stores 单例承载数据，KeepAlive 缓存视图），新增产出物
 * 面板（跨 invocation 产物归集 + Trace 反查）。
 *
 * 轻量状态切换（评审定）：不引入 vue-router——activePage ref（ui store）
 * + KeepAlive；订阅常驻本组件，页面切换不中断数据滚动更新。
 *
 * 可观测性锚点（smoke 断言，勿改字符串）：
 *   - [kiko-renderer] ipc-ready / event / IPC 初始化失败（本文件）
 *   - [kiko-renderer] autopilot m2-07 / m2-08（autopilot.ts）
 *   - [kiko-renderer] agent-guide（AgentGuideModal.vue）
 */
import { onMounted, onUnmounted, ref } from "vue";
import { getApi } from "./api.js";
import { dispatchAutopilot } from "./autopilot.js";
import { PAGE_META, activePage } from "./stores/ui.js";
import { plugins } from "./stores/plugins.js";
import { fetchHistory, invocations, refreshTrace, trace } from "./stores/history.js";
import { onInvocationStateChanged, artifactStats, fetchArtifactStats } from "./stores/artifacts.js";
import { pushEvent } from "./stores/events.js";
import PluginPanel from "./components/PluginPanel.vue";
import ArtifactPanel from "./components/ArtifactPanel.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import EventsPanel from "./components/EventsPanel.vue";
import AgentGuideModal from "./components/AgentGuideModal.vue";
import McpGuideModal from "./components/McpGuideModal.vue";

/** 页面组件映射（component :is 数据源；顺序即侧边栏导航顺序） */
const PAGES = {
  plugins: PluginPanel,
  artifacts: ArtifactPanel,
  history: HistoryPanel,
  events: EventsPanel,
} as const;

/** Agent 接入指南模态引用（顶栏按钮唤起 open） */
const guideModal = ref<InstanceType<typeof AgentGuideModal> | null>(null);
/** MCP 接入模态引用（顶栏按钮唤起 open） */
const mcpModal = ref<InstanceType<typeof McpGuideModal> | null>(null);

/** 装配级错误（IPC 初始化失败快现；与各面板操作级错误分离） */
const error = ref<string | null>(null);

let unsubscribe: (() => void) | undefined;

onMounted(async () => {
  const api = getApi();
  try {
    // 初始快照：插件卡片 + 调用历史第一页 + 产出物徽标（空列表同样是数据通验证）
    [plugins.value] = await Promise.all([api.listPlugins()]);
    await fetchHistory(true);
    await fetchArtifactStats();
    console.log(
      `[kiko-renderer] ipc-ready: plugins=${plugins.value.length} invocations=${invocations.value.length}`,
    );

    // 事件推送订阅（smoke-shell 断言锚点：WS invoke → execution.* 推送可达）
    unsubscribe = api.subscribeEvents((raw) => {
      const ev = raw as { event?: unknown; invocation_id?: unknown; timestamp?: unknown };
      const event = typeof ev.event === "string" ? ev.event : "unknown";
      const invocationId =
        typeof ev.invocation_id === "string" ? ev.invocation_id.slice(0, 8) : "-";
      const timestamp = typeof ev.timestamp === "string" ? ev.timestamp : "";
      pushEvent({ event, invocation_id: invocationId, timestamp });
      // 状态变迁类事件统一驱动列表刷新（progress 高频事件不拉，
      // 防长任务进度风暴打爆 IPC）；历史回第一页呈现最新态，产出物页
      // 自行按活跃度分级（全量刷新 / 轻量 stats 探测）
      if (
        event === "invocation.created" ||
        event === "execution.started" ||
        event === "execution.completed" ||
        event === "execution.failed" ||
        event === "execution.cancelled"
      ) {
        void fetchHistory(true).catch(() => undefined);
        onInvocationStateChanged();
      }
      // Trace 实时更新：选中 invocation 的任何事件（含 progress）都重拉
      // detail——时间线是"实时滚动"语义（traceLive 守卫在 store 内部：
      // 历史页非活跃时挂起，砍掉无效 IPC 往返）
      if (typeof ev.invocation_id === "string" && invocationIdMatchesTrace(ev.invocation_id)) {
        void refreshTrace().catch(() => undefined);
      }
      console.log(`[kiko-renderer] event: ${event} ${invocationId}`);
    });
  } catch (e) {
    // IPC 层失败快现（骨架页不吞错误：装配问题应可见）
    error.value = e instanceof Error ? e.message : String(e);
    console.error("[kiko-renderer] IPC 初始化失败：", e);
    return;
  }

  // autopilot 验收模式（smoke 经 KIKO_AUTOPILOT env → URL query 注入）：
  // 自动驱动与用户点击完全同款的处理函数（stores 单例直达）
  const autopilot = new URLSearchParams(window.location.search).get("autopilot");
  dispatchAutopilot(autopilot);
});

onUnmounted(() => {
  unsubscribe?.();
});

/** 事件是否命中当前展开的 Trace（与原单文件逻辑等价；null 安全前置） */
function invocationIdMatchesTrace(invocationId: string): boolean {
  return traceId.value !== null && invocationId === traceId.value;
}
</script>

<script lang="ts">
// trace 选中 id 的非响应式读取（订阅回调内比较用；避免引入额外响应式依赖）
// （trace 经顶部 script setup 的 import 进入模块作用域，此处仅消费——
// 二次 import 曾触发 no-redeclare）
import { computed } from "vue";
const traceId = computed(() => trace.value?.invocation_id ?? null);
</script>

<template>
  <div class="app-shell">
    <!-- ======================= 侧边栏 ======================= -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-name">Kiko Workbench</div>
        <div class="brand-sub">CAPABILITY PLATFORM</div>
      </div>

      <div class="nav-group-label">工作台</div>
      <div
        :class="{ active: activePage === 'plugins' }"
        class="nav-item"
        @click="activePage = 'plugins'"
      >
        <i class="nav-ico plugins"></i>插件
        <span v-if="plugins.length > 0" class="nav-badge">{{ plugins.length }}</span>
      </div>
      <div
        :class="{ active: activePage === 'artifacts' }"
        class="nav-item"
        @click="activePage = 'artifacts'"
      >
        <i class="nav-ico artifacts"></i>产出物
        <span v-if="artifactStats.total > 0" class="nav-badge">{{ artifactStats.total }}</span>
      </div>
      <div
        :class="{ active: activePage === 'history' }"
        class="nav-item"
        @click="activePage = 'history'"
      >
        <i class="nav-ico history"></i>调用历史
      </div>
      <div
        :class="{ active: activePage === 'events' }"
        class="nav-item"
        @click="activePage = 'events'"
      >
        <i class="nav-ico events"></i>实时事件
      </div>

      <div class="sidebar-foot">Kiko Workbench</div>
    </aside>

    <!-- ======================= 主区 ======================= -->
    <main class="main-area">
      <header class="topbar">
        <div>
          <h1>{{ PAGE_META[activePage].title }}</h1>
          <div class="topbar-desc">{{ PAGE_META[activePage].desc }}</div>
        </div>
        <div class="topbar-actions">
          <button class="agent-access" @click="guideModal?.open()">Agent 接入</button>
          <button class="agent-access" @click="mcpModal?.open()">MCP 接入</button>
        </div>
      </header>

      <p v-if="error !== null" class="error">IPC 初始化失败：{{ error }}</p>

      <div class="content">
        <!-- 轻量状态切换：KeepAlive 缓存面板视图（切回零数据等待） -->
        <KeepAlive>
          <component :is="PAGES[activePage]" />
        </KeepAlive>
      </div>
    </main>

    <!-- Agent 接入指南模态（首启自动弹出 / 顶栏按钮唤起） -->
    <AgentGuideModal ref="guideModal" />
    <!-- MCP 接入模态（顶栏按钮唤起；mcpServers 配置复制） -->
    <McpGuideModal ref="mcpModal" />
  </div>
</template>
