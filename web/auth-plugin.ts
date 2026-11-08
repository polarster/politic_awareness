/**
 * 開發／預覽伺服器的登入閘道（PUBLIC_DEV=1 對外開放時使用）。
 *
 * - 帳密放在專案根目錄的 .keys/site_login，一行「帳號:密碼」，密碼至少 16 字元。
 *   檔案不存在或格式不符時一律拒絕登入（fail closed），並在終端機印出警告。
 * - 登入後發 HMAC 簽章的 cookie。簽章內容綁定目前的帳密，所以改了 site_login，
 *   所有舊 cookie 立刻失效（不用重啟）。簽章金鑰在 .keys/session_secret（hex），
 *   不存在時自動產生；內容不是 hex 時拒絕啟動，避免變成空金鑰。
 * - 同一個閘道同時掛在 vite（configureServer）與 vite preview（configurePreviewServer）。
 * - 只允許綁在 loopback（127.0.0.1、::1、localhost），外部連線一律經 Cloudflare Tunnel 進來。
 * - 閘道本身出任何例外都回 401（fail closed），不交給 Vite 的錯誤頁。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Connect, Plugin } from "vite";

const COOKIE = "pa_session";
export const MAX_AGE = 12 * 3600; // cookie 有效 12 小時
export const MIN_PASS_LENGTH = 16;
const MAX_BODY = 4096;
const SESSION_RE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const HEX_SECRET_RE = /^[0-9a-f]{64,}$/i;
// cloudflared 從本機連進來；只有這些來源送的 CF-Connecting-IP 才採用
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** 每個回應都帶的安全標頭（禁止被其他網站用 iframe 嵌入等）。CSP 只放在正式部署用的 web/public/_headers */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function warn(msg: string) {
  console.warn(`[simple-login] ${msg}`);
}

// ── 簽章金鑰 ──

/** 讀取簽章金鑰。只有檔案不存在時才自動產生；內容不是 hex 就丟錯，讓 vite 起不來 */
export function loadSecret(dir: string): Buffer {
  const file = path.join(dir, "session_secret");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return createSecret(dir, file);
  }
  if (!HEX_SECRET_RE.test(text) || text.length % 2 !== 0) {
    throw new Error(
      `${file} 必須是至少 64 個字元的 hex（例如 openssl rand -hex 32 的輸出）。` +
        "要換新金鑰：刪掉這個檔案再重啟，會自動產生。",
    );
  }
  return Buffer.from(text, "hex");
}

function createSecret(dir: string, file: string): Buffer {
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 先寫暫存檔再改名：中途失敗也不會留下空的 session_secret
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, secret.toString("hex"), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return secret;
}

/** .keys 目錄或裡面的檔案若開放給 group／other，就印警告 */
function warnLoosePermissions(dir: string) {
  try {
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode & 0o077) warn(`${dir} 的權限是 ${mode.toString(8)}，請改成 700（chmod 700 ${dir}）。`);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (st.isFile() && st.mode & 0o077) {
        warn(`${file} 的權限是 ${(st.mode & 0o777).toString(8)}，請改成 600。`);
      }
    }
  } catch {
    // 讀不到目錄時不檢查；金鑰與帳密另有錯誤處理
  }
}

// ── 帳密 ──

export type Creds = { user: string; pass: string; tag: string };

/** 解析 site_login：帳號不可為空、密碼至少 16 字元；不合格時回傳問題說明 */
export function parseCreds(text: string): Creds | string {
  const line = text.split(/\r?\n/)[0].trim();
  const i = line.indexOf(":");
  if (i <= 0) return "格式應為一行「帳號:密碼」";
  const user = line.slice(0, i);
  const pass = line.slice(i + 1);
  if (pass.length < MIN_PASS_LENGTH) return `密碼至少要 ${MIN_PASS_LENGTH} 個字元`;
  // tag 會綁進 cookie 簽章：帳密一改，舊 cookie 全部失效
  const tag = crypto.createHash("sha256").update(`${user}:${pass}`).digest("base64url");
  return { user, pass, tag };
}

/** 讀取 site_login；依 inode、大小、修改時間快取，檔案一改就重讀 */
function credsReader(file: string): () => Creds | null {
  let stamp = "";
  let creds: Creds | null = null;
  return () => {
    let next = "unreadable";
    try {
      const st = fs.statSync(file);
      next = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      // 檔案不存在或讀不到
    }
    if (next === stamp) return creds;
    stamp = next;
    creds = null;
    try {
      const parsed = parseCreds(fs.readFileSync(file, "utf8"));
      if (typeof parsed === "string") warn(`${file}：${parsed}，所有登入都會被拒絕。`);
      else creds = parsed;
    } catch {
      warn(`讀不到 ${file}，所有登入都會被拒絕。`);
    }
    return creds;
  };
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest();
}

/** 帳密比對：兩邊先 sha256 成等長再用 timingSafeEqual，帳號和密碼都比完才判斷 */
function credsMatch(user: string, pass: string, creds: Creds): boolean {
  const userOk = crypto.timingSafeEqual(sha256(user), sha256(creds.user));
  const passOk = crypto.timingSafeEqual(sha256(pass), sha256(creds.pass));
  return userOk && passOk;
}

// ── Session cookie ──

function sign(key: Buffer, payload: string) {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** cookie 內容：「到期時間.HMAC(到期時間|帳密 tag)」 */
export function makeSession(key: Buffer, tag: string, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + MAX_AGE);
  return `${exp}.${sign(key, `${exp}|${tag}`)}`;
}

/** 格式、到期時間（必須在未來 MAX_AGE 秒內）與簽章（綁定目前帳密）都要對 */
export function validSession(key: Buffer, tag: string | undefined, value: string | undefined, now = Date.now()): boolean {
  if (!tag || !value) return false;
  const m = SESSION_RE.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  const t = now / 1000;
  if (exp <= t || exp > t + MAX_AGE) return false;
  return safeEqual(sign(key, `${m[1]}|${tag}`), m[2]);
}

/** 只取 pa_session，而且不做 decodeURIComponent：其他 cookie 格式再怪也不會讓閘道丟例外 */
function sessionCookies(req: IncomingMessage): string[] {
  const out: string[] = [];
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) out.push(part.slice(i + 1).trim());
  }
  return out;
}

// ── 登入限流 ──

/**
 * 限流用的來源 IP：只有連線來自本機（cloudflared）時，才採用 Cloudflare 給的 CF-Connecting-IP，
 * 而且必須是合法的 IP；其他情況一律用連線位址，不讓直連的人自帶標頭換限流桶。
 */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">): string {
  const peer = req.socket.remoteAddress ?? "";
  const cf = req.headers["cf-connecting-ip"];
  if (LOOPBACK_PEERS.has(peer) && typeof cf === "string" && cf.length <= 45 && net.isIP(cf) !== 0) return cf;
  return peer || "unknown";
}

export type LimiterOptions = { windowMs: number; perIp: number; global: number; maxKeys: number };
const DEFAULT_LIMITS: LimiterOptions = { windowMs: 15 * 60_000, perIp: 10, global: 30, maxKeys: 10_000 };

/**
 * 登入嘗試限流（只存在記憶體）：每個 IP 每 15 分鐘 10 次、全站 30 次、最多記 10000 個來源。
 * 檢查與記錄在同一段同步程式碼完成，先送標頭、晚點才送 body 的請求也會先被算進去。
 * 過期紀錄每分鐘清一次；登入成功就刪掉該來源的紀錄，並退還這次占用的全站名額。
 */
export class LoginLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: LimiterOptions = DEFAULT_LIMITS) {}

  /** 還有額度就立刻記一筆並回傳 true；超過上限回傳 false */
  reserve(ip: string, now = Date.now()): boolean {
    this.purge(now);
    if (this.global.length >= this.opts.global) return false;
    let list = this.perIp.get(ip);
    if (!list) {
      if (this.perIp.size >= this.opts.maxKeys) return false; // 滿了就拒收新來源，不淘汰舊的
      list = [];
      this.perIp.set(ip, list);
    }
    if (list.length >= this.opts.perIp) return false;
    list.push(now);
    this.global.push(now);
    this.schedulePurge();
    return true;
  }

  succeeded(ip: string, reservedAt: number) {
    this.perIp.delete(ip);
    const i = this.global.indexOf(reservedAt);
    if (i >= 0) this.global.splice(i, 1);
  }

  /** 目前記著幾個來源 */
  get size() {
    return this.perIp.size;
  }

  purge(now = Date.now()) {
    const cutoff = now - this.opts.windowMs;
    this.global = this.global.filter((t) => t > cutoff);
    for (const [ip, list] of this.perIp) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) this.perIp.set(ip, kept);
      else this.perIp.delete(ip);
    }
  }

  private schedulePurge() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.purge();
      if (this.global.length || this.perIp.size) this.schedulePurge();
    }, 60_000);
    this.timer.unref?.();
  }
}

// ── 頁面 ──

function page(title: string, inner: string) {
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
:root{--bg:#f6f5f1;--fg:#1d1d1f;--card:#fff;--line:#e2e0da;--accent:#2f5d8a}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--fg:#ececef;--card:#1f1f22;--line:#34343a;--accent:#7fa8d4}}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"PingFang TC","Noto Sans TC",sans-serif;display:grid;place-items:center;min-height:100vh}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;width:min(320px,calc(100vw - 32px));display:grid;gap:12px}
input{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button{font:inherit;padding:8px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer}
.err{color:#b3261e;margin:0}
</style></head><body>
${inner}
</body></html>`;
}

function loginPage(msg = "") {
  return page(
    "登入",
    `<form method="post" action="/__login">
<strong>政治光譜自我探索（開發中）</strong>
${msg ? `<p class="err">${msg}</p>` : ""}
<input name="user" placeholder="帳號" autocomplete="username" required>
<input name="pass" type="password" placeholder="密碼" autocomplete="current-password" required>
<button type="submit">登入</button>
</form>`,
  );
}

function logoutPage() {
  return page(
    "登出",
    `<form method="post" action="/__logout">
<strong>政治光譜自我探索（開發中）</strong>
<button type="submit">登出</button>
</form>`,
  );
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

/** 閘道出錯時一律當作未登入，不回 stack、不交給 Vite 的錯誤處理 */
function failClosed(res: ServerResponse) {
  try {
    if (res.headersSent) res.destroy();
    else send(res, 401, loginPage());
  } catch {
    res.destroy();
  }
}

// ── 閘道 ──

export type GateOptions = { limiter?: LoginLimiter; bodyTimeoutMs?: number; now?: () => number };

export function createGate(keysDir: string, opts: GateOptions = {}): Connect.NextHandleFunction {
  const key = loadSecret(keysDir);
  warnLoosePermissions(keysDir);
  const readCreds = credsReader(path.join(keysDir, "site_login"));
  readCreds(); // 啟動時先讀一次，有問題馬上印警告
  const limiter = opts.limiter ?? new LoginLimiter();
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const cookieAttrs = "Path=/; HttpOnly; Secure; SameSite=Lax";

  function login(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req);
    const at = now();
    if (!limiter.reserve(ip, at)) {
      return send(res, 429, loginPage("嘗試太多次，請 15 分鐘後再試。"), { "Retry-After": "900" });
    }
    let body = "";
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const abort = () => {
      aborted = true;
      clearTimeout(timer);
      req.destroy();
    };
    timer = setTimeout(abort, bodyTimeoutMs); // body 太慢就斷線（這次仍算一次嘗試）
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) abort();
    });
    req.on("error", () => clearTimeout(timer));
    req.on("end", () => {
      clearTimeout(timer);
      if (aborted) return;
      try {
        const form = new URLSearchParams(body);
        const creds = readCreds();
        if (!creds || !credsMatch(form.get("user") ?? "", form.get("pass") ?? "", creds)) {
          return send(res, 401, loginPage(creds ? "帳號或密碼錯誤。" : "伺服器尚未設定帳號密碼。"));
        }
        limiter.succeeded(ip, at);
        send(res, 303, "", {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${makeSession(key, creds.tag, now())}; ${cookieAttrs}; Max-Age=${MAX_AGE}`,
        });
      } catch {
        failClosed(res);
      }
    });
  }

  /** 回傳 true 表示已登入、交給後面的 middleware；false 表示閘道已自己回應 */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = (req.url ?? "/").split("?", 1)[0];
    if (pathname === "/__login" && req.method === "POST") {
      login(req, res);
      return false;
    }
    if (pathname === "/__logout") {
      // 只有 POST 會清 cookie；直接開網址看到的是登出按鈕
      if (req.method === "POST") send(res, 303, "", { Location: "/", "Set-Cookie": `${COOKIE}=; ${cookieAttrs}; Max-Age=0` });
      else send(res, 200, logoutPage());
      return false;
    }
    const tag = readCreds()?.tag;
    if (sessionCookies(req).some((v) => validSession(key, tag, v, now()))) return true;
    if (pathname.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
      send(res, 401, JSON.stringify({ detail: "請先登入" }), { "Content-Type": "application/json; charset=utf-8" });
    } else {
      send(res, 401, loginPage());
    }
    return false;
  }

  return (req, res, next) => {
    let authed = false;
    try {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      authed = handle(req, res);
    } catch {
      failClosed(res);
      return;
    }
    if (authed) next(); // 放在 try 外面：後面 middleware 的錯誤照 Vite 原本的方式處理
  };
}

// ── Vite plugin ──

/** PUBLIC_DEV 只允許綁在 loopback：0.0.0.0 或區網 IP 會讓人繞過 Cloudflare 直連 */
export function isLoopbackHost(host: string | boolean | undefined): boolean {
  return host === undefined || host === false || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** 對外模式不提供任何 WebSocket（HMR 已關）：升級請求一律立刻回 403 並斷線，不讓連線一直掛著 */
export function refuseUpgrade(_req: IncomingMessage, socket: Duplex) {
  // Node 交給 upgrade handler 之前已經拿掉自己掛在 socket 上的 error listener。不補這行的話，
  // client 送出升級請求後立刻 reset（ECONNRESET）會變成沒人處理的 'error' 事件，整個 vite 行程直接結束
  socket.on("error", () => socket.destroy());
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
}

export function authPlugin(keysDir: string): Plugin {
  let isPreview = false;
  let gate: Connect.NextHandleFunction | undefined;
  const install = (server: { middlewares: Connect.Server; httpServer: unknown }) => {
    if (!gate) throw new Error("simple-login：登入閘道尚未初始化");
    server.middlewares.use(gate);
    // 排在 Vite proxy 的 upgrade listener 前面；proxy 對非 ws 的請求什麼都不做，連線會一直掛著
    (server.httpServer as HttpServer | null)?.on("upgrade", refuseUpgrade);
  };
  return {
    name: "simple-login",
    apply: "serve", // vite 與 vite preview 都是 serve；build 不需要
    config(_config, env) {
      isPreview = env.isPreview === true;
    },
    configResolved(config) {
      // 先檢查綁定位址再讀金鑰：綁錯就直接拒絕啟動
      const host = isPreview ? config.preview.host : config.server.host;
      if (!isLoopbackHost(host)) {
        throw new Error(
          `PUBLIC_DEV=1 只能綁在 127.0.0.1（目前的 host 是 ${String(host)}）。` +
            "請用 --host 127.0.0.1 啟動，外部連線經 Cloudflare Tunnel（--url http://127.0.0.1:5173）進來。",
        );
      }
      gate = createGate(keysDir);
    },
    configureServer(server) {
      install(server);
    },
    configurePreviewServer(server) {
      install(server);
    },
  };
}
