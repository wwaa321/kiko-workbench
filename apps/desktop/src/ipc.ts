/**
 * 四组 IPC 通道实现（M2-06；设计文档第 10 节）
 *
 * UI 不走网络协议（第 3 节要点 4）：渲染进程经 ipcMain.handle 直调
 * core 模块方法，WS/HTTP 通道仅供外部 Agent 接入。本模块是 core 与
 * BrowserWindow 之间的桥：
 *   - workbench:plugin:list / toggle → CapabilityRegistry
 *   - workbench:invocation:list / detail → StateManager / InvocationManager
 *   - workbench:artifact:show-in-folder → shell.showItemInFolder
 *   - workbench:event（单向推送）→ EventManager.subscribe → webContents.send
 *
 * 错误信封：RpcError 经 structured clone 丢 code——handler 内 catch 统一
 * 包装 IpcEnvelope（shared.ts），preload 侧解包重抛。
 */
import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { ERROR_CODES, RpcError } from "@kiko-workbench/protocol";
import type { InvocationStatus } from "@kiko-workbench/protocol";
import {
  clearInvocationHistory,
  exportPluginToZip,
  importPluginFromZip,
  rmWithRetry,
  toExternalStatus,
} from "@kiko-workbench/core";
import type { EventListener } from "@kiko-workbench/core";
import { resolveMcpAdapterPath, type WorkbenchModules } from "./bootstrap.js";
import type { PluginUiManager } from "./plugin-ui.js";
import {
  WORKBENCH_ARTIFACT_LIST,
  WORKBENCH_ARTIFACT_SHOW,
  WORKBENCH_CLIPBOARD_WRITE,
  WORKBENCH_CONNECTION_INFO,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_HISTORY_CLEAR,
  WORKBENCH_INVOCATION_DETAIL,
  WORKBENCH_INVOCATION_LIST,
  WORKBENCH_PLUGIN_CONFIG_GET,
  WORKBENCH_PLUGIN_CONFIG_SAVE,
  WORKBENCH_PLUGIN_EXPORT,
  WORKBENCH_PLUGIN_IMPORT,
  WORKBENCH_PLUGIN_LIST,
  WORKBENCH_PLUGIN_TOGGLE,
  WORKBENCH_PLUGIN_UI_OPEN,
  WORKBENCH_PLUGIN_UNINSTALL,
  type ArtifactListItem,
  type ArtifactListQuery,
  type ArtifactListResult,
  type ConnectionInfo,
  type InvocationListItem,
  type InvocationListQuery,
  type InvocationListResult,
  type IpcEnvelope,
  type PluginCard,
  type PluginConfigSaveResult,
  type PluginConfigView,
  type PluginImportResult,
} from "./shared.js";

/** handler 统一信封包装（RpcError 保留 code；未知异常按内部错误归类） */
async function envelope<T>(fn: () => Promise<T> | T): Promise<IpcEnvelope<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof RpcError) {
      return { ok: false, code: e.code, message: e.message };
    }
    return {
      ok: false,
      code: -32603,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 调用历史页大小上限（防渲染层异常参数拖垮 IPC 序列化） */
const LIST_LIMIT_MAX = 500;

/** 外部状态合法值（查询参数校验用） */
const STATUS_VALUES: readonly InvocationStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

/**
 * 解析并校验列表查询参数（渲染进程 → 主进程边界，仅信任白名单形状）。
 * 缺省 limit=50 / offset=0；多余字段忽略（前向兼容）。
 */
function parseListQuery(
  raw: unknown,
): Required<Pick<InvocationListQuery, "limit" | "offset">> & InvocationListQuery {
  if (raw === undefined || raw === null) {
    return { limit: 50, offset: 0 };
  }
  if (typeof raw !== "object") {
    throw new RpcError(-32602, "list 参数必须为对象");
  }
  const q = raw as Record<string, unknown>;
  let limit = 50;
  let offset = 0;
  if (q["limit"] !== undefined) {
    if (typeof q["limit"] !== "number" || !Number.isInteger(q["limit"]) || q["limit"] < 1) {
      throw new RpcError(-32602, "limit 必须为 ≥1 的整数");
    }
    limit = Math.min(q["limit"], LIST_LIMIT_MAX);
  }
  if (q["offset"] !== undefined) {
    if (typeof q["offset"] !== "number" || !Number.isInteger(q["offset"]) || q["offset"] < 0) {
      throw new RpcError(-32602, "offset 必须为 ≥0 的整数");
    }
    offset = q["offset"];
  }
  const status = q["status"] !== undefined ? (q["status"] as InvocationStatus) : undefined;
  if (status !== undefined && !STATUS_VALUES.includes(status)) {
    throw new RpcError(-32602, `status 非法：${String(q["status"])}`);
  }
  const capabilityContains =
    q["capability_contains"] !== undefined && typeof q["capability_contains"] === "string"
      ? q["capability_contains"]
      : undefined;
  const since = q["since"] !== undefined && typeof q["since"] === "string" ? q["since"] : undefined;
  return {
    limit,
    offset,
    ...(status !== undefined ? { status } : {}),
    ...(capabilityContains !== undefined ? { capability_contains: capabilityContains } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

/**
 * 解析并校验产物查询参数（渲染进程 → 主进程边界；与 parseListQuery
 * 同模式）：缺省 limit=50 / offset=0；多余字段忽略（前向兼容）。
 */
function parseArtifactQuery(
  raw: unknown,
): Required<Pick<ArtifactListQuery, "limit" | "offset">> & ArtifactListQuery {
  if (raw === undefined || raw === null) {
    return { limit: 50, offset: 0 };
  }
  if (typeof raw !== "object") {
    throw new RpcError(-32602, "artifact:list 参数必须为对象");
  }
  const q = raw as Record<string, unknown>;
  let limit = 50;
  let offset = 0;
  if (q["limit"] !== undefined) {
    if (typeof q["limit"] !== "number" || !Number.isInteger(q["limit"]) || q["limit"] < 1) {
      throw new RpcError(-32602, "limit 必须为 ≥1 的整数");
    }
    limit = Math.min(q["limit"], LIST_LIMIT_MAX);
  }
  if (q["offset"] !== undefined) {
    if (typeof q["offset"] !== "number" || !Number.isInteger(q["offset"]) || q["offset"] < 0) {
      throw new RpcError(-32602, "offset 必须为 ≥0 的整数");
    }
    offset = q["offset"];
  }
  const capabilityContains =
    q["capability_contains"] !== undefined && typeof q["capability_contains"] === "string"
      ? q["capability_contains"]
      : undefined;
  const filenameContains =
    q["filename_contains"] !== undefined && typeof q["filename_contains"] === "string"
      ? q["filename_contains"]
      : undefined;
  const since = q["since"] !== undefined && typeof q["since"] === "string" ? q["since"] : undefined;
  return {
    limit,
    offset,
    ...(capabilityContains !== undefined ? { capability_contains: capabilityContains } : {}),
    ...(filenameContains !== undefined ? { filename_contains: filenameContains } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

/**
 * 注册全部 IPC 通道与事件推送（窗口创建后调用）。
 * 事件订阅生命周期跟随窗口：closed → 退订（防Destroyed窗口的send）。
 * @param settingsPath settings.json 路径（Agent 接入信息：token 读取 +
 *        首次引导标记 read-modify-write）
 * @param pluginUi 微应用窗口管理器（P-003：ui:open 通道 + 卸载联动关窗）
 */
export function registerWorkbenchIpc(
  modules: WorkbenchModules,
  win: BrowserWindow,
  settingsPath: string,
  pluginUi: PluginUiManager,
): void {
  // ---------------- 插件区块（10 节） ----------------

  ipcMain.handle(WORKBENCH_PLUGIN_LIST, () =>
    envelope(() => {
      const counts = modules.registry.capabilityCounts();
      // UI 视图映射：entry / rootDir / permissions 等主进程细节不外泄
      const cards: PluginCard[] = modules.registry.listPlugins().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        status: p.status,
        ...(p.errorReason !== undefined ? { error_reason: p.errorReason } : {}),
        capability_count: counts.get(p.id) ?? 0,
        // 来源标记：驱动前端"仅第三方卡片显示导出 / 删除按钮"（内置保护）
        source:
          modules.registry.getPluginSource(p.id) === "third_party" ? "third_party" : "builtin",
        // P-002：设置入口（声明配置的插件才有）与"已配置"圆点（存在已保存值）
        has_config: p.configSchema !== undefined,
        config_saved: p.configSchema !== undefined && modules.pluginConfigs.hasSavedValues(p.id),
        // P-003：微应用"打开界面"入口（contributes.ui 注册期已校验存在）
        has_ui: p.uiEntry !== undefined,
      }));
      // 稳定排序：卡片顺序按 id（列表在启停切换后刷新不跳动）
      cards.sort((a, b) => a.id.localeCompare(b.id));
      return cards;
    }),
  );

  ipcMain.handle(WORKBENCH_PLUGIN_TOGGLE, (_e, pluginId: unknown, enabled: unknown) =>
    envelope(() => {
      if (typeof pluginId !== "string" || typeof enabled !== "boolean") {
        throw new RpcError(-32602, "toggle 参数形状错误：需 (pluginId: string, enabled: boolean)");
      }
      const current = modules.registry.getPlugin(pluginId);
      if (current === undefined) {
        throw new RpcError(40005, `插件不存在：${pluginId}`);
      }
      // 重新启用（error → enabled）：清崩溃计数（registry.setPluginStatus 注释
      // 约定的 runtime.resetPlugin 协议；下次 invoke 懒启动新进程）
      if (enabled && current.status === "error") {
        modules.runtime.resetPlugin(pluginId);
      }
      modules.registry.setPluginStatus(pluginId, enabled ? "enabled" : "disabled");
      // 注意（M2-07 完善）：disable 时运行中 invocation 让其自然跑完——
      // 状态已置 disabled，新 invoke 即刻被 resolveCapability 拒绝（40001）
    }),
  );

  // ---------------- 插件配置（P-002 §3.7：声明式配置的读写通道） ----------------

  ipcMain.handle(WORKBENCH_PLUGIN_CONFIG_GET, (_e, pluginId: unknown) =>
    envelope((): PluginConfigView | null => {
      if (typeof pluginId !== "string") {
        throw new RpcError(-32602, "config:get 参数形状错误：需 (pluginId: string)");
      }
      const record = modules.registry.getPlugin(pluginId);
      if (record === undefined) {
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
      }
      // 未声明配置：防御性 null（正常流程前端仅对 has_config 插件发起）
      if (record.configSchema === undefined) return null;
      // values 与 ctx.config 注入值同源同形（已保存 + default 合并 + 未知
      // 字段透传）；secret 字段明文回显——本地 IPC 无跨进程暴露面（§3.7）
      return {
        schema: record.configSchema,
        values: modules.pluginConfigs.read(pluginId, record.configSchema),
      };
    }),
  );

  ipcMain.handle(
    WORKBENCH_PLUGIN_CONFIG_SAVE,
    (_e, pluginId: unknown, rawValues: unknown) =>
      envelope(async (): Promise<PluginConfigSaveResult> => {
        if (typeof pluginId !== "string") {
          throw new RpcError(-32602, "config:save 参数形状错误：需 (pluginId: string, values: object)");
        }
        // 渲染进程 → 主进程边界：只信任对象形状（null / 数组拒绝）
        if (typeof rawValues !== "object" || rawValues === null || Array.isArray(rawValues)) {
          throw new RpcError(-32602, "values 必须为对象");
        }
        const record = modules.registry.getPlugin(pluginId);
        if (record === undefined) {
          throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
        }
        if (record.configSchema === undefined) {
          throw new RpcError(
            ERROR_CODES.PLUGIN_UNAVAILABLE,
            `插件 ${pluginId} 未声明配置（contributes.configuration）`,
          );
        }
        // 保存：表单值覆盖合并（保留未知字段）→ Ajv 兜底校验 → 原子写回；
        // 校验失败结构化返回 errors（表单内联展示，非 RpcError——草案 §3.7）
        const result = await modules.pluginConfigs.save(
          pluginId,
          record.configSchema,
          rawValues as Record<string, unknown>,
        );
        if (!result.ok) return result;
        // 保存成功 → 终止运行中插件进程（config 为 load 期快照，下次
        // 懒启动注入新值；运行中 invocation 按 50001 强杀语义收尾）
        modules.runtime.disposePlugin(pluginId);
        return { ok: true };
      }),
  );

  // ---------------- 微应用界面（P-003 v1） ----------------

  ipcMain.handle(WORKBENCH_PLUGIN_UI_OPEN, (_e, pluginId: unknown) =>
    envelope(() => {
      if (typeof pluginId !== "string") {
        throw new RpcError(-32602, "ui:open 参数形状错误：需 (pluginId: string)");
      }
      // 单实例聚焦 / 新建校验（不存在 / 非 enabled / 无 uiEntry → 40005）
      pluginUi.open(pluginId);
    }),
  );

  // ---------------- 插件导入 / 导出 / 卸载（第三方插件管理） ----------------

  ipcMain.handle(WORKBENCH_PLUGIN_IMPORT, () =>
    envelope(async (): Promise<PluginImportResult | null> => {
      // 文件选择框挂主窗口（模态归属）；取消 = 非错误（前端静默）
      const picked = await dialog.showOpenDialog(win, {
        title: "导入插件",
        filters: [{ name: "Kiko 插件包 (zip)", extensions: ["zip"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      // zip 校验 / 部署 / rescan 全套在 core（可单测），此处只做宿主交互
      return importPluginFromZip(
        { registry: modules.registry, userPluginsRoot: modules.userPluginsRoot },
        picked.filePaths[0]!,
      );
    }),
  );

  ipcMain.handle(WORKBENCH_PLUGIN_EXPORT, (_e, pluginId: unknown) =>
    envelope(async (): Promise<string | null> => {
      if (typeof pluginId !== "string") {
        throw new RpcError(-32602, "export 参数形状错误：需 (pluginId: string)");
      }
      const record = modules.registry.getPlugin(pluginId);
      if (record === undefined) {
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
      }
      // 内置插件随安装包分发，导出无意义且易造成版本分叉——拒绝
      if (modules.registry.getPluginSource(pluginId) !== "third_party") {
        throw new RpcError(ERROR_CODES.BUILTIN_PLUGIN_PROTECTED, `内置插件不支持导出：${pluginId}`);
      }
      const saved = await dialog.showSaveDialog(win, {
        title: "导出插件",
        defaultPath: `${record.id}-${record.version}.zip`,
        filters: [{ name: "Kiko 插件包 (zip)", extensions: ["zip"] }],
      });
      if (saved.canceled || saved.filePath === undefined || saved.filePath === "") return null;
      // 打包写盘在 core（导出格式与导入解析对称）；失败抛 -32603
      exportPluginToZip(record.rootDir, saved.filePath);
      return saved.filePath;
    }),
  );

  ipcMain.handle(WORKBENCH_PLUGIN_UNINSTALL, (_e, pluginId: unknown) =>
    envelope(async () => {
      if (typeof pluginId !== "string") {
        throw new RpcError(-32602, "uninstall 参数形状错误：需 (pluginId: string)");
      }
      const record = modules.registry.getPlugin(pluginId);
      if (record === undefined) {
        throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
      }
      // 内置插件随安装包分发，删除会被升级覆盖修复且破坏产品能力——拒绝
      if (modules.registry.getPluginSource(pluginId) !== "third_party") {
        throw new RpcError(ERROR_CODES.BUILTIN_PLUGIN_PROTECTED, `内置插件禁止删除：${pluginId}`);
      }
      // 1. 关闭微应用窗口（P-003：目录即将删除，窗口协议请求全部 404；
      //    同时释放 UI 租约——与 disposePlugin 的防御性清租约双保险）
      pluginUi.close(pluginId);
      // 2. 终止插件进程（运行中 invocation 由 terminateProcess 批量标记
      //    failed(50001)——"删除即强制终止"的用户决策）
      modules.runtime.disposePlugin(pluginId);
      // 3. 删除目录（短重试：Windows 下 kill 后句柄异步释放 / 杀毒软件
      //    锁文件都可能瞬时 EPERM，300ms × 3 次足够错过窗口）
      const lastErr = await rmWithRetry(record.rootDir);
      if (lastErr !== null) {
        throw new RpcError(
          -32603,
          `插件目录删除失败（文件可能被占用，请稍后重试）：${lastErr.message}`,
        );
      }
      // 4. 移除注册条目（顺序对齐 rpc-router rescan removed 路径：
      //    先 dispose 进程再动数据）
      modules.registry.unregisterPlugin(pluginId);
    }),
  );

  // ---------------- 调用历史区块（10 节；M2-08 分页/筛选） ----------------

  ipcMain.handle(WORKBENCH_INVOCATION_LIST, (_e, raw: unknown) =>
    envelope<InvocationListResult>(() => {
      // 边界校验后映射为存储层查询形状（snake_case → camelCase 单点转换）
      const q = parseListQuery(raw);
      const { items, hasMore } = modules.state.query({
        limit: q.limit,
        offset: q.offset,
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.capability_contains !== undefined
          ? { capabilityContains: q.capability_contains }
          : {}),
        ...(q.since !== undefined ? { since: q.since } : {}),
      });
      const now = Date.now();
      return {
        items: items.map((r) => {
          // 耗时：终态 = ended - started；running = now - started；
          // 未开始（pending）无 started_at → undefined
          const startMs = r.started_at !== undefined ? Date.parse(r.started_at) : NaN;
          const endMs =
            r.ended_at !== undefined
              ? Date.parse(r.ended_at)
              : r.internalStatus === "running"
                ? now
                : NaN;
          const duration =
            Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : undefined;
          return {
            invocation_id: r.invocation_id,
            capability_id: r.capability_id,
            status: toExternalStatus(r.internalStatus),
            mode: r.mode,
            created_at: r.created_at,
            ...(r.ended_at !== undefined ? { ended_at: r.ended_at } : {}),
            ...(duration !== undefined ? { duration_ms: duration } : {}),
            artifact_count: r.artifacts.length,
          } satisfies InvocationListItem;
        }),
        // 存储层 limit+1 探测结果直传（渲染层"加载更多"按钮依据）
        has_more: hasMore,
      };
    }),
  );

  ipcMain.handle(WORKBENCH_INVOCATION_DETAIL, (_e, invocationId: unknown) =>
    envelope(() => {
      if (typeof invocationId !== "string") {
        throw new RpcError(-32602, "invocation_id 必须为字符串");
      }
      // 复用 RPC get_execution 聚合（事件 + 日志 + 记录一体；40003 语义保留）
      return modules.invocation.getExecution(invocationId, {
        includeEvents: true,
        includeLogs: true,
      });
    }),
  );

  // ---------------- 清空调用历史（数据膨胀治理；评审定：仅终态 + VACUUM） ----------------

  ipcMain.handle(WORKBENCH_HISTORY_CLEAR, () =>
    envelope(() => {
      // core 编排：终态记录 + 级联事件/日志删除（运行中调用保留）
      const cleared = clearInvocationHistory(modules);
      // SQLite 装配时回收磁盘（DELETE 只标记复用，文件不缩小）；内存装配无此步
      modules.vacuumDb?.();
      return cleared;
    }),
  );

  // ---------------- 产物定位（10 节；M2-08 白名单收口） ----------------

  ipcMain.handle(WORKBENCH_ARTIFACT_SHOW, (_e, absolutePath: unknown) =>
    envelope(() => {
      if (typeof absolutePath !== "string" || absolutePath.length === 0) {
        throw new RpcError(-32602, "产物路径必须为非空字符串");
      }
      // 白名单收口（M2-08）：产物恒落工作空间内（artifacts.save /
      // file.write 沙箱基座），越界路径直接拒绝——防渲染进程被攻破后
      // 借本通道定位任意系统文件。resolveSafe 语义内联（ipc 层不引
      // plugin-sdk，保持主进程依赖面最小）
      const resolved = resolvePath(absolutePath);
      const root = resolvePath(modules.workspace.workspaceRoot);
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new RpcError(50001, `产物路径越界：${absolutePath}（不在工作空间 ${root} 内）`);
      }
      // shell.showItemInFolder 只读定位（打开资源管理器并选中文件），无写副作用
      shell.showItemInFolder(resolved);
    }),
  );

  // ---------------- 产物分页查询（产出物页数据源；全量汇总随行返回） ----------------

  ipcMain.handle(WORKBENCH_ARTIFACT_LIST, (_e, raw: unknown) =>
    envelope<ArtifactListResult>(() => {
      const q = parseArtifactQuery(raw);
      const { items, hasMore } = modules.state.queryArtifacts({
        limit: q.limit,
        offset: q.offset,
        ...(q.capability_contains !== undefined
          ? { capabilityContains: q.capability_contains }
          : {}),
        ...(q.filename_contains !== undefined ? { filenameContains: q.filename_contains } : {}),
        ...(q.since !== undefined ? { since: q.since } : {}),
      });
      // "今日新增"口径：本地今天零点（与渲染层 history 的 todayOnly 同折算）
      const now = new Date();
      const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const stats = modules.state.artifactStats(todayStartMs);
      return {
        // 列表项与 core ArtifactQueryItem 同形（snake_case 透传）
        items: items as ArtifactListItem[],
        has_more: hasMore,
        stats: {
          total: stats.total,
          today: stats.todayCount,
          total_size: stats.totalSize,
          capabilities: stats.capabilities,
        },
      };
    }),
  );

  // ---------------- Agent 接入信息（"Agent 接入"模态数据源） ----------------

  /** settings.json 中"首次引导已弹出"标记字段（tray_balloon_shown 同模式） */
  const AGENT_GUIDE_SHOWN_KEY = "agent_guide_shown";

  ipcMain.handle(WORKBENCH_CONNECTION_INFO, () =>
    envelope(() => {
      // settings.json 缺失（无鉴权模式 / 极早期）→ 无 token 且视为未引导
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        // 损坏 JSON 抛错走信封失败分支——与 resolveWorkspaceRoot 同策略：
        // 配置损坏静默忽略会掩盖用户可修复的问题
        settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      }
      const showGuide = settings[AGENT_GUIDE_SHOWN_KEY] !== true;
      if (showGuide) {
        // 查询即置位（read-modify-write 保留其他字段；写失败仅失去"仅
        // 首次"语义，下次再弹一次，无害——对齐 tray.ts 气泡标记惯例）
        settings[AGENT_GUIDE_SHOWN_KEY] = true;
        try {
          mkdirSync(dirname(settingsPath), { recursive: true });
          writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
        } catch (e) {
          console.error(
            `[kiko-ipc] 引导标记写入失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      // 端口取运行实例实际值（端口冲突 +1 重试后可能非 47830，勿写死）
      const port = modules.wsServer.port;
      const token =
        typeof settings["access_token"] === "string" ? settings["access_token"] : undefined;
      // MCP 适配器路径（"MCP 接入"模态数据源；不可用 → undefined，模态展示引导）
      const mcpAdapterPath = resolveMcpAdapterPath();
      return {
        wsUrl: `ws://127.0.0.1:${port}`,
        httpUrl: `http://127.0.0.1:${port}/rpc`,
        ...(token !== undefined ? { token } : {}),
        ...(mcpAdapterPath !== undefined ? { mcpAdapterPath } : {}),
        showGuide,
      } satisfies ConnectionInfo;
    }),
  );

  // ---------------- 剪贴板写入（接入指南复制；通用能力） ----------------

  ipcMain.handle(WORKBENCH_CLIPBOARD_WRITE, (_e, text: unknown) =>
    envelope(() => {
      if (typeof text !== "string" || text.length === 0) {
        throw new RpcError(-32602, "剪贴板内容必须为非空字符串");
      }
      // Electron clipboard：无焦点/协议限制（navigator.clipboard 在
      // file:// 生产环境有不可用风险，复制是核心功能不容有失）
      clipboard.writeText(text);
    }),
  );

  // ---------------- 事件推送（主进程 → 渲染进程单向） ----------------

  const forward: EventListener = (event) => {
    // isDestroyed 防御：窗口关闭后 send 会抛（Electron 收尾期竞态）
    if (!win.isDestroyed()) {
      win.webContents.send(WORKBENCH_EVENT_CHANNEL, event);
    }
  };
  const unsubscribe = modules.events.subscribe(forward);
  win.on("closed", () => {
    unsubscribe();
    // 通道随最后消费者移除（ipcMain 是全局单例，防 handler 泄漏）
    ipcMain.removeHandler(WORKBENCH_PLUGIN_LIST);
    ipcMain.removeHandler(WORKBENCH_PLUGIN_TOGGLE);
    ipcMain.removeHandler(WORKBENCH_PLUGIN_CONFIG_GET);
    ipcMain.removeHandler(WORKBENCH_PLUGIN_CONFIG_SAVE);
    ipcMain.removeHandler(WORKBENCH_PLUGIN_IMPORT);
    ipcMain.removeHandler(WORKBENCH_PLUGIN_EXPORT);
    ipcMain.removeHandler(WORKBENCH_PLUGIN_UNINSTALL);
    ipcMain.removeHandler(WORKBENCH_INVOCATION_LIST);
    ipcMain.removeHandler(WORKBENCH_INVOCATION_DETAIL);
    ipcMain.removeHandler(WORKBENCH_HISTORY_CLEAR);
    ipcMain.removeHandler(WORKBENCH_ARTIFACT_SHOW);
  });
}
