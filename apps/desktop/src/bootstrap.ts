/**
 * Workbench 核心装配共享模块（M2-06 从 headless.ts 抽出）
 *
 * headless 开发运行时（M1-09）与 Electron 应用壳（M2-06）共用同一套
 * 装配结构与选项解析：
 *   - 全套 core 模块组装（模块图见设计文档第 6 节）
 *   - 宿主路径注入（documents / userData / workspace 根，6.7：
 *     core 不 import electron，路径由本层经 app.getPath 注入）
 *   - 选项解析三级优先：环境变量覆写（测试隔离）→ settings.json → 缺省
 *
 * 本模块不含 Electron 生命周期接线（whenReady / 窗口 / 退出钩子），
 * 由各入口（headless.ts / main.ts）自行注册——保证入口职责单一。
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CapabilityRegistry,
  ExecutionRuntime,
  EventManager,
  InvocationManager,
  LogManager,
  PluginConfigStore,
  StateManager,
  WorkspaceManager,
  WsRpcServer,
  createSqliteStores,
  loadOrCreateAccessToken,
  recoverInterruptedInvocations,
  type PluginUiRelay,
} from "@kiko-workbench/core";
import { MemoryEventStore, MemoryLogStore, MemoryStateStore } from "@kiko-workbench/core";
import { createUtilityProcessLauncher, resolveHostEntryPath } from "./utility-launcher.js";

// userData 重定向（可选）：缺省 %APPDATA%/<name>，在受限环境（CI 沙箱 /
// 只读用户目录）不可写会导致 Chromium 早期崩溃——经环境变量指向可写目录。
// 模块加载即执行（两个入口共享，先于一切 app.getPath("userData") 消费）
const userDataDir = process.env["KIKO_USER_DATA_DIR"];
if (userDataDir !== undefined && userDataDir !== "") {
  app.setPath("userData", userDataDir);
}

/** settings.json 中工作空间根目录的字段名（7.4.1：与 access_token 同文件） */
export const WORKSPACE_ROOT_KEY = "workspace_root";

/** 全套 Workbench 核心模块（headless 与 M2 Electron 壳共用装配结构） */
export interface WorkbenchModules {
  registry: CapabilityRegistry;
  state: StateManager;
  events: EventManager;
  logs: LogManager;
  invocation: InvocationManager;
  workspace: WorkspaceManager;
  runtime: ExecutionRuntime;
  /** WS RPC Server（M1-11：六方法 + 事件推送，仅绑定 127.0.0.1） */
  wsServer: WsRpcServer;
  /** SQLite 存储关闭句柄（M2-01；内存存储时为 undefined） */
  closeStores?: () => void;
  /**
   * 数据库磁盘回收（VACUUM；历史清理后调用）：仅 SQLite 装配时存在，
   * 内存实现为 undefined（无文件可回收）——ipc 层可选调用。
   */
  vacuumDb?: () => void;
  /**
   * 第三方插件根目录（导入功能部署目标）：runtime.userPluginsRoot 注入
   * 源头的同一值（options.userPluginsRoot ?? resolveUserPluginsRoot()），
   * 在装配期算一次后共享，避免 ipc 层重复解析产生分叉。
   */
  userPluginsRoot: string;
  /**
   * 插件配置存储（P-002）：ctx.config 注入源头（runtime.pluginConfigs）
   * 与 IPC config:get / config:save 的同一实例——配置读写单点，
   * 避免 ipc 层另建 store 产生路径分叉。
   */
  pluginConfigs: PluginConfigStore;
}

/** 组装选项 */
export interface BootstrapOptions {
  /** 系统文档目录（读取沙箱基座，7.4.3） */
  documentsDir: string;
  /** 工作空间根（缺省 documentsDir/Kiko Workbench；冒烟测试隔离用覆写） */
  workspaceRoot?: string;
  /** 内置插件目录（registry.scan 第一根，注册优先级最高） */
  pluginsRoot: string;
  /**
   * 第三方插件目录（registry.scan 第二根；缺省不启用）。
   * 放 userData 下与安装目录分离——覆盖安装不丢用户插件（设计文档
   * 730 行 Backlog"外部插件安装机制"落地）；id 与内置冲突时内置优先。
   */
  userPluginsRoot?: string;
  /**
   * 插件配置根目录（P-002：每插件一个 <pluginId>.json；缺省
   * userData/plugin-config/）。与插件目录解耦——卸载不删配置、
   * 同 id 重装自动恢复（方案草案 §3.2）。
   */
  pluginConfigRoot?: string;
  /** utilityProcess host 入口（缺省自动解析 plugin-sdk 构建产物） */
  hostEntryPath?: string;
  /** WS 起始端口（缺省 47830；R3 占用自动 +1 重试上限 10，实际端口见 wsServer.port） */
  wsPort?: number;
  /**
   * SQLite 数据库文件路径（M2-01：提供 → 持久化存储 + 7.3 启动恢复；
   * 缺省 → 内存存储，M1 兼容模式 / 纯单测场景）
   */
  dbPath?: string;
  /**
   * WS auth / HTTP Bearer 校验的 access_token（M2-02，5.1）。
   * 缺省 undefined → 无鉴权模式（M1 兼容；生产装配必须传入）。
   */
  authToken?: string;
  /**
   * 微应用 UI 中继（P-003 v1）：shell 装配传入 PluginUiManager.relay
   * （窗口表查投递）；缺省 → runtime 内置 stub（恒 40010，headless 语义：
   * 无表面宿主调用 ctx.ui.send 即"界面未打开"）。
   */
  uiRelay?: PluginUiRelay;
}

/**
 * 组装全套核心模块并接线（模块图见设计文档第 6 节）：
 *   - 三 Manager（State / Event / Log）+ 存储（SQLite / 内存）
 *   - Registry 扫描注册内置插件
 *   - InvocationManager 与 ExecutionRuntime 经协作取消钩子互连
 *     （running 态 cancel → runtime 下发 cancel 消息 + 宽限强杀，5.3.6）
 */
export async function bootstrapWorkbench(options: BootstrapOptions): Promise<WorkbenchModules> {
  // 多根扫描（内置在前——先注册者优先，第三方同 id 插件不覆盖内置）
  const registry = new CapabilityRegistry(
    options.pluginsRoot,
    ...(options.userPluginsRoot !== undefined ? [options.userPluginsRoot] : []),
  );
  // 存储实现切换（M2-01：dbPath 提供 → SQLite 持久化；缺省 → 内存 M1 兼容）
  const stores =
    options.dbPath !== undefined
      ? createSqliteStores(options.dbPath)
      : {
          state: new MemoryStateStore(),
          events: new MemoryEventStore(),
          logs: new MemoryLogStore(),
          close: undefined as undefined | (() => void),
          // 内存实现无磁盘文件，VACUUM 无意义（历史清理后置空即可）
          vacuum: undefined as undefined | (() => void),
        };
  const state = new StateManager(stores.state);
  const events = new EventManager(stores.events);
  const logs = new LogManager(stores.logs);

  // 7.3 启动恢复：pending/running 残留 → failed + 补发事件（内存态空操作）。
  // 时序在 WS Server 启动前——恢复事件先落库，订阅者接入后经查询可见
  const recovered = recoverInterruptedInvocations({ state, events });
  if (recovered > 0) {
    console.log(`[kiko] 启动恢复：${recovered} 条中断 invocation 已标记 failed`);
  }
  const workspace = new WorkspaceManager({
    documentsDir: options.documentsDir,
    workspaceRoot: options.workspaceRoot,
  });

  // 协作取消桥接：InvocationManager 构造期需要钩子而 runtime 构造期需要
  // invocation（循环依赖）——经可变引用容器在两者构造完成后接线
  const cancelBridge: { hook?: (invocationId: string) => void } = {};
  const invocation = new InvocationManager({
    registry,
    state,
    events,
    logs,
    onCancelRequested: (invocationId) => cancelBridge.hook?.(invocationId),
  });

  // 第三方插件根：装配期解析一次（runtime 注入 + modules 透出共享，
  // 避免 ipc 导入功能二次解析分叉）
  const userPluginsRoot = options.userPluginsRoot ?? resolveUserPluginsRoot();

  // 插件配置存储（P-002）：单实例装配——runtime 注入（ctx.config 源头）
  // 与 IPC 读写共用（保存后 disposePlugin 终止进程 → 下次懒启动读新值）
  const pluginConfigs = new PluginConfigStore(
    options.pluginConfigRoot ?? resolvePluginConfigRoot(),
  );

  const runtime = new ExecutionRuntime({
    registry,
    invocation,
    state,
    events,
    logs,
    workspace,
    // PluginContext.userPluginsRoot 注入源头（S2）：options 未提供时收敛
    // 到缺省第三方根（resolveUserPluginsRoot 幂等预建目录；不影响上面
    // registry 的多根扫描行为——未提供 options.userPluginsRoot 时仅扫内置根）
    userPluginsRoot,
    // PluginContext.esbuildBinaryPath 注入源头（S8）：三级解析均失败 →
    // 空串（sdk.build 调用时明示报错，不阻断其余能力）
    esbuildBinaryPath: resolveEsbuildBinary() ?? "",
    // PluginContext.config 注入源头（P-002）：读侧 default 合并 + 未知
    // 字段透传 + 损坏容错（config-store 职责），runtime 零加工透传
    pluginConfigs,
    // P-003：微应用窗口投递中继（shell 传 PluginUiManager.relay；缺省
    // 内置 stub 恒 40010——headless / 现有单测语义不变）
    ...(options.uiRelay !== undefined ? { uiRelay: options.uiRelay } : {}),
    launcher: createUtilityProcessLauncher({
      hostEntryPath: options.hostEntryPath ?? resolveHostEntryPath(),
    }),
  });
  cancelBridge.hook = (invocationId) => runtime.onCancelRequested(invocationId);

  // WS RPC Server（M1-11 + M2-02）：六方法接线 + 事件推送 + 双通道鉴权
  // （R3 端口探测内建于 start；authToken 提供 → WS auth / HTTP Bearer）
  const wsServer = new WsRpcServer(
    { registry, invocation, runtime, events, state },
    { port: options.wsPort, authToken: options.authToken },
  );
  await wsServer.start();

  await registry.scan();
  return {
    registry,
    state,
    events,
    logs,
    invocation,
    workspace,
    runtime,
    wsServer,
    closeStores: stores.close,
    vacuumDb: stores.vacuum,
    userPluginsRoot,
    pluginConfigs,
  };
}

// ---------------------------------------------------------------------------
// 选项解析（环境变量覆写 → settings.json → 缺省；headless 与壳共享）
// ---------------------------------------------------------------------------

/** 环境变量路径覆写：未设置 / 空串返回 undefined（走缺省） */
export function resolveEnvPath(key: string): string | undefined {
  const raw = process.env[key];
  return raw !== undefined && raw !== "" ? raw : undefined;
}

/**
 * 解析内置插件目录（M2-10a 打包适配）：
 * KIKO_PLUGINS_ROOT 覆写 → 打包产物 resources/plugins（app.isPackaged）
 * → 开发态工程默认 packages/plugins。
 *
 * 打包布局：electron-builder extraResources 把 build-resources/plugins
 * （esbuild 自包含 bundle + manifest/capabilities）复制到安装目录
 * resources/plugins——asar 外普通目录，host 动态 import 绝对路径加载。
 */
export function resolvePluginsRoot(): string {
  const override = resolveEnvPath("KIKO_PLUGINS_ROOT");
  if (override !== undefined) return override;
  if (app.isPackaged) {
    // process.resourcesPath：打包产物 = <安装目录>/resources；
    // 开发态 electron . 运行时该值无意义（走下面工程默认）
    return join(process.resourcesPath, "plugins");
  }
  // app.getAppPath() = apps/desktop（electron . 运行）→ 工程根 ../../
  return join(app.getAppPath(), "..", "..", "packages", "plugins");
}

/**
 * 解析第三方插件目录：KIKO_USER_PLUGINS_ROOT 覆写（测试隔离）→
 * userData/plugins（%APPDATA%/kiko-workbench-desktop/plugins）。
 *
 * 与内置目录分离的动因（用户数据与程序文件分离铁律）：
 *   - 覆盖安装：NSIS 升级清空安装目录 resources 下的用户文件
 *   - 权限：perMachine 安装（Program Files）普通用户对 resources 只读
 *   - 内置插件随版本演进，第三方插件归用户所有——生命周期本就不同
 *
 * 目录预创建（对齐 resolveDbPath / resolveAuthToken 惯例）：第三方
 * 开发者按文档"放入 userData/plugins"时目录应已存在——Explorer 中
 * 手工建层极易把插件文件夹错放 userData 根下；空目录扫描=空结果，
 * 对注册表零副作用。
 */
export function resolveUserPluginsRoot(): string {
  const override = resolveEnvPath("KIKO_USER_PLUGINS_ROOT");
  const userPluginsRoot = override ?? join(app.getPath("userData"), "plugins");
  mkdirSync(userPluginsRoot, { recursive: true });
  return userPluginsRoot;
}

/**
 * 解析插件配置根目录（P-002）：KIKO_PLUGIN_CONFIG_ROOT 覆写（测试隔离）→
 * userData/plugin-config。
 *
 * 与插件目录解耦的动因（方案草案 §3.2）：卸载插件不删配置（同 id 重装
 * 自动恢复）、导出 zip 不含配置（用户数据不随插件分发给他人）。
 * 目录不预创建：save 时 mkdir recursive 懒建（只读路径无文件即空配置，
 * 预建空目录对用户无发现价值——与 userPluginsRoot 的差别）。
 */
export function resolvePluginConfigRoot(): string {
  const override = resolveEnvPath("KIKO_PLUGIN_CONFIG_ROOT");
  return override ?? join(app.getPath("userData"), "plugin-config");
}

/**
 * 解析 esbuild CLI 二进制路径（S8，零 Shell 自举方案 3.4）：
 * KIKO_ESBUILD_BINARY 覆写（测试隔离）→ 打包产物
 * resources/esbuild/esbuild.exe（app.isPackaged，extraResources 分发）
 * → 开发态 @esbuild/win32-x64 包内二进制（createRequire 解析）。
 *
 * 用 CLI 二进制而非 JS API 的原因：esbuild JS API 源码显式拒绝被
 * bundle（"The esbuild JavaScript API cannot be bundled"），插件产物
 * 必须自包含单文件——经二进制路径注入、插件进程内 spawn 是唯一可行
 * 形态（node:child_process 属插件规范第 9 节白名单）。
 *
 * 三级解析均失败返回 undefined → runtime 以空串注入，sdk.build 调用时
 * 报 50001（缺二进制明示，而非启动期快死——工作台其余能力不受影响）。
 */
export function resolveEsbuildBinary(): string | undefined {
  const override = resolveEnvPath("KIKO_ESBUILD_BINARY");
  if (override !== undefined) return override;
  // 平台二进制包名（仅 Windows 分发，方案 2 节非目标约束）
  const platformPackage = "@esbuild/win32-x64";
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "esbuild", "esbuild.exe");
    if (existsSync(packaged)) return packaged;
  }
  try {
    // createRequire 兼容 ESM 主进程：从本文件位置解析平台二进制包目录
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve(`${platformPackage}/package.json`));
    const devBinary = join(pkgDir, "esbuild.exe");
    if (existsSync(devBinary)) return devBinary;
  } catch {
    // 包不存在（pnpm 依赖裁剪等）→ 落到 undefined
  }
  return undefined;
}

/**
 * 解析 MCP 适配器入口路径（M3，"MCP 接入"模态数据源）：
 * KIKO_MCP_ADAPTER 覆写（测试隔离）→ 打包产物 resources/mcp-adapter/
 * main.js（app.isPackaged，extraResources 分发）→ 开发态工程默认
 * packages/mcp-adapter/dist/main.js（tsc 产物）。
 *
 * 解析均失败（开发态未构建 / 打包产物缺失）返回 undefined → 模态展示
 * 引导文案而非给出不可用路径（用户照抄必然失败，宁可明示）。
 * 与 resolveEsbuildBinary 同策略：功能可选，不阻断启动。
 */
export function resolveMcpAdapterPath(): string | undefined {
  const override = resolveEnvPath("KIKO_MCP_ADAPTER");
  if (override !== undefined) return override;
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "mcp-adapter", "main.js");
    if (existsSync(packaged)) return packaged;
    return undefined;
  }
  // app.getAppPath() = apps/desktop（electron . 运行）→ 工程根 ../../
  const dev = join(app.getAppPath(), "..", "..", "packages", "mcp-adapter", "dist", "main.js");
  return existsSync(dev) ? dev : undefined;
}

/** WS 起始端口：KIKO_WS_PORT 覆写 → 缺省 47830（设计文档第 3 节要点 2） */
export function resolveWsPort(): number | undefined {
  const raw = process.env["KIKO_WS_PORT"];
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  // 非法值按缺省处理（开发运行时宽容策略，不值得快死）
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** 文档目录：KIKO_DOCUMENTS_DIR 覆写 → 缺省系统文档目录（冒烟测试隔离用） */
export function resolveDocumentsDir(fallback: string): string {
  return resolveEnvPath("KIKO_DOCUMENTS_DIR") ?? fallback;
}

/**
 * SQLite 数据库路径（M2-01）：KIKO_DB_PATH 覆写（测试隔离 / ":memory:"）
 * → 缺省 userData/kiko.db（Electron 惯例：应用数据随用户目录走）。
 * 父目录保障：SQLite 只建文件不建目录，userData 受 KIKO_USER_DATA_DIR
 * 重定向影响可能不存在。
 */
export function resolveDbPath(): string {
  const override = resolveEnvPath("KIKO_DB_PATH");
  if (override !== undefined) return override;
  const dbPath = join(app.getPath("userData"), "kiko.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}

/**
 * settings.json 路径（7.4.1：userData；KIKO_SETTINGS_PATH 覆写用于
 * 测试隔离）。工作空间根目录位置与 access_token 同居此文件。
 */
export function resolveSettingsPath(): string {
  const override = resolveEnvPath("KIKO_SETTINGS_PATH");
  if (override !== undefined) return override;
  return join(app.getPath("userData"), "settings.json");
}

/**
 * 工作空间根目录位置（M2-06：settings.json 读取）。
 * 优先级：KIKO_WORKSPACE_ROOT 环境变量（冒烟隔离）> settings.json 的
 * workspace_root 字段 > undefined（WorkspaceManager 缺省 documentsDir/
 * Kiko Workbench）。
 * 损坏 JSON 抛 SyntaxError 快死（与 auth.ts 同策略：静默忽略会掩盖
 * 用户配置损坏）。
 */
export function resolveWorkspaceRoot(settingsPath: string): string | undefined {
  const override = resolveEnvPath("KIKO_WORKSPACE_ROOT");
  if (override !== undefined) return override;
  if (!existsSync(settingsPath)) return undefined;
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  const value = settings[WORKSPACE_ROOT_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * access_token 加载（M2-02，5.1）：KIKO_NO_AUTH=1 → 显式关闭鉴权
 * （M1 冒烟兼容 / 内部注入场景）；缺省启用——settings.json 读-改-写，
 * 首次启动生成并持久化（token 跨重启稳定，客户端读同一文件获取）。
 */
export function resolveAuthToken(): string | undefined {
  if (process.env["KIKO_NO_AUTH"] === "1") {
    console.log("[kiko] 鉴权已禁用（KIKO_NO_AUTH=1，仅限开发 / 测试场景）");
    return undefined;
  }
  const settingsPath = resolveSettingsPath();
  // 父目录保障：settings.json 与 kiko.db 同居 userData（resolveDbPath 已建，
  // 但两者解析顺序不保证，此处幂等再建一次）
  mkdirSync(dirname(settingsPath), { recursive: true });
  const token = loadOrCreateAccessToken(settingsPath);
  console.log(`[kiko] 鉴权已启用：token 位于 ${settingsPath}`);
  return token;
}
