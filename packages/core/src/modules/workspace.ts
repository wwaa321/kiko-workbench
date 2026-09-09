/**
 * WorkspaceManager（设计文档 6.7 / 7.4）
 *
 * 职责（M1 范围，6.7："M1 仅提供路径解析与校验"）：
 *   - 工作空间根目录维护：默认 <documents>/Kiko Workbench/（7.4.1）；
 *     根目录位置持久化 settings.json 为 M2 事项（M1 固定默认值）
 *   - documents 路径注入式设计：core 不 import electron（eslint 锁定），
 *     宿主注入——M1 headless 入口 / M2 Electron 主进程传
 *     app.getPath('documents')；单元测试传临时目录
 *   - 路径解析与校验：插件产物目录解析（7.4.1 按 plugin_id 归档）、
 *     产物登记路径越界复查（防御纵深——host 落盘时已过 resolveSafe，
 *     core 登记前再核一遍，host 侧伪造上报也拦得住）
 *
 * 产物登记写 artifacts 表为 M2 事项（7.2）；M1 产物仅登记在 invocation
 * 记录的 artifacts 数组（内存态，由 ExecutionRuntime 接线）。
 *
 * 本模块纯路径运算，零文件系统副作用——保证注入临时目录即可单测。
 */
import { join, relative, resolve, sep } from "node:path";
import { ERROR_CODES, RpcError } from "@kiko-workbench/protocol";

/** 工作空间根目录默认目录名（7.4.1：<系统文档目录>/Kiko Workbench/） */
export const DEFAULT_WORKSPACE_DIR_NAME = "Kiko Workbench";

export interface WorkspaceManagerOptions {
  /**
   * 宿主注入的文档目录（file.read / file.list 沙箱基座，7.4.3）。
   * M2 Electron 主进程传 app.getPath('documents')；M1 headless 入口
   * 传启动参数；单元测试传临时目录。
   */
  documentsDir: string;
  /** 工作空间根目录覆写（测试注入；M2 起由 settings.json 读取，缺省回落默认值） */
  workspaceRoot?: string;
}

export class WorkspaceManager {
  /** 文档目录（规范化绝对路径；读取沙箱基座） */
  readonly documentsDir: string;
  /** 工作空间根目录（规范化绝对路径；写入沙箱与产物落盘基座） */
  readonly workspaceRoot: string;

  constructor(options: WorkspaceManagerOptions) {
    // 构造期统一 resolve：消除尾分隔符 / .. 段 / 相对输入，后续前缀判定免重复规范化
    this.documentsDir = resolve(options.documentsDir);
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? join(options.documentsDir, DEFAULT_WORKSPACE_DIR_NAME),
    );
  }

  /**
   * 插件产物目录 workspace/<plugin_id>/（7.4.1 按插件 id 归档）。
   * pluginId 必须是单段目录名（无路径分隔符、非 "." / ".."）——
   * 产物目录安全的前提；"a..b" 这类含点子串的合法目录名放行。
   */
  pluginArtifactDir(pluginId: string): string {
    if (
      pluginId.length === 0 ||
      pluginId.includes("/") ||
      pluginId.includes("\\") ||
      pluginId === "." ||
      pluginId === ".."
    ) {
      throw new RpcError(
        ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        `非法 pluginId（禁止路径分隔符与保留名）：${pluginId}`,
      );
    }
    return join(this.workspaceRoot, pluginId);
  }

  /**
   * 产物登记路径校验（6.7 M1 范围）：host 上报的 artifact.file 必须严格
   * 落在工作空间内（根目录本身是目录、非产物文件，同样拒绝）。
   *
   * 返回规范化登记信息：file 为规范化绝对路径，relative_path 相对
   * 工作空间根且统一正斜杠（跨平台一致的协议字段）。
   * 越界抛 RpcError(50001)；相对路径输入按工作空间根解析
   * （与 plugin-sdk resolveSafe 语义对齐）。
   */
  validateArtifactPath(file: string): { file: string; relative_path: string } {
    const resolved = resolve(this.workspaceRoot, file);
    // 前缀判定带 sep 防相似前缀绕过（Kiko Workbench-evil ≠ Kiko Workbench/…）；
    // resolved === workspaceRoot 本身亦拒绝（产物必须是空间内具体文件）
    if (resolved === this.workspaceRoot || !resolved.startsWith(this.workspaceRoot + sep)) {
      throw new RpcError(
        ERROR_CODES.PLUGIN_EXECUTION_ERROR,
        `产物登记路径越界：${file} 不在工作空间 ${this.workspaceRoot} 内`,
      );
    }
    const rel = relative(this.workspaceRoot, resolved).split(sep).join("/");
    return { file: resolved, relative_path: rel };
  }
}
