/**
 * 開發伺服器的簡單登入檢查（對外開放時使用）。
 *
 * 帳號密碼放在專案根目錄的 .keys/site_login，格式為一行「帳號:密碼」。
 * 檔案不存在時一律拒絕存取（fail closed）。
 * 登入後發一個 HMAC 簽章的 cookie；簽章金鑰存在 .keys/session_secret（自動產生）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const COOKIE = "pa_session";
const MAX_AGE = 7 * 24 * 3600; // 7 天

function readCreds(dir: string): { user: string; pass: string } | null {
  try {
    const line = fs.readFileSync(path.join(dir, "site_login"), "utf8").split(/\r?\n/)[0].trim();
    const i = line.indexOf(":");
    if (i <= 0) return null;
    return { user: line.slice(0, i), pass: line.slice(i + 1) };
  } catch {
    return null;
  }
}

function secret(dir: string): Buffer {
  const f = path.join(dir, "session_secret");
  try {
    return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex");
  } catch {
    const s = crypto.randomBytes(32);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, s.toString("hex"), { mode: 0o600 });
    return s;
  }
}

function sign(key: Buffer, payload: string) {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function validSession(key: Buffer, value: string | undefined): boolean {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sign(key, exp), sig);
}

function clientIp(req: IncomingMessage): string {
  return (req.headers["cf-connecting-ip"] as string) || req.socket.remoteAddress || "?";
}

// 登入嘗試限流：每個 IP 每 15 分鐘最多 10 次（只存在記憶體）
const attempts = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, list);
  return list.length >= 10;
}

function loginPage(msg = "") {
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>登入</title>
<style>
:root{--bg:#f6f5f1;--fg:#1d1d1f;--card:#fff;--line:#e2e0da;--accent:#2f5d8a}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--fg:#ececef;--card:#1f1f22;--line:#34343a;--accent:#7fa8d4}}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"PingFang TC","Noto Sans TC",sans-serif;display:grid;place-items:center;min-height:100vh}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;width:min(320px,calc(100vw - 32px));display:grid;gap:12px}
input{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button{font:inherit;padding:8px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer}
.err{color:#b3261e;margin:0}
</style></head><body>
<form method="post" action="/__login">
<strong>政治光譜自我探索（開發中）</strong>
${msg ? `<p class="err">${msg}</p>` : ""}
<input name="user" placeholder="帳號" autocomplete="username" required>
<input name="pass" type="password" placeholder="密碼" autocomplete="current-password" required>
<button type="submit">登入</button>
</form></body></html>`;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

export function authPlugin(keysDir: string): Plugin {
  const key = secret(keysDir);
  return {
    name: "simple-login",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (url === "/__login" && req.method === "POST") {
          const ip = clientIp(req);
          if (tooMany(ip)) return send(res, 429, loginPage("嘗試太多次，請 15 分鐘後再試。"));
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
          req.on("end", () => {
            const f = new URLSearchParams(body);
            const creds = readCreds(keysDir);
            const ok = !!creds && safeEqual(f.get("user") ?? "", creds.user) && safeEqual(f.get("pass") ?? "", creds.pass);
            if (!ok) {
              attempts.get(ip)!.push(Date.now());
              return send(res, 401, loginPage(creds ? "帳號或密碼錯誤。" : "尚未設定帳號密碼。"));
            }
            const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
            const secure = req.headers["x-forwarded-proto"] === "https" || !!req.headers["cf-connecting-ip"];
            send(res, 303, "", {
              Location: "/",
              "Set-Cookie": `${COOKIE}=${exp}.${sign(key, exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`,
            });
          });
          return;
        }
        if (url === "/__logout") {
          return send(res, 303, "", { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0` });
        }
        if (validSession(key, cookies(req)[COOKIE])) return next();
        if (url.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ detail: "請先登入" }));
        }
        return send(res, 401, loginPage());
      });
    },
  };
}
