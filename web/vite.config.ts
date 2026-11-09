import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { authPlugin } from "./auth-plugin";

// 設定 PUBLIC_DEV=1 時（對外開放，經 Cloudflare Tunnel），vite 與 vite preview 都會：
// - 開啟登入閘道（auth-plugin.ts），而且只綁 127.0.0.1，tunnel 連 http://127.0.0.1:5173；
// - 關掉 HMR 與 WebSocket（WebSocket 不經過登入閘道），改完程式要手動重新整理。
// preview 的 host、allowedHosts、proxy 沿用這裡 server 的設定。
const publicDev = process.env.PUBLIC_DEV === "1";

export default defineConfig({
  plugins: [react(), ...(publicDev ? [authPlugin(path.resolve(__dirname, "../.keys"))] : [])],
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
    host: publicDev ? "127.0.0.1" : undefined,
    // localhost 與 IP 位址 Vite 本來就放行，只需列出 tunnel 的網域
    allowedHosts: publicDev ? [".trycloudflare.com"] : undefined,
    hmr: publicDev ? false : undefined,
    ws: publicDev ? false : undefined,
  },
});
