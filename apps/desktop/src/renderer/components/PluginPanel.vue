<script setup lang="ts">
/**
 * 插件面板（原 App.vue 插件区块原样迁移）
 *
 * 状态与操作经 plugins store 单例共享（模块级 ref），组件仅承载视图——
 * KeepAlive 失活后数据常驻，激活即时呈现。
 *
 * P-002：声明配置的插件卡片显示"设置"入口（唤起 PluginConfigModal）；
 * 已保存配置的卡片显示"已配置"状态圆点（纯 CSS 指示器）。
 */
import { ref } from "vue";
import {
  actionError,
  actionNotice,
  confirmingRemove,
  exportPlugin,
  importPlugin,
  importing,
  managing,
  onSwitchChange,
  openPluginUi,
  openingUi,
  plugins,
  setPluginEnabled,
  statusLabel,
  toggling,
  uninstallPlugin,
} from "../stores/plugins.js";
import PluginConfigModal from "./PluginConfigModal.vue";

/** 插件设置模态引用（卡片"设置"按钮唤起 open） */
const configModal = ref<InstanceType<typeof PluginConfigModal> | null>(null);
</script>

<template>
  <section class="page-panel">
    <div class="block-head">
      <h2>插件</h2>
      <!-- 导入入口：主进程弹 zip 选择框（仅第三方插件根，内置不受影响） -->
      <button class="head-btn" :disabled="importing" @click="importPlugin">
        {{ importing ? "导入中…" : "导入插件" }}
      </button>
    </div>
    <p v-if="actionError !== null" class="action-error">操作失败：{{ actionError }}</p>
    <p v-if="actionNotice !== null" class="action-notice">{{ actionNotice }}</p>
    <p v-if="plugins.length === 0" class="empty">暂无已注册插件</p>
    <ul v-else class="plugin-grid">
      <li v-for="p in plugins" :key="p.id" class="plugin-card" :data-status="p.status">
        <div class="plugin-head">
          <span class="status-dot" :data-status="p.status"></span>
          <span class="plugin-name">{{ p.name }}</span>
          <span class="plugin-version">v{{ p.version }}</span>
          <!-- 来源标记：纯 CSS 文本徽标，驱动"第三方可导出/删除"认知 -->
          <span v-if="p.source === 'third_party'" class="source-tag">第三方</span>
          <!-- P-002：已配置圆点（存在已保存配置值；纯 CSS 指示器） -->
          <span v-if="p.config_saved" class="config-saved-tag">已配置</span>
          <span class="plugin-capabilities">{{ p.capability_count }} 项能力</span>
        </div>
        <p class="plugin-desc">{{ p.description }}</p>
        <p v-if="p.error_reason !== undefined" class="plugin-error">{{ p.error_reason }}</p>
        <div class="plugin-foot">
          <span class="plugin-status-label">{{ statusLabel(p.status) }}</span>
          <div class="plugin-foot-actions">
            <!-- P-003：微应用界面入口（声明 contributes.ui 的插件专属；
                 主进程单实例窗口——已开聚焦） -->
            <button
              v-if="p.has_ui"
              class="plugin-btn"
              :disabled="openingUi.has(p.id)"
              title="打开插件界面窗口"
              @click="openPluginUi(p.id)"
            >
              打开界面
            </button>
            <!-- P-002：设置入口（声明配置的插件专属；唤起配置弹窗） -->
            <button
              v-if="p.has_config"
              class="plugin-btn"
              :title="p.config_saved ? '修改已保存的配置' : '填写插件配置'"
              @click="configModal?.open(p)"
            >
              设置
            </button>
            <!-- 第三方插件专属：导出（分享）/ 删除（两步确认防误删） -->
            <template v-if="p.source === 'third_party'">
              <button class="plugin-btn" :disabled="managing.has(p.id)" @click="exportPlugin(p.id)">
                导出
              </button>
              <button
                v-if="confirmingRemove !== p.id"
                class="plugin-btn danger"
                :disabled="managing.has(p.id)"
                @click="confirmingRemove = p.id"
              >
                删除
              </button>
              <template v-else>
                <button
                  class="plugin-btn danger solid"
                  :disabled="managing.has(p.id)"
                  @click="uninstallPlugin(p)"
                >
                  确认删除
                </button>
                <button
                  class="plugin-btn"
                  :disabled="managing.has(p.id)"
                  @click="confirmingRemove = null"
                >
                  取消
                </button>
              </template>
            </template>
            <!-- error 态：开关让位给"重新启用"（清崩溃计数 + 懒启动新进程） -->
            <button
              v-if="p.status === 'error'"
              class="re-enable"
              :disabled="toggling.has(p.id)"
              @click="setPluginEnabled(p.id, true)"
            >
              重新启用
            </button>
            <label v-else class="switch" :title="p.status === 'enabled' ? '停用插件' : '启用插件'">
              <input
                type="checkbox"
                :checked="p.status === 'enabled'"
                :disabled="toggling.has(p.id)"
                @change="onSwitchChange(p.id, $event)"
              />
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </label>
          </div>
        </div>
      </li>
    </ul>
    <!-- 插件设置模态（卡片"设置"按钮唤起；fixed 定位不受面板布局影响） -->
    <PluginConfigModal ref="configModal" />
  </section>
</template>
