<script setup lang="ts">
/**
 * Agent 接入指南模态（自 App.vue 原样迁移，逻辑自包含）
 *
 * 自包含设计：预取 + 首启自动弹出 + Escape 关闭全部收敛在组件内，
 * 对外仅暴露 open()（顶栏按钮唤起）；console 锚点保留
 * （"[kiko-renderer] agent-guide: first-launch auto open"）。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { getApi } from "../api.js";
import { buildAgentGuide } from "../agent-guide.js";
import type { ConnectionInfo } from "../../shared.js";

/** Agent 接入信息（端点 / token；null = 未加载或加载失败） */
const connectionInfo = ref<ConnectionInfo | null>(null);
/** 接入指南模态开关 */
const guideOpen = ref(false);
/** 接入信息加载失败信息（模态内展示；按钮重试） */
const guideError = ref<string | null>(null);
/** 复制按钮反馈（true = 已复制，2 秒后复位） */
const copied = ref(false);
/** 复制失败信息 */
const copyError = ref<string | null>(null);
/** copied 复位定时器句柄（重复复制时先清旧定时器） */
let copiedTimer: number | undefined;

/** 接入指南全文（面向 Agent 的即贴即用说明；info 未就绪时空串） */
const guideText = computed(() =>
  connectionInfo.value !== null ? buildAgentGuide(connectionInfo.value) : "",
);

/**
 * 打开接入指南（懒加载：启动获取失败时点按钮重试）。
 * defineExpose 供父组件（顶栏按钮）唤起。
 */
async function open(): Promise<void> {
  guideOpen.value = true;
  guideError.value = null;
  if (connectionInfo.value === null) {
    try {
      connectionInfo.value = await getApi().getConnectionInfo();
    } catch (e) {
      // 独立于主链路的错误面（模态内展示，不污染全局 error）
      guideError.value = e instanceof Error ? e.message : String(e);
    }
  }
}

/** 关闭接入指南（反馈态复位） */
function closeGuide(): void {
  guideOpen.value = false;
  copied.value = false;
  copyError.value = null;
}

/** 复制接入指南全文到系统剪贴板（主进程 Electron clipboard） */
async function copyGuide(): Promise<void> {
  if (guideText.value === "") return;
  try {
    await getApi().writeClipboard(guideText.value);
    copied.value = true;
    copyError.value = null;
    // 反馈窗口 2 秒后复位（clearTimeout 防连点定时器堆叠）
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (e) {
    copied.value = false;
    copyError.value = e instanceof Error ? e.message : String(e);
  }
}

/** Escape 关闭模态（全局监听，open 态才响应） */
function onGuideKeydown(e: KeyboardEvent): void {
  if (guideOpen.value && e.key === "Escape") closeGuide();
}

onMounted(async () => {
  window.addEventListener("keydown", onGuideKeydown);
  // Agent 接入信息预取 + 首启自动弹出（独立错误面：引导失败不拖累主链路，
  // 顶栏按钮仍可手动重试；查询即置位——主进程保证仅首次返回 true）
  try {
    connectionInfo.value = await getApi().getConnectionInfo();
    if (connectionInfo.value.showGuide) {
      guideOpen.value = true;
      console.log("[kiko-renderer] agent-guide: first-launch auto open");
    }
  } catch {
    /* 预取失败静默：open 懒加载重试 */
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGuideKeydown);
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
});

defineExpose({ open });
</script>

<template>
  <!-- Agent 接入指南模态（首启自动弹出 / 顶栏按钮唤起） -->
  <div v-if="guideOpen" class="guide-overlay" @click.self="closeGuide">
    <div class="guide-modal" role="dialog" aria-label="Agent 接入指南">
      <div class="guide-head">
        <h3>Agent 接入指南</h3>
        <button class="guide-close" aria-label="关闭" @click="closeGuide">关闭</button>
      </div>

      <p class="guide-hint">
        将下方说明复制并粘贴给你使用的 Agent，它即可通过本机服务调用 Kiko Workbench
        的能力。服务仅监听本机回环地址（127.0.0.1），token 请勿粘贴到不可信渠道。
      </p>

      <p v-if="guideError !== null" class="guide-error">接入信息获取失败：{{ guideError }}</p>

      <div v-if="connectionInfo !== null" class="guide-endpoints">
        <div class="guide-endpoint">
          <span class="guide-endpoint-label">WebSocket</span>
          <code>{{ connectionInfo.wsUrl }}</code>
        </div>
        <div class="guide-endpoint">
          <span class="guide-endpoint-label">HTTP</span>
          <code>{{ connectionInfo.httpUrl }}</code>
        </div>
      </div>

      <pre v-if="guideText !== ''" class="guide-text">{{ guideText }}</pre>

      <div class="guide-foot">
        <p v-if="copyError !== null" class="guide-error">复制失败：{{ copyError }}</p>
        <button class="guide-copy" :disabled="guideText === ''" @click="copyGuide">
          {{ copied ? "已复制到剪贴板" : "复制接入说明" }}
        </button>
      </div>
    </div>
  </div>
</template>
