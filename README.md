# Kiko Workbench

**Agent-Native Capability Execution Platform —— Agent 负责智能，Workbench 负责能力执行。**

Kiko Workbench 是一个面向 Agent 的外部工具管理平台与业务能力执行器。Agent（LLM / CLI / 自动化流程）通过统一的 RPC 协议调用工作台能力，工作台负责插件的注册、调度、执行与产物管理——让 Agent 不必重复造轮子，直接获得一套安全、可观测的能力执行环境。

## 核心特性

- **插件化能力执行**：每个插件运行在独立子进程（utilityProcess），懒启动、崩溃自动重启（指数退避 + 3 次熔断），插件崩溃不影响工作台。
- **统一协议层**：HTTP JSON-RPC + WebSocket 双通道，首消息认证、Token 持久化，能力调用与事件推送共用一条协议。
- **插件 SDK**：插件只面对 `@kiko-workbench/plugin-sdk`，禁止反向依赖；单文件 bundle 交付，支持第三方库。
- **声明式能力清单**：`manifest.json` + `capabilities.json` 纯数据注册，主进程不加载插件 JS 即可完成发现与校验。
- **微应用 UI**：插件可声明 `contributes.ui`，通过 `kiko-plugin://` 自定义协议加载本地前端资产，源隔离 + CSP + 单实例窗口。
- **内置插件**：文件读写、docx 文档生成、长任务开发参考、SDK 分发自举。

## 仓库结构

```
kiko-workbench/
├── apps/
│   └── desktop/            # Electron 桌面端（主进程 / 渲染进程 / 打包）
├── packages/
│   ├── core/               # 核心域逻辑（零 Electron 依赖）
│   ├── protocol/           # RPC 协议与类型定义
│   ├── plugin-sdk/         # 插件开发 SDK
│   ├── plugins/            # 内置插件（file / document / dev / sdk）
│   └── mcp-adapter/        # MCP 适配器
├── docs/
│   └── 插件开发规范.md      # 插件开发完整指南
└── scripts/                # 冒烟测试
```

## 快速开始

环境要求：Node.js ≥ 22，pnpm ≥ 9。

```bash
# 安装依赖
pnpm install

# 构建全部包
pnpm build

# 运行单元测试
pnpm test

# 桌面开发模式（shell + 热更新）
pnpm -C apps/desktop dev

# 无头模式（无窗口，服务形态）
pnpm -C apps/desktop headless

# 冒烟测试
pnpm smoke
```

## 插件开发

完整的插件开发指南见 [docs/插件开发规范.md](docs/插件开发规范.md)，包含：

- 架构模型与依赖方向铁律
- 最小插件五文件结构
- SDK 获取与双轨安装（Agent 轨 / Human 轨）
- 能力声明、配置、产物、事件
- 微应用（插件 UI）开发
- 验收清单

## License

[MIT](LICENSE)
