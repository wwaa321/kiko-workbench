// ESLint 9 Flat Config（设计文档 M1-01：ESLint + Prettier，TS strict）
// 结构说明：
//   1. 基础层：@eslint/js + typescript-eslint 推荐规则
//   2. 渲染进程层：.vue 单文件组件（vue-eslint-parser + eslint-plugin-vue，
//      M2-06 Vue 3 渲染进程引入；script 块内 TS 走 typescript-eslint）
//   3. 领域约束层：core 包禁止直接依赖 Electron（设计文档 6.7：
//      core 不调用 Electron API，documents 路径由宿主注入，
//      保证 core 纯 Node 可运行、vitest 可测试 —— M1-08 验收锚点）
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";

export default tseslint.config(
  // 忽略产物目录与依赖目录
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue 单文件组件（apps/desktop/src/renderer）：eslint-plugin-vue flat
  // 预设整组展开（自带 plugin 注册 / vue parser / files 限定 .vue）
  ...pluginVue.configs["flat/recommended"],
  // <script lang="ts"> 块的 TS 语法（import type 等）需显式指定子解析器
  // （预设缺省不接 tseslint parser，TS 专属语法会 Parsing error）；
  // 补 browser globals（console / window 等）；格式类 vue 规则关闭——
  // 格式交 Prettier（工程既有分工：eslint 质量 / prettier 格式，
  // prettier 原生支持 .vue，避免与 vue stylistic 规则互搏）
  {
    files: ["**/*.vue"],
    languageOptions: {
      // globals@13 browser 快照有带尾空格的脏 key（AudioWorkletGlobalScope ），
      // ESLint 10 校验直接拒载——渲染进程实际所需全局手动声明（按需补：
      // M2-07 增 URLSearchParams（autopilot query）/ Event + HTMLInputElement
      // （开关 change）/ setTimeout（轮询 sleep）；M3 增 KeyboardEvent
      // （接入模态 Escape 关闭））
      globals: {
        console: "readonly",
        window: "readonly",
        URLSearchParams: "readonly",
        Event: "readonly",
        HTMLInputElement: "readonly",
        setTimeout: "readonly",
        KeyboardEvent: "readonly",
      },
      parserOptions: { parser: tseslint.parser, sourceType: "module" },
    },
    rules: {
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
    },
  },
  {
    // 工程脚本（冒烟测试 / 打包辅助等纯 Node .mjs，含根 scripts/ 与
    // apps/desktop/scripts/）：补 Node 全局 + fetch（Node 18+ 全局可用，
    // globals.node 快照未收录；M2-02 smoke-auth 的 HTTP 通道用）
    files: ["**/scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, fetch: "readonly" },
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electron", "electron/**"],
              message:
                "core 禁止直接依赖 Electron（设计文档 6.7）：documents 等宿主路径由外部注入，保持 core 纯 Node 可运行、可单测。",
            },
            {
              group: ["node:sqlite"],
              message:
                "node:sqlite 只允许出现在 stores/sqlite-repository.ts（设计文档 7.2：SQL 访问全部收敛 Repository 单一模块；其余代码经 createSqliteStores 工厂注入）。",
            },
          ],
        },
      ],
    },
  },
  {
    // 放行清单：Repository 本体 + 其单测（测试需直接打开物理 DB 探测 WAL / 注入数据，
    // 产品代码路径仍被上一层的 electron + node:sqlite 双禁令覆盖）
    files: [
      "packages/core/src/stores/sqlite-repository.ts",
      "packages/core/src/stores/sqlite-repository.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electron", "electron/**"],
              message:
                "core 禁止直接依赖 Electron（设计文档 6.7）：documents 等宿主路径由外部注入，保持 core 纯 Node 可运行、可单测。",
            },
          ],
        },
      ],
    },
  },
);
