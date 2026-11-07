import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { authPlugin } from "./auth-plugin";

// 設定 PUBLIC_DEV=1 時（對外開放，例如透過 Cloudflare Tunnel），開啟登入檢查並允許外部主機名稱
const publicDev = process.env.PUBLIC_DEV === "1";

export default defineConfig({
  plugins: [react(), ...(publicDev ? [authPlugin(path.resolve(__dirname, "../.keys"))] : [])],
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
    allowedHosts: publicDev ? [".trycloudflare.com", "localhost", "127.0.0.1", "192.168.105.123"] : undefined,
    hmr: publicDev ? { clientPort: 443 } : undefined,
  },
});
