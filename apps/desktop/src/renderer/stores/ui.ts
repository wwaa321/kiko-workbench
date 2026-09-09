/**
 * UI 导航状态（模块级单例 store）
 *
 * 轻量状态切换方案（评审定）：不引入 vue-router——桌面应用无 URL 路由
 * 需求，activePage ref + KeepAlive 缓存即可；store 模块级单例使跨页面
 * 导航（如产出物 → Trace 反查）无需组件链 props 透传。
 */
import { ref } from "vue";

/** 页面键（侧边栏导航项与页面组件一一对应） */
export type PageKey = "plugins" | "artifacts" | "history" | "events";

/** 页面元信息（顶栏标题 / 描述数据源） */
export const PAGE_META: Record<PageKey, { title: string; desc: string }> = {
  plugins: { title: "插件", desc: "已装配插件与能力总览" },
  artifacts: { title: "产出物", desc: "全部历史执行产出的归集与检索" },
  history: { title: "调用历史", desc: "调用记录分页查询与 Trace 展开" },
  events: { title: "实时事件", desc: "运行中调用的事件流（最新在前）" },
};

/** 当前活跃页面（默认插件页——原单页布局的首区块语义） */
export const activePage = ref<PageKey>("plugins");
