/**
 * IPC 通道共享契约（M2-06；设计文档第 10 节）
 *
 * 主进程 ipc.ts（实现）、preload.ts（桥接）、渲染进程（消费）三方
 * 共用的通道名常量与视图类型——纯类型 / 常量，零 electron 依赖，
 * 保证渲染进程经 vite 构建时不引入主进程模块。
 *
 * 通道设计（10 节）：workbench:plugin:list/toggle、
 * workbench:invocation:list/detail、workbench:artifact:show-in-folder、
 * workbench:event:subscribe（主进程 → 渲染进程单向推送）。
 */
import type {
  ArtifactInfo,
  ExecutionDetail,
  ExecutionEvent,
  ExecutionLog,
  InvocationStatus,
} from "@kiko-workbench/protocol";
// P-002：配置 schema / 校验错误类型（type-only，vite 构建期擦除——
// 渲染进程运行时不引入 core；类型面在 shared 单点收敛，同 protocol 透出惯例）
import type { ConfigurationSchema, ConfigFieldError } from "@kiko-workbench/core";

/**
 * 协议类型透出（渲染进程只经 shared 拿类型，不直接依赖 protocol 包名——
 * vite 渲染构建的依赖面收敛在 shared 单点）。
 */
export type { ArtifactInfo, ExecutionDetail, ExecutionEvent, ExecutionLog, InvocationStatus };

/**
 * 配置类型透出（P-002，同上收敛原则）：SchemaForm / PluginPanel 消费，
 * type-only 依赖 core——构建期擦除，渲染产物不引入 core 运行时。
 */
export type { ConfigurationSchema, ConfigurationProperty, ConfigFieldError } from "@kiko-workbench/core";

// ---------------- 通道名（ipcMain.handle / webContents.send） ----------------

/** 插件卡片列表（10 节插件区块数据源） */
export const WORKBENCH_PLUGIN_LIST = "workbench:plugin:list";

/** 插件启停（enabled ↔ disabled；error → enabled 即"重新启用"） */
export const WORKBENCH_PLUGIN_TOGGLE = "workbench:plugin:toggle";

/** 导入插件（zip 包 → 解包校验 → 部署到第三方根 → rescan 生效） */
export const WORKBENCH_PLUGIN_IMPORT = "workbench:plugin:import";

/** 导出插件（第三方插件目录 → zip 单文件，用户选择保存路径） */
export const WORKBENCH_PLUGIN_EXPORT = "workbench:plugin:export";

/** 卸载第三方插件（终止进程 → 删目录 → 移除注册；内置插件拒绝） */
export const WORKBENCH_PLUGIN_UNINSTALL = "workbench:plugin:uninstall";

/** 插件配置读取（P-002 §3.7：schema + 合并值；未声明配置返回 null） */
export const WORKBENCH_PLUGIN_CONFIG_GET = "workbench:plugin:config:get";

/** 插件配置保存（P-002 §3.7：校验 + 合并写 + 终止运行中插件进程） */
export const WORKBENCH_PLUGIN_CONFIG_SAVE = "workbench:plugin:config:save";

/**
 * 打开插件微应用界面（P-003 v1）：渲染进程"打开界面"按钮 → 主进程
 * 单实例窗口管理（已开聚焦，未开新建）。非微应用插件（无 uiEntry）
 * 主进程抛 40005。
 */
export const WORKBENCH_PLUGIN_UI_OPEN = "workbench:plugin:ui:open";

/**
 * 微应用消息下发通道（P-003 v1，主进程 → 微应用窗口单向）：
 * PluginUiRelay.send → webContents.send → 微应用 preload（window.kikoPluginUi）。
 * 通道名与主窗口事件通道（WORKBENCH_EVENT_CHANNEL）区分——不同窗口不同桥。
 */
export const PLUGIN_UI_MESSAGE_CHANNEL = "plugin-ui:message";

/** invocation 列表（10 节调用历史区块数据源） */
export const WORKBENCH_INVOCATION_LIST = "workbench:invocation:list";

/** 单条 invocation 完整 Trace（事件时间线 + 日志 + Result/Error + 产物） */
export const WORKBENCH_INVOCATION_DETAIL = "workbench:invocation:detail";

/** 清空调用历史（仅终态记录；事件/日志级联删除，SQLite 装配时 VACUUM 回收磁盘） */
export const WORKBENCH_HISTORY_CLEAR = "workbench:history:clear";

/** 在系统文件管理器中定位产物文件（shell.showItemInFolder） */
export const WORKBENCH_ARTIFACT_SHOW = "workbench:artifact:show-in-folder";

/** 产物跨 invocation 分页查询（产出物页数据源；汇总 + 去重能力列表随行返回） */
export const WORKBENCH_ARTIFACT_LIST = "workbench:artifact:list";

/** 事件推送通道（主进程 → 渲染进程单向；渲染进程经 preload 订阅/退订） */
export const WORKBENCH_EVENT_CHANNEL = "workbench:event";

/** Agent 接入信息查询（顶栏"Agent 接入"按钮 + 首次启动引导数据源） */
export const WORKBENCH_CONNECTION_INFO = "workbench:connection:info";

/** 写系统剪贴板（通用能力：复制接入指南 / 产物路径等；Electron clipboard 主进程实现，规避 navigator.clipboard 在 file:// 生产环境的兼容风险） */
export const WORKBENCH_CLIPBOARD_WRITE = "workbench:clipboard:write";

// ---------------- 视图类型（渲染进程消费形状） ----------------

/** 插件卡片（PluginRecord 的 UI 视图：剔除 entry / rootDir 等主进程细节） */
export interface PluginCard {
  id: string;
  name: string;
  description: string;
  version: string;
  status: "enabled" | "disabled" | "error";
  /** status === "error" 时的崩溃原因（10 节：error 卡片展示） */
  error_reason?: string;
  /** 该插件注册的能力数（含 disabled / error 态——注册与运行态无关） */
  capability_count: number;
  /** 插件来源：builtin = 内置（禁止删除），third_party = 第三方（可导入/导出/删除） */
  source: "builtin" | "third_party";
  /** P-002：是否声明配置（contributes.configuration）——卡片"设置"入口依据 */
  has_config: boolean;
  /** P-002：是否存在已保存配置值——卡片"已配置"状态圆点依据 */
  config_saved: boolean;
  /** P-003：是否声明微应用界面（contributes.ui.entry）——卡片"打开界面"按钮依据 */
  has_ui: boolean;
}

/** 导入插件结果（导入成功后前端刷新插件列表） */
export interface PluginImportResult {
  /** 新注册的插件 id（manifest.id） */
  plugin_id: string;
  /** rescan 结果透出（added 含目标 id 即成功；冲突 / 校验失败直接抛错不会走到这） */
  rescan: { added: string[]; removed: string[]; skipped: Array<{ id: string; reason: string }> };
}

/**
 * 插件配置视图（P-002 §3.7 config:get 响应）：
 * values = 已保存值合并 schema default（与 ctx.config 注入值同源同形），
 * secret 字段返回明文——本地 IPC（contextIsolation + preload 桥），
 * 无跨进程暴露面，表单回显需要明文。
 */
export interface PluginConfigView {
  /** manifest 声明的配置 schema（渲染器据此自动生成表单） */
  schema: ConfigurationSchema;
  /** 合并值（已保存 + default；含未知字段透传） */
  values: Record<string, unknown>;
}

/**
 * 配置保存结果（P-002 §3.7 config:save 响应）：
 * 校验失败返回错误列表（表单按 path 内联展示到字段下方），
 * 结构化返回而非抛错——非 RPC 语义（草案 §3.7）。
 */
export type PluginConfigSaveResult = { ok: true } | { ok: false; errors: ConfigFieldError[] };

/** invocation 列表项（10 节：时间 / 能力 / 状态 / 耗时） */
export interface InvocationListItem {
  invocation_id: string;
  capability_id: string;
  /** 外部五值状态（pending / running / completed / failed / cancelled） */
  status: InvocationStatus;
  mode: "sync" | "async";
  /** ISO 8601 UTC */
  created_at: string;
  ended_at?: string;
  /** 执行耗时 ms（running 态为已运行时长；未开始为 undefined） */
  duration_ms?: number;
  /** 产物数（列表角标；详情见 detail 的 artifacts） */
  artifact_count: number;
}

/**
 * 调用历史查询参数（M2-08：数据量控制——分页 + 筛选，存储层 SQL 下推）。
 * 条件 AND 组合；省略全部条件 = 仅分页（新 → 旧）。
 */
export interface InvocationListQuery {
  /** 页大小（1..500，缺省 50） */
  limit?: number;
  /** 偏移（≥0，缺省 0） */
  offset?: number;
  /** 状态筛选（外部五值） */
  status?: InvocationStatus;
  /** 能力 id 子串（大小写不敏感） */
  capability_contains?: string;
  /** 仅今天（渲染进程把"今天零点"折算为 ISO；主进程按 created_at ≥ since 过滤） */
  since?: string;
}

/** 列表查询响应：items 为当前页；has_more 表示还有下一页（"加载更多"按钮） */
export interface InvocationListResult {
  items: InvocationListItem[];
  has_more: boolean;
}

/** 产物列表项（产出物页表格行：跨 invocation 扁平视图 + 来源能力） */
export interface ArtifactListItem {
  invocation_id: string;
  capability_id: string;
  /** 产物绝对路径（工作空间沙箱内；"打开所在文件夹"与 Trace 反查共用） */
  file: string;
  relative_path: string;
  filename: string;
  mime_type: string;
  size: number;
  /** 产物登记时间（ISO 8601 UTC） */
  created_at: string;
}

/** 产物查询参数（语义对齐 InvocationListQuery：条件 AND 组合，SQL 下推） */
export interface ArtifactListQuery {
  /** 页大小（1..500，缺省 50） */
  limit?: number;
  /** 偏移（≥0，缺省 0） */
  offset?: number;
  /** 能力 id 子串（大小写不敏感；经 JOIN invocations 过滤） */
  capability_contains?: string;
  /** 文件名子串（大小写不敏感） */
  filename_contains?: string;
  /** 仅指定时间后（ISO 8601；渲染层把"今天零点"折算为 since） */
  since?: string;
}

/** 产物汇总（全量口径，与筛选无关；指标卡 / 侧栏徽标数据源） */
export interface ArtifactStatsView {
  total: number;
  today: number;
  total_size: number;
  /** 去重能力 id（按最近登记倒序封顶 100；筛选下拉数据源） */
  capabilities: string[];
}

/** 产物查询响应：当前页 + has_more + 全量汇总 */
export interface ArtifactListResult {
  items: ArtifactListItem[];
  has_more: boolean;
  stats: ArtifactStatsView;
}

/**
 * IPC 响应信封：ipcMain.handle 抛出的 RpcError 经 structured clone 后
 * 丢失 code（只剩 message）——统一包装为显式信封，preload 侧解包重抛。
 */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; code: number; message: string };

/**
 * Agent 接入信息（"Agent 接入"模态数据源）：服务端点 + 鉴权凭据 +
 * 首次引导标记。端点由主进程运行时拼装——端口冲突自动 +1 重试
 * （ws-server.ts），实际监听端口可能非默认 47830，不能静态写死。
 */
export interface ConnectionInfo {
  /** WS 端点（ws://127.0.0.1:<port>，外部 Agent 推荐通道） */
  wsUrl: string;
  /** HTTP 同步通道端点（http://127.0.0.1:<port>/rpc） */
  httpUrl: string;
  /** 鉴权 token（KIKO_NO_AUTH=1 无鉴权模式时为 undefined） */
  token?: string;
  /**
   * MCP 适配器入口绝对路径（"MCP 接入"模态数据源；M3 stdio 网关形态）。
   * undefined = 适配器不可用（开发态未构建 / 打包产物缺失）——模态
   * 展示引导文案而非给出不可用路径。
   */
  mcpAdapterPath?: string;
  /**
   * 首次启动引导（查询即置位——本次 true 下次 false）：
   * 渲染进程拿到 true 时自动弹出接入指南模态（新用户零发现成本）。
   */
  showGuide: boolean;
}

/**
 * 微应用前端桥（P-003 v1）：plugin-ui-preload 暴露给微应用页面的
 * window.kikoPluginUi 形状。v1 仅单向下发订阅（后端 ctx.ui.send →
 * 前端 onMessage）；前端 → 后端事件上报留 v2（方案草案附录 C 决策）。
 */
export interface KikoPluginUiApi {
  /**
   * 订阅后端下发消息（ctx.ui.send 的 payload）；返回退订函数。
   * 页面加载即订阅——微应用常规形态为"接收推送刷新视图"。
   */
  onMessage(listener: (payload: unknown) => void): () => void;
}

/** preload 暴露给渲染进程的 API 形状（window.workbench） */
export interface WorkbenchApi {
  /** 插件卡片列表 */
  listPlugins(): Promise<PluginCard[]>;
  /** 插件启停（enabled=true 且原 error 态 → 重新启用语义） */
  togglePlugin(pluginId: string, enabled: boolean): Promise<void>;
  /**
   * 导入插件 zip 包：主进程弹文件选择框 → 解包校验（manifest / 路径穿越 /
   * ID 冲突）→ 部署到第三方插件根 → rescan 生效。
   * 冲突 / 校验失败抛携 code 的 Error（40008 ID 冲突 / -32602 参数无效）；
   * 用户取消对话框返回 null（非错误）。
   */
  importPlugin(): Promise<PluginImportResult | null>;
  /**
   * 导出第三方插件：主进程弹保存框 → 插件目录打包为 zip 写入用户路径。
   * 内置插件抛 40009。用户取消对话框时返回 null（非错误）。
   */
  exportPlugin(pluginId: string): Promise<string | null>;
  /**
   * 卸载第三方插件：终止进程 → 删除插件目录 → 移除注册条目。
   * 内置插件抛 40009（BUILTIN_PLUGIN_PROTECTED）。
   */
  uninstallPlugin(pluginId: string): Promise<void>;
  /**
   * 插件配置读取（P-002）：schema + 合并值（表单初始化数据源）。
   * 未声明配置的插件返回 null（卡片设置入口仅对 has_config 插件展示，
   * 正常流程不会调到；防御性返回而非抛错）。
   */
  getPluginConfig(pluginId: string): Promise<PluginConfigView | null>;
  /**
   * 插件配置保存（P-002）：主进程 Ajv 校验兜底 + 合并写 + 终止运行中
   * 插件进程（下次调用懒启动即注入新配置）。校验失败返回 errors 列表
   * （结构化，表单内联展示）；required 阻断在前端（保存按钮禁用）。
   */
  savePluginConfig(
    pluginId: string,
    values: Record<string, unknown>,
  ): Promise<PluginConfigSaveResult>;
  /**
   * 打开插件微应用界面（P-003 v1）：单实例窗口（已开聚焦）。
   * 非微应用插件（无 contributes.ui 声明）抛 40005。
   */
  openPluginUi(pluginId: string): Promise<void>;
  /** 调用历史分页查询（新→旧；条件见 InvocationListQuery） */
  listInvocations(query?: InvocationListQuery): Promise<InvocationListResult>;
  /** 单条 Trace（事件 + 日志 + Result/Error + 产物；40003 语义同 RPC） */
  getExecution(invocationId: string): Promise<ExecutionDetail>;
  /**
   * 清空调用历史：仅终态记录（completed/failed/cancelled），运行中的
   * 调用保留；事件/日志级联删除，SQLite 装配时 VACUUM 回收磁盘空间。
   * 返回清理条数（0 = 无终态记录可清）。
   */
  clearHistory(): Promise<number>;
  /** 系统文件管理器中定位产物文件（主进程校验工作空间白名单） */
  showArtifactInFolder(absolutePath: string): Promise<void>;
  /** 产物跨 invocation 分页查询（新→旧；含全量汇总与去重能力列表） */
  listArtifacts(query?: ArtifactListQuery): Promise<ArtifactListResult>;
  /**
   * 订阅全量实时事件（单向推送）；返回退订函数。
   * 注意：渲染进程自身发起的调用产生的事件同样推送（10 节实时事件流区块）。
   */
  subscribeEvents(listener: (event: unknown) => void): () => void;
  /**
   * Agent 接入信息（端点 / token / 首次引导标记）——"Agent 接入"模态
   * 数据源；showGuide=true 时渲染进程自动弹模态（首次启动一次）。
   */
  getConnectionInfo(): Promise<ConnectionInfo>;
  /** 写系统剪贴板（接入指南复制；主进程 Electron clipboard 实现） */
  writeClipboard(text: string): Promise<void>;
}
