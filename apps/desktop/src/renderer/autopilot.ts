/**
 * autopilot 验收序列（smoke-plugins / smoke-history 断言锚点）
 *
 * 自 App.vue 原样迁移：自动驱动与用户点击完全同款的处理函数（经
 * stores 单例调用）；console 锚点字符串一字不改——smoke 侧按
 * "[kiko-renderer] autopilot m2-xx" 前缀匹配主进程转发的 console-message。
 */
import { getApi } from "./api.js";
import { fetchPluginCard, setPluginEnabled } from "./stores/plugins.js";
import {
  applyFilters,
  capabilityFilter,
  clearHistoryError,
  fetchHistory,
  historyError,
  invocations,
  openArtifact,
  selectInvocation,
  statusFilter,
  trace,
  traceError,
} from "./stores/history.js";

/** 渲染进程侧简易 sleep（autopilot 轮询间隔） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/**
 * M2-07 自动验收：启停即时生效 + error 插件重新启用
 *
 * 阶段 1（自动）：file 停用 → 断言 disabled（锚点 toggle-off）→
 *   启用 → 断言 enabled（锚点 toggle-on）。
 * 阶段 2（等待外部制造 error）：轮询发现 file=error 且崩溃原因非空 →
 *   走"重新启用"同款路径 → 断言 enabled（锚点 re-enabled）。
 * smoke 侧在 toggle-on 与 re-enabled 之间连杀插件进程 3 次触发熔断。
 */
export async function runM207Autopilot(): Promise<void> {
  const tag = "[kiko-renderer] autopilot m2-07";
  try {
    // ---- 阶段 1：启停即时生效 ----
    if (!(await setPluginEnabled("file", false))) {
      throw new Error("toggle(file, false) IPC 调用失败");
    }
    let card = await fetchPluginCard("file");
    if (card?.status !== "disabled") {
      throw new Error(`停用后状态应为 disabled（实际：${card?.status ?? "未找到"}）`);
    }
    console.log(`${tag} toggle-off: file=disabled`);

    // 停用窗口（3s）：留给 smoke 外部佐证（discover 不含 file.* +
    // invoke 40001）——与用户停用后 Agent 视角一致
    await sleep(3000);

    if (!(await setPluginEnabled("file", true))) {
      throw new Error("toggle(file, true) IPC 调用失败");
    }
    card = await fetchPluginCard("file");
    if (card?.status !== "enabled") {
      throw new Error(`启用后状态应为 enabled（实际：${card?.status ?? "未找到"}）`);
    }
    console.log(`${tag} toggle-on: file=enabled`);

    // ---- 阶段 2：轮询等熔断 error（smoke 连杀 3 次触发）→ 重新启用 ----
    const deadline = Date.now() + 60_000;
    for (;;) {
      await sleep(500);
      card = await fetchPluginCard("file");
      if (card?.status === "error") break;
      if (Date.now() >= deadline) {
        throw new Error("等待 file 熔断 error 超时（60s）");
      }
    }
    const reasonSeen = (card?.error_reason ?? "").length > 0;
    if (!reasonSeen) {
      throw new Error("error 态未携带崩溃原因");
    }
    if (!(await setPluginEnabled("file", true))) {
      throw new Error("重新启用 IPC 调用失败");
    }
    card = await fetchPluginCard("file");
    if (card?.status !== "enabled") {
      throw new Error(`重新启用后状态应为 enabled（实际：${card?.status ?? "未找到"}）`);
    }
    console.log(`${tag} re-enabled: file=enabled reason_seen=true`);
  } catch (e) {
    // 失败锚点：smoke 侧 FAIL 并输出原因（验收断言不静默）
    console.error(`${tag} FAIL: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * M2-08 自动验收：分页/筛选 + Trace 展开 + 产物定位
 *
 * 前置：smoke 侧经 WS 制造 4 条调用（file.read 越界 failed ×1 +
 * file.write ×2 + file.list ×1；failed 记录是"崩溃/恢复后 UI 可查"的
 * 同构载体——UI 只读 SQLite 经 invocation:list，与失败成因无关）。
 * 阶段 1  轮询等待历史恰好 4 条 → 锚点 history-loaded
 * 阶段 2  状态筛选 failed（同款 UI 路径：statusFilter + applyFilters）
 *         → 1 条 file.read → 锚点 history-status；其 Trace Error 分组
 *         非空 → 锚点 trace-error
 * 阶段 3  能力子串筛选（file.wri → 恰好 2 条 file.write）→ 锚点 history-filter
 * 阶段 4  IPC 分页参数化（limit=1 → has_more 探测）→ 锚点 history-paged
 * 阶段 5  Trace 展开（同款 UI 路径：selectInvocation）断言事件时间线 ≥3、
 *         result 非空、产物=1 → 锚点 trace-open
 * 阶段 6  打开所在文件夹（同款 UI 路径：openArtifact，真实弹资源管理器）
 *         → 锚点 artifact-shown
 */
export async function runM208Autopilot(): Promise<void> {
  const tag = "[kiko-renderer] autopilot m2-08";
  try {
    // ---- 阶段 1：等待 smoke 经 WS 制造的调用落库 ----
    const deadline = Date.now() + 60_000;
    for (;;) {
      await fetchHistory(true);
      if (invocations.value.length >= 4) break;
      if (Date.now() >= deadline) {
        throw new Error(`等待调用记录超时（当前 ${invocations.value.length} 条）`);
      }
      await sleep(500);
    }
    if (invocations.value.length !== 4) {
      throw new Error(`调用记录应为恰好 4 条（实际 ${invocations.value.length} 条）`);
    }
    console.log(`${tag} history-loaded: total=${invocations.value.length}`);

    // ---- 阶段 2：状态筛选 failed（失败记录 UI 可查）+ Error Trace ----
    statusFilter.value = "failed";
    await applyFilters();
    const failedItems = invocations.value.filter((i) => i.status === "failed");
    const failedItem = failedItems[0];
    if (failedItems.length !== 1 || failedItem?.capability_id !== "file.read") {
      throw new Error(
        `状态筛选应为 1 条 file.read failed（实际 ${failedItems.length} 条` +
          `${failedItem !== undefined ? `，首条 ${failedItem.capability_id}` : ""}）`,
      );
    }
    console.log(`${tag} history-status: matched=1 capability=file.read`);
    // failed 记录的 Trace：Error 分组渲染依据（trace.error 非空）
    await selectInvocation(failedItem);
    if (trace.value === null || trace.value.error == null) {
      throw new Error(`failed 记录 Trace 应含 error（实际：${traceError.value ?? "null"}）`);
    }
    console.log(`${tag} trace-error: code=${trace.value.error.code}`);
    // 还原筛选（后续阶段按能力子串；statusFilter 空串 = 不下发该条件）
    statusFilter.value = "";

    // ---- 阶段 3：能力子串筛选（file.wri → 恰好 2 条 file.write）----
    capabilityFilter.value = "file.wri";
    await applyFilters();
    const matched = invocations.value.filter((i) => i.capability_id === "file.write");
    if (matched.length !== 2) {
      throw new Error(`能力筛选应为 2 条 file.write（实际 ${matched.length}）`);
    }
    console.log(`${tag} history-filter: capability=file.wri matched=${matched.length}`);

    // ---- 阶段 4：IPC 分页参数化（limit=1 探测 has_more）----
    const paged = await getApi().listInvocations({ limit: 1, capability_contains: "file.wr" });
    if (paged.items.length !== 1 || !paged.has_more) {
      throw new Error(
        `分页探测异常：items=${paged.items.length} has_more=${String(paged.has_more)}`,
      );
    }
    console.log(`${tag} history-paged: matched=${paged.items.length} has_more=true`);

    // ---- 阶段 5：Trace 展开（最新一条 file.write）----
    const target = matched[0];
    if (target === undefined) throw new Error("筛选后未找到 file.write 记录");
    await selectInvocation(target);
    const t = trace.value;
    if (t === null) throw new Error(`Trace 拉取失败：${traceError.value ?? "unknown"}`);
    const eventCount = t.events?.length ?? 0;
    const logCount = t.logs?.length ?? 0;
    const artifactCount = t.artifacts?.length ?? 0;
    // 事件时间线：invocation.created + execution.started + execution.completed ≥3
    if (eventCount < 3) {
      throw new Error(`事件时间线应≥3（created/started/completed），实际 ${eventCount}`);
    }
    if (t.result === undefined || t.result === null) throw new Error("Trace 缺少 result");
    if (artifactCount !== 1) {
      throw new Error(`产物应为 1（file.write），实际 ${artifactCount}`);
    }
    console.log(
      `${tag} trace-open: events=${eventCount} logs=${logCount} result=present artifacts=${artifactCount}`,
    );

    // ---- 阶段 6：产物定位（白名单负向 + 真实打开正向）----
    const artifact = t.artifacts?.[0];
    if (artifact === undefined) throw new Error("产物列表为空");
    // 负向：工作空间外路径必须被主进程白名单拒绝（防渲染层被攻破后定位任意文件）
    await openArtifact({ ...artifact, file: "C:\\Windows\\win.ini" });
    if (historyError.value === null) {
      throw new Error("越界产物路径未被拒绝（白名单失效）");
    }
    clearHistoryError();
    console.log(`${tag} artifact-rejected: out_of_workspace=true`);
    // 正向：真实 shell.showItemInFolder（打开资源管理器并选中产物）
    await openArtifact(artifact);
    if (historyError.value !== null) throw new Error(`打开产物失败：${historyError.value}`);
    console.log(`${tag} artifact-shown: ok file=${artifact.filename}`);
  } catch (e) {
    console.error(`${tag} FAIL: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** autopilot 分发（App.vue onMounted 调用；URL query 由 smoke 注入） */
export function dispatchAutopilot(mode: string | null): void {
  if (mode === "m2-07") {
    void runM207Autopilot();
  } else if (mode === "m2-08") {
    void runM208Autopilot();
  }
}
