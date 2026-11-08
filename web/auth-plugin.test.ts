// 登入閘道（auth-plugin.ts）與 PUBLIC_DEV 設定的測試；帳密與金鑰都用暫存目錄裡的假資料
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import type { Connect, Plugin, UserConfig } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  authPlugin,
  clientIp,
  createGate,
  isLoopbackHost,
  loadSecret,
  LoginLimiter,
  makeSession,
  MAX_AGE,
  parseCreds,
  refuseUpgrade,
  validSession,
} from "./auth-plugin";

const PASS = "correct-horse-battery-staple";
const tmpDirs: string[] = [];

function keysDir(login: string | null = `tester:${PASS}`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-gate-"));
  tmpDirs.push(dir);
  if (login !== null) fs.writeFileSync(path.join(dir, "site_login"), `${login}\n`, { mode: 0o600 });
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 把閘道接到真的 HTTP server（127.0.0.1、隨機埠），後面的 app 一律回 200 "app" */
async function serve(gate: Connect.NextHandleFunction) {
  const server = http.createServer((req, res) => {
    try {
      gate(req, res, (err?: unknown) => {
        res.writeHead(err ? 500 : 200, { "Content-Type": "text/plain" });
        res.end(err ? "next(err)" : "app");
      });
    } catch {
      res.writeHead(500);
      res.end("thrown");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

function close(server: http.Server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

const form = (user: string, pass: string) => new URLSearchParams({ user, pass }).toString();

function login(url: string, user: string, pass: string, ip = "198.51.100.1") {
  return fetch(`${url}/__login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: form(user, pass),
  });
}

function cookieOf(res: Response) {
  return res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
}

/** 先送標頭、等 send() 才送 body 的登入請求 */
function delayedLogin(port: number, ip: string, body = form("tester", "wrong-password-0000")) {
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: "/__login",
    method: "POST",
    agent: false,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body), "CF-Connecting-IP": ip },
  });
  const done = new Promise<number | string>((resolve) => {
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
  });
  req.flushHeaders();
  return { done, send: () => req.end(body) };
}

describe("loadSecret（S14）", () => {
  it("檔案不存在時自動產生 64 位 hex，目錄 700、檔案 600", () => {
    const dir = path.join(keysDir(null), "keys");
    const key = loadSecret(dir);
    const file = path.join(dir, "session_secret");
    expect(key).toHaveLength(32);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual(["session_secret"]); // 沒有留下暫存檔
    expect(loadSecret(dir).equals(key)).toBe(true);
  });

  it.each([
    ["空檔", ""],
    ["只有換行", "\n"],
    ["密語", "correct horse battery staple"],
    ["0x 前綴", `0x${"ab".repeat(32)}`],
    ["base64", crypto.randomBytes(32).toString("base64")],
    ["太短", "ab".repeat(31)],
    ["奇數長度", `${"ab".repeat(32)}c`],
  ])("內容不是合格的 hex（%s）時拒絕啟動，不會變成空金鑰", (_name, content) => {
    const dir = keysDir();
    fs.writeFileSync(path.join(dir, "session_secret"), content, { mode: 0o600 });
    expect(() => loadSecret(dir)).toThrow(/hex/);
  });
});

describe("parseCreds（S14）", () => {
  it.each([
    ["tester:"],
    ["tester:short"],
    [`:${PASS}`],
    ["沒有冒號"],
    [""],
  ])("帳號空白或密碼少於 16 字元時拒絕：%s", (line) => {
    expect(typeof parseCreds(line)).toBe("string");
  });

  it("合格的帳密回傳 tag，帳密不同 tag 也不同", () => {
    const a = parseCreds(`tester:${PASS}`);
    const b = parseCreds(`tester:${PASS}x`);
    expect(a).toMatchObject({ user: "tester", pass: PASS });
    expect(typeof a !== "string" && typeof b !== "string" && a.tag !== b.tag).toBe(true);
  });
});

describe("session cookie（S13、S14）", () => {
  const key = crypto.randomBytes(32);
  const now = Date.UTC(2026, 10, 7);
  const sig = (payload: string) => crypto.createHmac("sha256", key).update(payload).digest("base64url");

  it("簽章綁定帳密：同一組帳密有效，換了帳密就失效", () => {
    const v = makeSession(key, "tag-a", now);
    expect(validSession(key, "tag-a", v, now)).toBe(true);
    expect(validSession(key, "tag-b", v, now)).toBe(false);
    expect(validSession(key, undefined, v, now)).toBe(false); // site_login 不存在
  });

  it("到期時間不是正常數字，或超過 MAX_AGE，都不接受", () => {
    for (const exp of ["NaN", "abc", "Infinity", "-1", "1e12"]) {
      expect(validSession(key, "t", `${exp}.${sig(`${exp}|t`)}`, now)).toBe(false);
    }
    const far = String(Math.floor(now / 1000) + 10 * 365 * 86400);
    expect(validSession(key, "t", `${far}.${sig(`${far}|t`)}`, now)).toBe(false);
    const past = String(Math.floor(now / 1000) - 1);
    expect(validSession(key, "t", `${past}.${sig(`${past}|t`)}`, now)).toBe(false);
    expect(validSession(key, "t", makeSession(key, "t", now), now + (MAX_AGE + 1) * 1000)).toBe(false);
  });

  it("空金鑰自簽的 cookie 無效", () => {
    const exp = String(Math.floor(now / 1000) + 3600);
    const forged = `${exp}.${crypto.createHmac("sha256", Buffer.alloc(0)).update(`${exp}|t`).digest("base64url")}`;
    expect(validSession(key, "t", forged, now)).toBe(false);
  });
});

describe("clientIp（S3）", () => {
  const req = (peer: string, cf?: string) =>
    ({ socket: { remoteAddress: peer }, headers: cf === undefined ? {} : { "cf-connecting-ip": cf } }) as Parameters<typeof clientIp>[0];

  it("只有本機（cloudflared）送來的合法 CF-Connecting-IP 才採用", () => {
    expect(clientIp(req("127.0.0.1", "203.0.113.5"))).toBe("203.0.113.5");
    expect(clientIp(req("::ffff:127.0.0.1", "2001:db8::1"))).toBe("2001:db8::1");
    expect(clientIp(req("::1", "203.0.113.5"))).toBe("203.0.113.5");
  });

  it("直連的人自帶標頭、或標頭不是 IP，都改用連線位址", () => {
    expect(clientIp(req("192.168.1.20", "203.0.113.5"))).toBe("192.168.1.20");
    expect(clientIp(req("172.17.0.2", "203.0.113.5"))).toBe("172.17.0.2");
    expect(clientIp(req("127.0.0.1", "1.2.3.4, 5.6.7.8"))).toBe("127.0.0.1");
    expect(clientIp(req("127.0.0.1", "x".repeat(15_000)))).toBe("127.0.0.1");
    expect(clientIp(req("127.0.0.1", "not-an-ip"))).toBe("127.0.0.1");
    expect(clientIp(req("127.0.0.1"))).toBe("127.0.0.1");
  });
});

describe("LoginLimiter（S3）", () => {
  const t0 = 1_000_000;

  it("每個來源 15 分鐘最多 10 次", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 10; i++) expect(l.reserve("a", t0 + i)).toBe(true);
    expect(l.reserve("a", t0 + 10)).toBe(false);
    expect(l.reserve("b", t0 + 10)).toBe(true);
    expect(l.reserve("a", t0 + 15 * 60_000 + 1)).toBe(true); // 視窗過後恢復
  });

  it("全站 15 分鐘最多 30 次：一直換來源也會被擋", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 30; i++) expect(l.reserve(`10.0.0.${i}`, t0)).toBe(true);
    expect(l.reserve("10.0.1.1", t0)).toBe(false);
  });

  it("來源數到上限就拒收新來源，舊來源照常計算", () => {
    const l = new LoginLimiter({ windowMs: 60_000, perIp: 10, global: 1000, maxKeys: 3 });
    for (const ip of ["a", "b", "c"]) expect(l.reserve(ip, t0)).toBe(true);
    expect(l.reserve("d", t0)).toBe(false);
    expect(l.reserve("a", t0)).toBe(true);
    expect(l.size).toBe(3);
  });

  it("過期的來源會被清掉；登入成功會刪掉紀錄並退還全站名額", () => {
    const l = new LoginLimiter({ windowMs: 60_000, perIp: 10, global: 2, maxKeys: 100 });
    expect(l.reserve("a", t0)).toBe(true);
    expect(l.reserve("b", t0)).toBe(true);
    expect(l.reserve("c", t0)).toBe(false);
    l.succeeded("b", t0);
    expect(l.size).toBe(1);
    expect(l.reserve("c", t0)).toBe(true);
    l.purge(t0 + 60_001);
    expect(l.size).toBe(0);
  });
});

describe("登入閘道（HTTP）", () => {
  it("格式錯誤的 cookie 不會讓閘道丟例外，一律回 401（S10）", async () => {
    const { server, url } = await serve(createGate(keysDir()));
    try {
      for (const cookie of ["x=%", "other_app=%E0%A4%A", "a=%zz; pa_session=%", "pa_session=NaN.abc"]) {
        const res = await fetch(`${url}/`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(401);
        expect(await res.text()).not.toMatch(/URIError|at decodeURIComponent/);
      }
      const api = await fetch(`${url}/api/usage`, { headers: { Cookie: "x=%" } });
      expect(api.status).toBe(401);
      expect(await api.json()).toEqual({ detail: "請先登入" });
    } finally {
      await close(server);
    }
  });

  it("登入後 cookie 帶 Secure／HttpOnly，所有回應都有安全標頭（S8、S26）", async () => {
    const { server, url } = await serve(createGate(keysDir()));
    try {
      const anon = await fetch(`${url}/`);
      expect(anon.status).toBe(401);
      expect(anon.headers.get("x-frame-options")).toBe("DENY");
      expect(anon.headers.get("x-content-type-options")).toBe("nosniff");
      expect(anon.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

      const res = await login(url, "tester", PASS);
      expect(res.status).toBe(303);
      const setCookie = res.headers.getSetCookie()[0];
      expect(setCookie).toMatch(/; HttpOnly/);
      expect(setCookie).toMatch(/; Secure/);
      expect(setCookie).toMatch(/; SameSite=Lax/);
      expect(setCookie).toMatch(new RegExp(`Max-Age=${MAX_AGE}$`));

      const ok = await fetch(`${url}/`, { headers: { Cookie: `junk=%; ${cookieOf(res)}` } });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("app");
      expect(ok.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      await close(server);
    }
  });

  it("改了 site_login，舊 cookie 立刻失效，不用重啟（S13）", async () => {
    const dir = keysDir();
    const { server, url } = await serve(createGate(dir));
    try {
      const cookie = cookieOf(await login(url, "tester", PASS));
      expect((await fetch(`${url}/`, { headers: { Cookie: cookie } })).status).toBe(200);
      fs.writeFileSync(path.join(dir, "site_login"), `tester:${PASS}-rotated\n`);
      expect((await fetch(`${url}/`, { headers: { Cookie: cookie } })).status).toBe(401);
      fs.rmSync(path.join(dir, "site_login"));
      expect((await fetch(`${url}/`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await close(server);
    }
  });

  it("site_login 的密碼太短或空白時，帳密正確也不放行（S14）", async () => {
    for (const line of ["tester:", "tester:short-pass"]) {
      const { server, url } = await serve(createGate(keysDir(line)));
      try {
        const res = await fetch(`${url}/__login`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: line === "tester:" ? "user=tester" : form("tester", "short-pass"),
        });
        expect(res.status).toBe(401);
        expect(res.headers.getSetCookie()).toEqual([]);
      } finally {
        await close(server);
      }
    }
  });

  it("登出只接受 POST；直接開網址只看到登出按鈕（S13）", async () => {
    const { server, url } = await serve(createGate(keysDir()));
    try {
      const get = await fetch(`${url}/__logout`, { redirect: "manual" });
      expect(get.status).toBe(200);
      expect(get.headers.getSetCookie()).toEqual([]);
      expect(await get.text()).toContain('method="post" action="/__logout"');
      const post = await fetch(`${url}/__logout`, { method: "POST", redirect: "manual" });
      expect(post.status).toBe(303);
      expect(post.headers.getSetCookie()[0]).toMatch(/^pa_session=; .*Max-Age=0$/);
    } finally {
      await close(server);
    }
  });

  it("同一來源錯 10 次後回 429；先送標頭、晚點送 body 的請求也會先被算進去（S3）", async () => {
    const { server, url, port } = await serve(createGate(keysDir()));
    try {
      const pending = Array.from({ length: 12 }, () => delayedLogin(port, "198.51.100.50"));
      // 還沒送 body 就已經有 2 個被擋下
      const early = await Promise.all(pending.map((p) => Promise.race([p.done, new Promise((r) => setTimeout(() => r("pending"), 300))])));
      expect(early.filter((s) => s === 429)).toHaveLength(2);
      expect(early.filter((s) => s === "pending")).toHaveLength(10);
      pending.forEach((p) => p.send());
      const final = await Promise.all(pending.map((p) => p.done));
      expect(final.filter((s) => s === 401)).toHaveLength(10);
      // 被鎖住後，帶正確密碼也一樣擋下
      expect((await login(url, "tester", PASS, "198.51.100.50")).status).toBe(429);
      // 其他來源不受影響
      expect((await login(url, "tester", PASS, "198.51.100.51")).status).toBe(303);
    } finally {
      await close(server);
    }
  });

  it("body 太慢就斷線，而且這次仍算一次嘗試（S3）", async () => {
    const limiter = new LoginLimiter({ windowMs: 60_000, perIp: 1, global: 30, maxKeys: 100 });
    const { server, url, port } = await serve(createGate(keysDir(), { bodyTimeoutMs: 200, limiter }));
    try {
      const slow = delayedLogin(port, "198.51.100.60");
      expect(await slow.done).toBe("ECONNRESET");
      expect((await login(url, "tester", PASS, "198.51.100.60")).status).toBe(429);
    } finally {
      await close(server);
    }
  });
});

describe("authPlugin（S1、S8、S16）", () => {
  type Hook = (...args: unknown[]) => unknown;
  const call = (plugin: Plugin, name: keyof Plugin, ...args: unknown[]) => (plugin[name] as Hook)(...args);
  const resolved = (serverHost: unknown, previewHost: unknown = serverHost) => ({
    server: { host: serverHost },
    preview: { host: previewHost },
  });

  it.each([
    ["0.0.0.0", false],
    [true, false],
    ["::", false],
    ["192.168.1.20", false],
    ["127.0.0.2", false],
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    [undefined, true],
  ])("綁定位址 %s 是否允許：%s", (host, ok) => {
    expect(isLoopbackHost(host as string | boolean | undefined)).toBe(ok);
    const dev = authPlugin(keysDir());
    call(dev, "config", {}, { command: "serve", mode: "development", isPreview: false });
    const run = () => call(dev, "configResolved", resolved(host));
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(/127\.0\.0\.1/);
  });

  it("vite preview 看的是 preview.host", () => {
    const p = authPlugin(keysDir());
    call(p, "config", {}, { command: "serve", mode: "production", isPreview: true });
    expect(() => call(p, "configResolved", resolved("127.0.0.1", "0.0.0.0"))).toThrow();
    expect(() => call(p, "configResolved", resolved("127.0.0.1", "127.0.0.1"))).not.toThrow();
  });

  it("綁定位址不對時，在讀金鑰之前就拒絕（不會產生 session_secret）", () => {
    const dir = path.join(keysDir(null), "keys");
    const p = authPlugin(dir);
    call(p, "config", {}, { command: "serve", mode: "development", isPreview: false });
    expect(() => call(p, "configResolved", resolved("0.0.0.0"))).toThrow();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.each(["configureServer", "configurePreviewServer"] as const)("%s 掛上閘道，並拒絕所有 WebSocket 升級", (hook) => {
    const p = authPlugin(keysDir());
    call(p, "config", {}, { command: "serve", mode: "development", isPreview: hook === "configurePreviewServer" });
    call(p, "configResolved", resolved("127.0.0.1"));
    const use = vi.fn();
    const on = vi.fn();
    call(p, hook, { middlewares: { use }, httpServer: { on } });
    expect(use).toHaveBeenCalledTimes(1);
    expect(typeof use.mock.calls[0][0]).toBe("function");
    expect(on).toHaveBeenCalledWith("upgrade", refuseUpgrade);
  });

  it("WebSocket 升級請求立刻得到 403 並斷線", () => {
    const end = vi.fn((_data: string, cb: () => void) => cb());
    const destroy = vi.fn();
    refuseUpgrade({} as http.IncomingMessage, { end, destroy, on: vi.fn() } as unknown as Duplex);
    expect(end.mock.calls[0][0]).toMatch(/^HTTP\/1\.1 403 /);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("升級請求的 socket 出錯時不會變成未處理的 error，只會斷線（S1）", () => {
    const socket = new PassThrough();
    const destroy = vi.spyOn(socket, "destroy");
    refuseUpgrade({} as http.IncomingMessage, socket);
    const reset = Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" });
    expect(() => socket.emit("error", reset)).not.toThrow();
    expect(destroy).toHaveBeenCalled();
  });

  it("client 送出升級請求後立刻 reset：寫 403 失敗也不會讓行程結束（S1）", async () => {
    // Node 交給 upgrade handler 的 socket 沒有 error listener。這裡用 pauseOnConnect 的 socket 模擬，
    // 而且先不讀取，client 的 reset 一定在寫 403 時才被發現（write ECONNRESET），不靠時間差
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    const server = net.createServer({ pauseOnConnect: true });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
    try {
      const [[socket]] = (await Promise.all([once(server, "connection"), once(client, "connect")])) as [[net.Socket], unknown];
      client.resetAndDestroy();
      await once(client, "close");
      await new Promise((resolve) => setTimeout(resolve, 20)); // 讓 RST 確實送到伺服器端
      const closed = new Promise<boolean>((resolve) => socket.once("close", resolve));
      refuseUpgrade({} as http.IncomingMessage, socket);
      expect(await closed).toBe(true); // hadError：確實走到寫入失敗的路徑
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("vite.config（PUBLIC_DEV=1）", () => {
  it("關掉 WebSocket 與 HMR、只綁 127.0.0.1、allowedHosts 只留 trycloudflare（S1、S8、S29）", async () => {
    vi.resetModules();
    vi.doMock("./auth-plugin", () => ({ authPlugin: () => ({ name: "simple-login" }) })); // 不碰真的 .keys
    vi.stubEnv("PUBLIC_DEV", "1");
    try {
      const config = (await import("./vite.config")).default as UserConfig;
      expect(config.server?.ws).toBe(false);
      expect(config.server?.hmr).toBe(false);
      expect(config.server?.host).toBe("127.0.0.1");
      expect(config.server?.allowedHosts).toEqual([".trycloudflare.com"]);
      expect(config.plugins?.flat().some((p) => (p as Plugin | null)?.name === "simple-login")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("./auth-plugin");
      vi.resetModules();
    }
  });
});
