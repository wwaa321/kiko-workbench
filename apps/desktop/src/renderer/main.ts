/**
 * 渲染进程入口（M2-06 骨架）：挂载 Vue 应用
 *
 * M2-06 只验证 UI 数据通（IPC 真实数据 + 事件推送）；三区块完整交互
 * （启停开关 / Trace 展开 / 过滤）属 M2-07 / M2-08 / M2-09。
 */
import { createApp } from "vue";
import App from "./App.vue";
// 全局样式（UI 升级：原 App.vue <style> 块迁出至此，需显式引入才会打包）
import "./styles.css";

createApp(App).mount("#app");
