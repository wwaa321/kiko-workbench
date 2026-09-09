# Kiko Workbench

**Agent 负责智能，Workbench 负责能力执行。**

Kiko Workbench 是一个让 Agent 按业务需求**自进化能力**的桌面工作台。传统模式下，Agent 的能力边界由人类决定：缺能力 → 提需求 → 排期开发；在这里，Agent 在执行业务时发现缺什么能力，就现场设计、开发、部署一个插件装进工作台，立即可用——全程零 shell、零人工介入。

- **Agent 能力自进化**：内置 Plugin SDK Distributor，SDK 物料、构建、部署、注册验证全部工具化。Agent 五步 WS 调用（`file.write` → `sdk.build` → `sdk.deploy` → `plugins.rescan` → verify）即可完成一个新能力从无到有的闭环。
- **任何 Agent 快速接入**：标准 JSON-RPC over WebSocket / HTTP + Token 认证，能发网络请求的 Agent（Claude、Cursor、自定义脚本、自动化流程…）几分钟即可接入；另附 stdio 形态 MCP 适配器，Claude Desktop 等 MCP 客户端即插即用。

自进化闭环跑在一套安全、可观测的插件运行时之上：

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
