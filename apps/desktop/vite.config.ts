/**
 * 渲染进程 Vite 配置（M2-06）
 *
 * - root 指向 src/renderer（主进程 tsc 产物不受影响，tsconfig 已 exclude）
 * - base "./"：prod 模式 file:// 加载需要相对资源引用
 * - outDir dist/renderer：与主进程产物 dist/*.js 同居 apps/desktop/dist，
 *   main.ts 以 join(__dirname, "renderer", "index.html") 加载
 */
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [vue()],
  server: {
    // 显式绑定 IPv4 回环：本机 localhost 优先解析 ::1（IPv6），Vite 缺省
    // 只监听 [::1]——而 dev 脚本的 wait-on tcp:127.0.0.1:5173 与
    // VITE_DEV_SERVER_URL=http://127.0.0.1:5173 都走 IPv4，二者全部失配
    // （实测：wait-on 永久挂起 → electron 不启动 → 无窗口）
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
