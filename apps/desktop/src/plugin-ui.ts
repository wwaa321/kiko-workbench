/**
 * 插件微应用窗口管理（P-003 v1；方案草案附录 C）
 *
 * 职责：
 *   - kiko-plugin:// 自定义协议：`kiko-plugin://<pluginId>/<path>` →
 *     插件目录内文件服务。standard特权使 host 成为 origin——不同插件
 *     天然源隔离（A 插件页面拿不到 B 插件的 DOM / localStorage）
 *   - 沙箱窗口单实例管理：同插件二次"打开界面"聚焦既有窗口（2026-09-07
 *     拍板，ctx.ui.send 保持一对一投递）；窗口关闭 → UI 租约释放
 *   - PluginUiRelay 实现：runtime 的 ui-send 路由 → webContents.send
 *     （微应用 preload 经 PLUGIN_UI_MESSAGE_CHANNEL 订阅）
 *
 * 安全设计（草案 C.5 安全边界）：
 *   - 窗口：contextIsolation: true + nodeIntegration: false（sandbox 因
 *     ESM preload 限制关闭——与主窗口同一先例，见 main.ts 注释）
 *   - 路径：协议 handler 对 pathname 逐段校验（拒绝空段 / `.` / `..` /
 *     盘符）+ resolve 前缀复查双保险——微应用只能读自己插件目录
 *   - CSP：HTML 响应注入响应头（script-src 'self' 'wasm-unsafe-eval'——
 *     禁内联脚本与远程加载、放行 WebAssembly 编译；connect-src 'self'——
 *     仅许 fetch 本源静态资产，无外部网络出口）
 *   - relay.send 仅查内存窗口表：无窗口 → 40010（PLUGIN_UI_NOT_OPEN）
 *
 * 大小写说明：URL hostname 被 Chromium 小写化——插件 id 按"精确匹配
 * 优先、大小写折叠匹配兜底"解析；规范建议微应用插件 id 全小写（折叠
 * 冲突的极端场景按精确匹配胜出）。
 */
import { BrowserWindow, protocol } from "electron";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, RpcError } from "@kiko-workbench/protocol";
import type { CapabilityRegistry, ExecutionRuntime, PluginUiRelay } from "@kiko-workbench/core";
import { PLUGIN_UI_MESSAGE_CHANNEL } from "./shared.js";

/** 当前模块目录（ESM 无 __dirname——主进程产物 dist/plugin-ui.js，
 *  preload 同目录；与 main.ts 主窗口 preload 同款解析模式） */
const moduleDir = fileURLToPath(new URL(".", import.meta.url));

/** 微应用协议 scheme（origin = kiko-plugin://<pluginId>/） */
export const KIKO_PLUGIN_SCHEME = "kiko-plugin";

/**
 * 协议特权注册（必须在 app ready 前调用；main.ts 模块顶层）：
 * standard 让 URL 具备 host 概念（源隔离的前提）。
 */
export function registerPluginUiSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: KIKO_PLUGIN_SCHEME,
      privileges: { standard: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * v1 CSP（草案 C.5；wasm 放宽 2026-09-07 拍板）：script 仅限本源文件
 * （禁内联 / 远程）+ wasm 编译许可（'wasm-unsafe-eval'——Live2D Cubism 5
 * 等运行时必需；只开 WebAssembly 编译不开 JS eval）；样式放开内联
 * （参考实现轻量样式便利，无脚本执行面）；connect 限本源——微应用可
 * fetch 自己插件目录的静态资产（.wasm / 模型文件），但无外部网络出口
 * （远程 origin 仍禁、其他插件不同 origin 仍隔离），动态数据流仍只经
 * 宿主桥（ctx.ui.send）。
 */
const CSP_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-src 'none'";

/** 协议服务的 mime 映射（微应用常规资产；未知扩展按 octet-stream） */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  // wasm MIME（2026-09-07 CSP 放宽配套）：WebAssembly.instantiateStreaming
  // 强制校验 application/wasm——缺正确 MIME 时流式编译失败（Emscripten
  // 类加载器的 ArrayBuffer 回退不可依赖）
  ".wasm": "application/wasm",
};

/** registry 最小接口（协议 handler 消费；避免整只 registry 依赖注入） */
interface RegistryLike {
  listPlugins(): Array<{ id: string; rootDir: string; status: string }>;
}

/** PluginUiManager 构造后的接线依赖（bootstrap 完成后 attach） */
export interface PluginUiAttachDeps {
  registry: CapabilityRegistry;
  runtime: ExecutionRuntime;
}

/**
 * 微应用窗口管理器（shell 装配期先构造供 relay 注入 runtime，bootstrap
 * 完成后 attach 获得完整能力——两段式解决 runtime ⇄ manager 循环依赖，
 * 与 bootstrap.ts cancelBridge 同模式）。
 */
export class PluginUiManager {
  /** pluginId → 活动窗口（单实例表；关闭即删除条目） */
  private readonly windows = new Map<string, BrowserWindow>();
  private attached: PluginUiAttachDeps | null = null;
  private destroyed = false;

  /**
   * runtime 的 UI 中继（构造期即可用——仅查内存窗口表，不依赖 registry）：
   * 无窗口 → reject 40010（含"窗口开过又关"与"非微应用插件"两种情形）。
   */
  readonly relay: PluginUiRelay = {
    send: (pluginId, payload) => {
      const win = this.windows.get(pluginId);
      if (win === undefined || win.isDestroyed()) {
        return Promise.reject(
          new RpcError(ERROR_CODES.PLUGIN_UI_NOT_OPEN, "插件界面未打开"),
        );
      }
      win.webContents.send(PLUGIN_UI_MESSAGE_CHANNEL, payload);
      return Promise.resolve();
    },
  };

  /** bootstrap 完成后接线（registry + runtime）并注册协议 handler */
  attach(deps: PluginUiAttachDeps): void {
    this.attached = deps;
    protocol.handle(KIKO_PLUGIN_SCHEME, (request) => this.handleRequest(request));
  }

  /** 应用退出前清理（will-quit）：关全部微应用窗口（租约随进程回收无意义） */
  destroyAll(): void {
    this.destroyed = true;
    for (const win of this.windows.values()) {
      win.destroy(); // 不走 close 拦截（退出路径语义同主窗口 isQuitting）
    }
    this.windows.clear();
  }

  /**
   * 关闭指定插件的微应用窗口（卸载插件联动：目录即将删除，窗口不能留）。
   * 无窗口 / 非微应用插件为 no-op。
   */
  close(pluginId: string): void {
    const win = this.windows.get(pluginId);
    if (win !== undefined && !win.isDestroyed()) {
      win.destroy();
    }
    // close 事件监听负责 map 清理与租约释放；destroy 路径同步兜底防漏
    this.windows.delete(pluginId);
    this.attached?.runtime.releaseUiLease(pluginId);
  }

  /**
   * 打开插件微应用界面（IPC workbench:plugin:ui:open 实现）：
   * 已开 → 聚焦（单实例）；未开 → 校验（存在 / enabled / uiEntry）→ 新建。
   */
  open(pluginId: string): void {
    if (this.destroyed) {
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, "应用正在退出，无法打开插件界面");
    }
    // 单实例：已开窗口直接聚焦（2026-09-07 拍板，草案 C.4）
    const existing = this.windows.get(pluginId);
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
    this.windows.delete(pluginId); // 清理已销毁的陈旧条目

    if (this.attached === null) {
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, "微应用模块未装配（attach 前调用）");
    }
    const plugin = this.attached.registry.getPlugin(pluginId);
    if (plugin === undefined) {
      throw new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, `插件不存在：${pluginId}`);
    }
    if (plugin.status !== "enabled") {
      throw new RpcError(
        ERROR_CODES.PLUGIN_UNAVAILABLE,
        `插件 ${pluginId} 不可用（${plugin.status}）`,
      );
    }
    if (plugin.uiEntry === undefined) {
      throw new RpcError(
        ERROR_CODES.PLUGIN_UNAVAILABLE,
        `插件 ${pluginId} 未声明微应用界面（contributes.ui.entry）`,
      );
    }

    this.createWindow(pluginId, plugin.name, plugin.uiEntry);
  }

  // ---------------- 窗口创建 ----------------

  /** 新建沙箱窗口 + 加载入口 + 租约接线（单实例表的唯一写入点） */
  private createWindow(pluginId: string, pluginName: string, uiEntry: string): void {
    const win = new BrowserWindow({
      width: 900,
      height: 640,
      title: `${pluginName} — Kiko Workbench`,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(moduleDir, "plugin-ui-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // ESM preload 限制（同主窗口先例，main.ts 注释）：安全边界由
        // contextIsolation + nodeIntegration 双关闭承担，preload 仅暴露
        // onMessage 单向订阅桥
        sandbox: false,
      },
    });
    this.windows.set(pluginId, win);
    // C.6 第 4 条：插件窗口不得再开窗口（window.open / target=_blank 全拒——
    // 微应用无导航面，任何新窗口诉求都视为越权）
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // UI 租约：窗口开着期间插件进程不被 idle 回收（ctx.ui.send 随时可投递）
    this.attached?.runtime.acquireUiLease(pluginId);

    // 窗口关闭 → 单实例表清理 + 租约释放（聚焦语义下 close 与 destroy 同路）
    win.on("close", () => {
      this.windows.delete(pluginId);
      this.attached?.runtime.releaseUiLease(pluginId);
    });
    win.on("closed", () => {
      // close 未触发（destroy 直关）的兜底；map.delete 幂等
      if (this.windows.get(pluginId)?.isDestroyed()) {
        this.windows.delete(pluginId);
        this.attached?.runtime.releaseUiLease(pluginId);
      }
    });

    // 加载入口（注册期已校验存在；此处失败仅落 console——窗口空态可排障）
    void win
      .loadURL(`${KIKO_PLUGIN_SCHEME}://${pluginId}/${uiEntry}`)
      .catch((e: unknown) => {
        console.error(`[plugin-ui] 微应用入口加载失败（${pluginId}）：${String(e)}`);
      });
  }

  // ---------------- kiko-plugin:// 协议 handler ----------------

  /**
   * `kiko-plugin://<pluginId>/<path>` → 插件目录文件响应。
   * 逐段路径校验 + 前缀复查（双保险，同 registry.assertUiEntry 策略）；
   * HTML 注入 CSP 响应头。任何异常 → 404/403/500 语义化 Response
   * （协议 handler 抛错会变成 net 错误页，语义化更利于前端排障）。
   */
  private async handleRequest(request: Request): Promise<Response> {
    if (this.attached === null) {
      return new Response("微应用模块未装配", { status: 500 });
    }
    try {
      const url = new URL(request.url);
      // hostname 被 Chromium 小写化：精确匹配优先，折叠匹配兜底
      const plugin = this.findPlugin(url.hostname);
      if (plugin === null) {
        return new Response(`插件不存在：${url.hostname}`, { status: 404 });
      }
      const target = this.resolveInsideRoot(plugin.rootDir, url.pathname);
      if (target === null) {
        return new Response("路径越界拒绝", { status: 403 });
      }
      const info = await stat(target).catch(() => null);
      if (info === null || !info.isFile()) {
        return new Response("文件不存在", { status: 404 });
      }
      const ext = target.slice(target.lastIndexOf(".")).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = await readFile(target);
      const headers: Record<string, string> = { "content-type": contentType };
      if (ext === ".html" || ext === ".htm") {
        headers["content-security-policy"] = CSP_POLICY;
      }
      return new Response(data, { headers });
    } catch (e) {
      return new Response(`协议处理异常：${String(e)}`, { status: 500 });
    }
  }

  /** registry 查找（hostname 小写化适配：精确优先 → 大小写折叠兜底） */
  private findPlugin(hostname: string): { id: string; rootDir: string } | null {
    const registry = this.attached!.registry as unknown as RegistryLike;
    const plugins = registry.listPlugins();
    const exact = plugins.find((p) => p.id === hostname);
    if (exact !== undefined) return { id: exact.id, rootDir: exact.rootDir };
    const folded = plugins.find((p) => p.id.toLowerCase() === hostname);
    return folded !== undefined ? { id: folded.id, rootDir: folded.rootDir } : null;
  }

  /**
   * 插件目录内路径解析（防穿越）：
   *   1. URL 解码 + 去前导斜杠 → 按 `/` 分段（反斜杠统一按分隔符处理）
   *   2. 段校验：拒绝空段 / `.` / `..` / 含 `:`（盘符）
   *   3. resolve 后前缀复查（join 结果必须仍落在 rootDir 内——双保险）
   * 返回 null = 越界 / 非法。
   */
  private resolveInsideRoot(rootDir: string, pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null; // 畸形百分号编码
    }
    const segments = decoded.replace(/\\/g, "/").split("/").filter((s) => s !== "");
    if (segments.some((s) => s === "." || s === ".." || s.includes(":"))) {
      return null;
    }
    if (segments.length === 0) return null; // 根路径不服务（无目录列表）
    const target = resolve(join(rootDir, ...segments));
    const root = resolve(rootDir);
    // 前缀复查：Windows 下 sep 为 `\`；target 必须形如 <root>\... 且
    // 下一个字符恰为分隔符（防 "rootA" 前缀匹配 "rootAB" 的邻接目录绕过）
    if (target !== root && !target.startsWith(root + sep)) return null;
    return target;
  }
}
