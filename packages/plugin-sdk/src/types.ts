/**
 * 插件开发者接口类型（设计文档 8.4）
 *
 * 这是插件作者唯一需要面对的接口层：
 *   - KikoPlugin         插件对象（setup / handle / teardown）
 *   - PluginContext      初始化上下文（load 后一次）
 *   - InvocationContext  能力执行上下文（每个 invocation 一次，
 *                        含 progress / log / isCancelled / artifacts）
 *
 * 依赖约束（设计文档第 4 节）：本包对 protocol 仅类型依赖，
 * 插件不得 import electron / core —— 依赖方向不可倒置。
 */
import type { ArtifactInfo } from "@kiko-workbench/protocol";

/**
 * 产物信息（protocol 7.1 的必要类型透出）：ctx.artifacts.save 的返回
 * 类型属于 8.4 插件接口形状的一部分——插件作者消费登记信息
 * （file / filename / mime_type…）需要此类型，与 RpcError 的 re-export 同理。
 */
export type { ArtifactInfo };

/** 插件初始化上下文：load 后调用 setup(ctx) 时注入 */
export interface PluginContext {
  /** 本插件 id（manifest.id），用于日志与产物目录定位 */
  pluginId: string;
  /** 工作空间根目录（workspace/<plugin_id>/ 为本插件产物目录） */
  workspaceRoot: string;
  /**
   * 系统文档目录（file.read / file.list 的读取沙箱基座，7.4.3）。
   * M1-09 扩展字段（见偏差表 2026-08-20）——插件经 resolveSafe(documentsDir, path)
   * 校验读取路径，不得越界。
   */
  documentsDir: string;
  /**
   * 第三方插件根目录（%APPDATA%/…/plugins，多根扫描第二根，6.1）。
   * S2 扩展字段（见偏差表 2026-09-01）——sdk 分发插件的 install_guide
   * 需向 Agent 声明部署目标；插件自身无法跨平台可靠推断，由主进程注入。
   */
  userPluginsRoot: string;
  /**
   * esbuild CLI 二进制绝对路径（S8 扩展字段，见偏差表 2026-09-01）——
   * sdk 分发插件的 sdk.build 能力内部 spawn 该二进制完成零 shell 构建
   * （alias 改道 vendor 物料，免 npm install）。解析：env 覆写 →
   * resources/esbuild（安装版）→ 开发态 node_modules。注入值对所有插件
   * 可见但仅文档化给内置 sdk 插件消费（信息无危害）。
   */
  esbuildBinaryPath: string;
  /**
   * 插件配置值（P-002 Phase 1 扩展字段，见方案草案 §3.4）：
   * manifest.contributes.configuration 声明的配置——已保存值合并
   * schema default，schema 未声明的旧字段（改名/删除前保存的）原样
   * 透传（插件做配置结构迁移的数据来源）。未声明配置的插件注入 {}
   * （字段始终存在，插件可安全解构）。load 时一次性快照——运行中
   * 保存的新值需重启插件进程后生效（与"重启生效"的文件重载语义一致）。
   */
  config: Record<string, unknown>;
  /**
   * 微应用前端通道（P-003 v1 扩展字段，见方案草案附录 C）：后端 → 前端
   * 单向消息下发。未声明 contributes.ui 的插件该字段同样存在——调用
   * 始终 reject 40010（无表面可投递），接口形状稳定（与 config 注入 {}
   * 同策略）。setup 时一次性注入，插件保存 ctx 引用后可在任意时刻调用
   * （如 handle 内推送执行结果、setup 定时刷新仪表盘）。
   */
  ui: {
    /**
     * 向本插件微应用前端窗口下发消息（v1 仅支持结构化克隆安全的值）。
     * 表面未打开（或插件无 ui 声明）→ reject RpcError 40010
     * （PLUGIN_UI_NOT_OPEN）。resolve 仅代表投递确认，不代表前端已渲染。
     */
    send(payload: unknown): Promise<void>;
  };
}

/** 能力执行上下文：每个 invocation 桥接一次（由 plugin-host 注入实现） */
export interface InvocationContext {
  /** 上报进度（0-100），触发 execution.progress 事件 */
  progress(percent: number, message?: string): void;
  /** 写执行日志（Log，非 Event，设计文档 6.6：Event 与 Log 严格分离） */
  log(message: string): void;
  /** 协作式取消检查点：长循环中主动轮询（host 收 cancel 后置位） */
  isCancelled(): boolean;
  /** 产物保存与登记（设计文档 7.4）：插件生成文件的唯一合法落盘入口 */
  artifacts: {
    /**
     * 落盘到 workspace/<plugin_id>/，同名自动追加序号（" (2)"、" (3)" 递增），
     * 返回最终产物信息（filename 为实际落盘名）。
     * filename 仅允许纯文件名（禁止路径分隔符与 ".."）。
     */
    save(filename: string, data: Buffer | string, mime_type?: string): Promise<ArtifactInfo>;
    /** 自行写盘后登记（file.write 的覆盖语义用，不自动改名） */
    register(file: string, filename: string, mime_type: string, size: number): void;
  };
  /**
   * 微应用前端通道（P-003 v1）：与 PluginContext.ui 为同一插件级通道
   * （非 invocation 级），两处入口仅为作者便利——handle 内直接可用，
   * 免去 setup 保存 ctx 引用的样板代码。语义同 PluginContext.ui。
   */
  ui: {
    /** 向本插件微应用前端窗口下发消息；表面未打开 → reject RpcError 40010 */
    send(payload: unknown): Promise<void>;
  };
}

/**
 * 插件对象：插件 entry 导出的唯一形状（设计文档 8.4）。
 * 实现示例见 packages/plugins/file。
 */
export interface KikoPlugin {
  /** 初始化（可选）：load 后调用一次 */
  setup?(ctx: PluginContext): Promise<void>;
  /** 能力执行入口：每个 invocation 调用一次；返回值作为 result.data 回填 */
  handle(capabilityId: string, input: unknown, ctx: InvocationContext): Promise<unknown>;
  /** 进程回收前清理钩子（可选） */
  teardown?(): Promise<void>;
}
