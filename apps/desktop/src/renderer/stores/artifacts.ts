/**
 * 产出物 store（模块级单例）：跨 invocation 产物归集页数据源
 *
 * 数据策略与调用历史同构：分页 SQL 下推（永不全量拉取）；汇总口径
 * 全量（与筛选无关）。active 守卫：页面非活跃时事件驱动的刷新退化为
 * 轻量 stats 探测（limit=1，仅更新侧栏徽标与指标卡）。
 */
import { ref } from "vue";
import { getApi } from "../api.js";
import type { ArtifactListItem, ArtifactListQuery } from "../../shared.js";

/** 产出物当前页条目 */
export const artifacts = ref<ArtifactListItem[]>([]);
/** 当前页之后是否还有记录（"加载更多"按钮显示依据） */
export const artifactHasMore = ref(false);
/** 产出物加载中（防筛选连点与刷新重复触发） */
export const artifactLoading = ref(false);
/** 产出物操作级错误 */
export const artifactError = ref<string | null>(null);
/** 全量汇总（与筛选无关；指标卡 + 侧栏徽标数据源） */
export const artifactStats = ref<{ total: number; today: number; total_size: number }>({
  total: 0,
  today: 0,
  total_size: 0,
});
/** 去重能力列表（筛选下拉数据源；随每次查询返回） */
export const artifactCapabilities = ref<string[]>([]);
/** 筛选：能力 id（下拉；空串 = 全部） */
export const artifactCapFilter = ref("");
/** 筛选：文件名子串（input 原样绑定；查询时才消费） */
export const artifactNameFilter = ref("");
/** 筛选：仅今天（今天零点本地时间折算 since） */
export const artifactTodayOnly = ref(false);
/** 已加载条数（"加载更多"追加的 offset 基准） */
export const artifactLoadedCount = ref(0);
/** 产出物页大小（与调用历史同粒度） */
export const ARTIFACT_PAGE_SIZE = 50;
/** 页面活跃标志（ArtifactPanel onActivated/onDeactivated 维护） */
export const artifactPageActive = ref(false);

/** 本地今天零点 → ISO（"仅今天"筛选的 since 参数） */
function todayStartIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** 组装当前筛选条件（空条件不下发——与 fetchHistory 同约定） */
function buildQuery(limit: number, offset: number): ArtifactListQuery {
  return {
    limit,
    offset,
    ...(artifactCapFilter.value !== "" ? { capability_contains: artifactCapFilter.value } : {}),
    ...(artifactNameFilter.value.trim() !== ""
      ? { filename_contains: artifactNameFilter.value.trim() }
      : {}),
    ...(artifactTodayOnly.value ? { since: todayStartIso() } : {}),
  };
}

/** 应用返回的汇总/能力列表（stats 与筛选无关，任何查询都随行返回） */
function applyStats(result: {
  stats: { total: number; today: number; total_size: number };
  capabilities?: string[];
}): void {
  artifactStats.value = result.stats;
  if (result.capabilities !== undefined) {
    artifactCapabilities.value = result.capabilities;
  }
}

/**
 * 拉取产出物列表：reset=true 回第一页（筛选变化 / 事件刷新 / 页面激活）；
 * reset=false 从 loadedCount 追加（"加载更多"）。
 */
export async function fetchArtifacts(reset: boolean): Promise<void> {
  if (artifactLoading.value) return; // 防重入
  artifactLoading.value = true;
  artifactError.value = null;
  try {
    const result = await getApi().listArtifacts(
      buildQuery(ARTIFACT_PAGE_SIZE, reset ? 0 : artifactLoadedCount.value),
    );
    if (reset) {
      artifacts.value = result.items;
      artifactLoadedCount.value = result.items.length;
    } else {
      // 追加去重（与 fetchHistory 同防御：刷新与加载更多交叠防重复行）
      const seen = new Set(artifacts.value.map((a) => a.file));
      const fresh = result.items.filter((a) => !seen.has(a.file));
      artifacts.value = [...artifacts.value, ...fresh];
      artifactLoadedCount.value += fresh.length;
    }
    artifactHasMore.value = result.has_more;
    applyStats(result);
  } catch (e) {
    artifactError.value = `产出物查询失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    artifactLoading.value = false;
  }
}

/**
 * 轻量汇总探测（limit=1 只为随行 stats / capabilities）：页面非活跃时的
 * 事件驱动刷新走此路径——徽标保持实时，列表数据等激活时再拉。
 */
export async function fetchArtifactStats(): Promise<void> {
  try {
    const result = await getApi().listArtifacts({ limit: 1 });
    applyStats(result);
  } catch {
    // 探测失败静默：下一次事件或页面激活会重试（徽标非关键数据）
  }
}

/** 筛选条件变化 → 重置回第一页（模板 @change 统一入口） */
export async function applyArtifactFilters(): Promise<void> {
  await fetchArtifacts(true);
}

/** "加载更多"：从已加载条数处追加下一页 */
export async function loadMoreArtifacts(): Promise<void> {
  await fetchArtifacts(false);
}

/**
 * 状态变迁事件的刷新入口（App.vue 订阅调用）：
 * 活跃 → 全量刷新列表；非活跃 → 仅 stats 探测（徽标实时）。
 */
export function onInvocationStateChanged(): void {
  if (artifactPageActive.value) {
    void fetchArtifacts(true).catch(() => undefined);
  } else {
    void fetchArtifactStats();
  }
}
