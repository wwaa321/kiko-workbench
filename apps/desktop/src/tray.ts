/**
 * 系统托盘模块（服务型工具常驻能力）
 *
 * 职责（与 main.ts 装配解耦，窗口关闭拦截由 main.ts 负责）：
 *   - 托盘图标 + tooltip + 右键菜单（显示主界面 / 退出）
 *   - 左键单击唤醒主窗口（Windows 通知区域惯例：右键菜单、左键唤醒）
 *   - 首次关闭到托盘的气泡提示（标记持久化 settings.json，仅首次弹出）
 *
 * 图标来源：electron-builder extraResources 把 build-resources/icon.png
 * 复制到 resources/icon.png（与 exe 图标同源单点维护）；dev 态回源
 * 源码树 build-resources/。500×500 原图经 resize 缩到通知区域标准尺寸
 * （直接传入会被系统拉伸发糊）。
 */
import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** settings.json 中"首次气泡已弹出"标记的字段名（读-改-写保留其他字段） */
const TRAY_BALLOON_SHOWN_KEY = "tray_balloon_shown";

/** 托盘图标尺寸（Windows 通知区域标准 16×16；高 DPI 下系统自行拉伸） */
const TRAY_ICON_SIZE = 16;

/** 气泡提示图标尺寸（通知区域气泡标准 32×32） */
const BALLOON_ICON_SIZE = 32;

/**
 * 解析托盘图标路径：
 * 打包产物 → resources/icon.png（extraResources 落位）；
 * dev 态 → app.getAppPath() = apps/desktop → 源码树 build-resources/。
 */
function resolveTrayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build-resources", "icon.png");
}

/**
 * 读取"首次气泡"标记：未弹出过（含 settings.json 不存在）返回 true。
 *
 * 损坏 JSON 的容错策略与 auth.ts 的快死不同：气泡为锦上添花的体验
 * 功能，配置损坏时静默跳过（不弹也不覆写），不应中断关闭到托盘的
 * 主流程——损坏配置的暴露职责留给 auth / bootstrap 层。
 */
function shouldShowFirstHideBalloon(settingsPath: string): boolean {
  try {
    if (!existsSync(settingsPath)) return true;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    return settings[TRAY_BALLOON_SHOWN_KEY] !== true;
  } catch {
    return false;
  }
}

/** 气泡已弹标记写回（读-改-写对齐 core/auth.ts 惯例；写失败仅失去"仅首次"语义，下次再弹一次，无害） */
function markBalloonShown(settingsPath: string): void {
  try {
    const settings: Record<string, unknown> = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>)
      : {};
    settings[TRAY_BALLOON_SHOWN_KEY] = true;
    // 父目录保障：KIKO_NO_AUTH / 首次运行场景下 settings.json 可能尚未创建
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  } catch (e) {
    console.error(`[kiko-tray] 气泡标记写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 托盘模块对外句柄（闭包封装内部 Tray / 图标细节） */
export interface WorkbenchTray {
  /** 首次隐藏到托盘的气泡提示（标记持久化，后续调用为无操作） */
  notifyHiddenToTray(): void;
  /** 销毁托盘（退出前调用，防通知区域图标残留） */
  destroy(): void;
}

/** 唤醒主窗口（show 后聚焦，保证置顶层级——Electron 35 show 为同步 void） */
function showAndFocus(win: BrowserWindow): void {
  win.show();
  win.focus();
}

/**
 * 创建工作台托盘。
 *
 * @param win 主窗口（左键单击 / 菜单项唤起的目标）
 * @param settingsPath settings.json 路径（气泡标记持久化载体）
 * @returns 托盘句柄（notifyHiddenToTray / destroy）
 * @throws 图标文件缺失时抛错——托盘是常驻能力的载体，静默降级会让
 *         "关闭到托盘"变成"程序凭空消失"，必须让启动期暴露问题
 */
export function createWorkbenchTray(win: BrowserWindow, settingsPath: string): WorkbenchTray {
  const iconPath = resolveTrayIconPath();
  if (!existsSync(iconPath)) {
    throw new Error(`托盘图标缺失：${iconPath}`);
  }
  const icon = nativeImage
    .createFromPath(iconPath)
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  const balloonIcon = nativeImage
    .createFromPath(iconPath)
    .resize({ width: BALLOON_ICON_SIZE, height: BALLOON_ICON_SIZE });

  const tray = new Tray(icon);
  tray.setToolTip("Kiko Workbench");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // 主路径：菜单唤起（左键单击同效，见下方 click 注册）
      { label: "显示主界面", click: () => showAndFocus(win) },
      { type: "separator" },
      // 唯一的完全退出入口（app.quit → before-quit 置位 → close 放行）
      { label: "退出", click: () => app.quit() },
    ]),
  );
  // Windows：左键单击唤醒主窗口（contextMenu 为右键菜单，两者不冲突）
  tray.on("click", () => showAndFocus(win));

  return {
    notifyHiddenToTray(): void {
      if (!shouldShowFirstHideBalloon(settingsPath)) return;
      markBalloonShown(settingsPath);
      // Windows-only API：本产品仅打包 Windows（electron-builder win/nsis）
      tray.displayBalloon({
        iconType: "custom",
        icon: balloonIcon,
        title: "Kiko Workbench 仍在运行",
        content:
          "窗口已最小化到系统托盘。左键点击托盘图标可恢复窗口；完全退出请使用托盘菜单中的「退出」。",
      });
    },
    destroy(): void {
      tray.destroy();
    },
  };
}
