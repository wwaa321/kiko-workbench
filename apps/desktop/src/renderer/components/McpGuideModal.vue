<script setup lang="ts">
/**
 * MCP 接入模态（顶栏"MCP 接入"按钮唤起）
 *
 * 与 AgentGuideModal 同款骨架（遮罩 / Escape 关闭 / 复制反馈 2s 复位 /
 * 独立错误面），复用 guide-* 样式类保持视觉一致；差异点：
 *   - 数据源同为 getConnectionInfo（ConnectionInfo.mcpAdapterPath）
 *   - 正文为 mcpServers JSON（MCP 客户端配置），非 Markdown 指南
 *   - 适配器不可用（路径 undefined）→ 展示构建引导而非空白
 *   - 无首启自动弹出（MCP 属进阶接入；Agent 接入已覆盖零成本路径）
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { getApi } from "../api.js";
import { buildMcpConfig } from "../mcp-guide.js";
import type { ConnectionInfo } from "../../shared.js";

/** Agent 接入信息（端点 / token / 适配器路径；null = 未加载或加载失败） */
const connectionInfo = ref<ConnectionInfo | null>(null);
/** MCP 接入模态开关 */
const mcpOpen = ref(false);
/** 接入信息加载失败信息（模态内展示；按钮重试） */
const mcpError = ref<string | null>(null);
/** 复制按钮反馈（true = 已复制，2 秒后复位） */
const copied = ref(false);
/** 复制失败信息 */
const copyError = ref<string | null>(null);
/** copied 复位定时器句柄（重复复制时先清旧定时器） */
let copiedTimer: number | undefined;

/** MCP 客户端配置全文（mcpServers JSON；适配器不可用时 null） */
const configText = computed(() =>
  connectionInfo.value !== null ? buildMcpConfig(connectionInfo.value) : null,
);

/**
 * 打开 MCP 接入模态（懒加载：启动获取失败时点按钮重试）。
 * defineExpose 供父组件（顶栏按钮）唤起。
 */
async function open(): Promise<void> {
  mcpOpen.value = true;
  mcpError.value = null;
  if (connectionInfo.value === null) {
    try {
      connectionInfo.value = await getApi().getConnectionInfo();
    } catch (e) {
      // 独立于主链路的错误面（模态内展示，不污染全局 error）
      mcpError.value = e instanceof Error ? e.message : String(e);
    }
  }
}

/** 关闭模态（反馈态复位） */
function closeMcp(): void {
  mcpOpen.value = false;
  copied.value = false;
  copyError.value = null;
}

/** 复制配置 JSON 到系统剪贴板（主进程 Electron clipboard） */
async function copyConfig(): Promise<void> {
  if (configText.value === null) return;
  try {
    await getApi().writeClipboard(configText.value);
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
function onMcpKeydown(e: KeyboardEvent): void {
  if (mcpOpen.value && e.key === "Escape") closeMcp();
}

onMounted(() => {
  window.addEventListener("keydown", onMcpKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onMcpKeydown);
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
});

defineExpose({ open });
</script>

<template>
  <!-- MCP 接入模态（顶栏按钮唤起；复用 guide-* 模态骨架样式） -->
  <div v-if="mcpOpen" class="guide-overlay" @click.self="closeMcp">
    <div class="guide-modal" role="dialog" aria-label="MCP 接入配置">
      <div class="guide-head">
        <h3>MCP 接入配置</h3>
        <button class="guide-close" aria-label="关闭" @click="closeMcp">关闭</button>
      </div>

      <p class="guide-hint">
        将下方配置复制到你所使用的 MCP 客户端（如 Claude Desktop 的
        claude_desktop_config.json、Cursor 的 mcp.json）的 mcpServers 字段中，重启客户端即可把 Kiko
        Workbench 的能力挂载为 MCP 工具集。需要本机安装 Node.js（18 或以上）。服务仅监听本机回环
        地址（127.0.0.1），token 请勿粘贴到不可信渠道。
      </p>

      <p v-if="mcpError !== null" class="guide-error">接入信息获取失败：{{ mcpError }}</p>

      <div v-if="connectionInfo !== null" class="guide-endpoints">
        <div class="guide-endpoint">
          <span class="guide-endpoint-label">WebSocket</span>
          <code>{{ connectionInfo.wsUrl }}</code>
        </div>
        <div class="guide-endpoint">
          <span class="guide-endpoint-label">适配器</span>
          <code>{{ connectionInfo.mcpAdapterPath ?? "不可用" }}</code>
        </div>
      </div>

      <!-- 适配器不可用：构建引导（不给必然失败的路径） -->
      <p v-if="connectionInfo !== null && configText === null" class="guide-error">
        MCP 适配器尚未就绪：开发态请先执行 pnpm --filter @kiko-workbench/mcp-adapter run build。
      </p>

      <pre v-if="configText !== null" class="guide-text">{{ configText }}</pre>

      <div class="guide-foot">
        <p v-if="copyError !== null" class="guide-error">复制失败：{{ copyError }}</p>
        <button class="guide-copy" :disabled="configText === null" @click="copyConfig">
          {{ copied ? "已复制到剪贴板" : "复制 MCP 配置" }}
        </button>
      </div>
    </div>
  </div>
</template>
