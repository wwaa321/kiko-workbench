/**
 * @kiko-workbench/core —— Workbench Core（运行于主进程 / headless Node）
 *
 * 职责（设计文档第 6 节）：七大模块
 *   - CapabilityRegistry  能力注册与发现（6.1）        [M1-05]
 *   - InvocationManager   调用生命周期与状态机（6.2）  [M1-06]
 *   - ExecutionRuntime    utilityProcess 插件进程管理（6.3）[M1-09]
 *   - StateManager        invocation 状态单一数据源（6.4）
 *   - EventManager        结构化事件分发与持久化（6.5）
 *   - LogManager          执行日志聚合（6.6）
 *   - WorkspaceManager    工作空间与产物管理（6.7）    [M1-08]
 *
 * 已落地：state.ts（StateManager / EventManager / LogManager）
 *         registry.ts（CapabilityRegistry）invocation.ts（InvocationManager）
 *         workspace.ts（WorkspaceManager）runtime.ts（ExecutionRuntime，M1-09）
 *         ws-server.ts（WsRpcServer，M1-11 + M2-02：WS 主通道 + HTTP
 *         POST /rpc 同步通道同端口复用 + WS auth / HTTP Bearer 鉴权）
 *         rpc-router.ts（六方法路由，WS / HTTP 双通道共享，M2-02）
 *         auth.ts（access_token 生成与 settings.json 持久化，M2-02）
 *         recovery.ts（7.3 启动恢复，M2-01）
 *         config-store.ts（插件配置存储：读改写合并 + Ajv 值校验 +
 *         注册期结构校验，P-002 Phase 1）
 *         stores/（抽象接口 + 内存实现 + SQLite Repository（M2-01，
 *         node:sqlite 单一模块收敛全部 SQL，7.2））
 *
 * 硬约束：禁止 import electron（eslint 已锁定，设计文档 6.7）——
 * documents 等宿主路径由外部注入，保持 core 纯 Node 可运行、可单测。
 * （ws 为纯 Node 库，core 直接依赖不违反本约束）
 */
export * from "./modules/state.js";
export * from "./modules/registry.js";
export * from "./modules/invocation.js";
export * from "./modules/workspace.js";
export * from "./modules/runtime.js";
export * from "./modules/config-store.js";
export * from "./modules/plugin-package.js";
export * from "./modules/ws-server.js";
export * from "./modules/rpc-router.js";
export * from "./modules/auth.js";
export * from "./modules/recovery.js";
export * from "./stores/types.js";
export * from "./stores/memory-stores.js";
export * from "./stores/sqlite-repository.js";
