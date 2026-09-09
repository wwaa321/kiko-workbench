/**
 * 调用历史 store（模块级单例）：分页 + 筛选 + Trace 展开 + 产物定位
 *
 * 原逻辑自 App.vue 原样迁移（零功能变更）。数据策略保持"常驻滚动"：
 * 事件驱动的 fetchHistory 由 App.vue 订阅常驻触发，与当前活跃页面无关。
 * 新增 traceLive 守卫：页面非活跃时挂起事件驱动的 Trace 重拉（砍掉无效
 * IPC 往返；重新激活时由 onActivated 补一次刷新）。
 */
import { ref } from "vue";
import { getApi } from "../api.js";
import type {
  ArtifactInfo,
  ExecutionDetail,
  InvocationListItem,
  InvocationListQuery,
  InvocationStatus,
} from "../../shared.js";

/** 调用历史当前页条目（分页拉取，永不全量） */
export const invocations = ref<InvocationListItem[]>([]);
/** 当前页之后是否还有记录（"加载更多"按钮显示依据） */
export const hasMore = ref(false);
/** 调用历史加载中（防筛选连点与加载更多重复触发） */
export const historyLoading = ref(false);
/** 调用历史操作级错误（与装配级 error 分离） */
export const historyError = ref<string | null>(null);
/** 调用历史操作成功提示（清空历史轻反馈；渲染在历史区块内） */
export const historyNotice = ref<string | null>(null);
/** 历史筛选状态（外部五值；空串 = 全部） */
export const statusFilter = ref<"" | InvocationStatus>("");
/** 历史筛选能力子串（input 原样绑定；查询时才消费） */
export const capabilityFilter = ref("");
/** 历史筛选"仅今天"（今天零点本地时间折算 since） */
export const todayOnly = ref(false);
/** 已加载条数（"加载更多"追加的 offset 基准） */
export const loadedCount = ref(0);
/** 调用历史页大小（M2-08 数据量控制的一环；翻页粒度） */
export const HISTORY_PAGE_SIZE = 50;
/** 清空历史进行中（按钮禁用防连点：删除 + VACUUM 有可感知耗时） */
export const clearingHistory = ref(false);
/** 清空历史两步确认态（false = 无确认；防误清） */
export const confirmingClearHistory = ref(false);

/** Trace 面板：选中 invocation 的完整执行详情（null = 未展开） */
export const trace = ref<ExecutionDetail | null>(null);
/** Trace 加载中（行点击 → detail IPC 往返窗口） */
export const traceLoading = ref(false);
/** Trace 拉取失败信息（40003 等） */
export const traceError = ref<string | null>(null);
/** "打开所在文件夹"进行中的产物路径（按钮禁用防连点） */
export const openingArtifact = ref<string | null>(null);
/**
 * Trace 实时刷新守卫（HistoryPanel onActivated/onDeactivated 维护）：
 * 页面非活跃时挂起事件驱动的 refreshTrace——Trace 属历史页视图，
 * 用户在别的页面时重拉 detail 是无效 IPC 往返。
 */
export const traceLive = ref(false);

/** 本地今天零点 → ISO（"仅今天"筛选的 since 参数） */
function todayStartIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/**
 * 清空调用历史（两步确认后执行）：仅终态记录，事件/日志级联删除，
 * 运行中的调用保留。成功后重拉第一页 + 轻提示。
 */
export async function clearHistory(): Promise<void> {
  if (clearingHistory.value) return;
  clearingHistory.value = true;
  confirmingClearHistory.value = null; // 确认态即点即消
  historyError.value = null;
  historyNotice.value = null;
  try {
    const cleared = await getApi().clearHistory();
    // 重拉第一页：运行中的记录（若有）仍会显示，已清终态条目消失
    loadedCount.value = 0;
    await fetchHistory(true);
    historyNotice.value = cleared > 0 ? `已清理 ${cleared} 条调用历史` : "没有可清理的历史记录";
  } catch (e) {
    historyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    clearingHistory.value = false;
  }
}

/**
 * 拉取调用历史：reset=true 回第一页（筛选变化 / 事件刷新）；
 * reset=false 从 loadedCount 追加（"加载更多"）。
 * 全部条件经 IPC 下推存储层，UI 永不持有全量数据。
 */
export async function fetchHistory(reset: boolean): Promise<void> {
  if (historyLoading.value) return; // 防重入（事件风暴与用户操作并发）
  historyLoading.value = true;
  historyError.value = null;
  try {
    const query: InvocationListQuery = {
      limit: HISTORY_PAGE_SIZE,
      offset: reset ? 0 : loadedCount.value,
      ...(statusFilter.value !== "" ? { status: statusFilter.value } : {}),
      ...(capabilityFilter.value.trim() !== ""
        ? { capability_contains: capabilityFilter.value.trim() }
        : {}),
      ...(todayOnly.value ? { since: todayStartIso() } : {}),
    };
    const result = await getApi().listInvocations(query);
    if (reset) {
      invocations.value = result.items;
      loadedCount.value = result.items.length;
    } else {
      // 追加去重：事件触发的 reset 拉取与 loadMore 极小概率交叠，防重复行
      const seen = new Set(invocations.value.map((i) => i.invocation_id));
      const fresh = result.items.filter((i) => !seen.has(i.invocation_id));
      invocations.value = [...invocations.value, ...fresh];
      loadedCount.value += fresh.length;
    }
    hasMore.value = result.has_more;
  } catch (e) {
    historyError.value = `历史查询失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    historyLoading.value = false;
  }
}

/** 筛选条件变化 → 重置回第一页（模板 @change 统一入口） */
export async function applyFilters(): Promise<void> {
  await fetchHistory(true);
}

/** "加载更多"：从已加载条数处追加下一页 */
export async function loadMore(): Promise<void> {
  await fetchHistory(false);
}

/** 选中并拉取 Trace（toggle 语义由调用方决定；异常写 traceError） */
async function loadTrace(invocationId: string): Promise<void> {
  trace.value = null;
  traceError.value = null;
  traceLoading.value = true;
  try {
    trace.value = await getApi().getExecution(invocationId);
  } catch (e) {
    traceError.value = e instanceof Error ? e.message : String(e);
  } finally {
    traceLoading.value = false;
  }
}

/**
 * 行点击展开 Trace（同行再点收起）。
 * 走 getExecution（include_events/logs）——事件时间线 + 日志 + Result/Error + 产物。
 */
export async function selectInvocation(item: InvocationListItem): Promise<void> {
  // toggle 语义：再次点击当前选中行 → 收起面板
  if (trace.value?.invocation_id === item.invocation_id) {
    trace.value = null;
    traceError.value = null;
    return;
  }
  await loadTrace(item.invocation_id);
}

/**
 * 按 invocation_id 展开 Trace（产出物页"反查调用"入口：无 toggle 语义，
 * 同 id 重复点击保持展开并刷新）。导航切页由调用方（ui store）负责。
 */
export async function selectInvocationById(invocationId: string): Promise<void> {
  if (trace.value?.invocation_id === invocationId) {
    await loadTrace(invocationId); // 已选中：刷新而非收起（跨页入口无 toggle 预期）
    return;
  }
  await loadTrace(invocationId);
}

/**
 * 选中 invocation 的 Trace 实时刷新（事件到达时触发；失败保留旧快照）。
 * traceLive 守卫：历史页非活跃时挂起（onActivated 会补一次刷新）。
 */
export async function refreshTrace(): Promise<void> {
  if (trace.value === null || !traceLive.value) return;
  try {
    trace.value = await getApi().getExecution(trace.value.invocation_id);
  } catch {
    // 刷新失败静默：下一次该 invocation 的事件到达会重试
  }
}

/** 打开产物所在文件夹（主进程白名单校验，越界路径会收到错误信封） */
export async function openArtifact(artifact: ArtifactInfo): Promise<void> {
  if (openingArtifact.value !== null) return; // 防连点
  openingArtifact.value = artifact.file;
  try {
    await getApi().showArtifactInFolder(artifact.file);
  } catch (e) {
    historyError.value = `打开所在文件夹失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    openingArtifact.value = null;
  }
}

/** 清除历史区块操作级错误（autopilot 负向→正向衔接用） */
export function clearHistoryError(): void {
  historyError.value = null;
}
