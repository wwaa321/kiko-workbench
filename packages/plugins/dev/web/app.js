/**
 * Dev 微应用测试台脚本（P-003 v1）
 *
 * 职责唯一：订阅宿主桥（window.kikoPluginUi.onMessage），把插件后端
 * ctx.ui.send 推送的 payload 渲染成消息流条目（新消息置顶）。
 *
 * 桥契约（shared.ts KikoPluginUiApi）：onMessage(listener) → 退订函数。
 * 页面加载即订阅——v1 已知边界：订阅建立前宿主发送的消息不重放
 * （ui.send resolve 仅代表投递确认，不代表前端已渲染；见方案草案附录 C）。
 */

/** 全局桥对象（plugin-ui-preload 经 contextBridge 注入；TS 环境无类型时按结构取用） */
const bridge = /** @type {{ onMessage(listener: (payload: unknown) => void): () => void }} */ (
  window.kikoPluginUi
);

/** 消息流容器与空态提示（index.html 静态节点） */
const list = document.getElementById("messages");
const hint = document.getElementById("hint");

/**
 * 渲染一条推送消息（新消息置顶——测试台场景下最新消息最有价值）。
 * payload 形状由插件后端定义（dev.uitest 推送 { kind, message, sent_at }）；
 * 防御性处理未知形状：JSON 序列化失败时回退 String()。
 */
function renderMessage(payload) {
  if (list === null) return;
  if (hint !== null) hint.hidden = true; // 首条消息到达 → 撤空态

  const item = document.createElement("li");

  // 元信息行：消息来源标识 + 本地接收时间（与 sent_at 对比可见链路延迟）
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const kind = document.createElement("span");
  kind.className = "msg-kind";
  kind.textContent =
    payload !== null && typeof payload === "object" && "kind" in payload
      ? String(payload.kind)
      : "unknown";
  const time = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString();
  meta.append(kind, time);

  // 消息体：pretty JSON（未知 payload 也能完整展示）
  const body = document.createElement("pre");
  body.className = "msg-body";
  try {
    body.textContent = JSON.stringify(payload, null, 2);
  } catch {
    body.textContent = String(payload); // 循环引用等异常 payload 兜底
  }

  item.append(meta, body);
  list.prepend(item);
}

// 页面加载即订阅（微应用常规形态：接收推送刷新视图）
if (bridge !== undefined && typeof bridge.onMessage === "function") {
  bridge.onMessage(renderMessage);
} else {
  // 桥缺失 = 非宿主环境打开（如直接 file:// 调试）——页面上给出可排障提示
  if (hint !== null) {
    hint.textContent = "宿主桥（window.kikoPluginUi）不可用：请从工作台插件面板「打开界面」进入。";
  }
}
