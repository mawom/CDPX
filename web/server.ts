import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { handleBrowserRoute, BROWSER_BIN, getStatus } from "./cdp/index.ts";
import { pwOpen, pwMessage, pwClose } from "./cdp/playwright.ts";

const PORT = parseInt(process.env.PORT || "1024", 10);

// --- API Token (auto-generated on first run, skip with --no-auth) ---
const NO_AUTH = process.argv.includes("--no-auth");
const TOKEN_FILE = path.resolve(import.meta.dirname!, "..", ".token");

function getOrCreateToken(): string {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token);
  return token;
}

const API_TOKEN = NO_AUTH ? "" : getOrCreateToken();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MUTATION_ROUTES = new Set([
  "/api/browser/start", "/api/browser/stop", "/api/browser/restart",
  "/api/browser/stop-all", "/api/browser/open", "/api/browser/close-tab",
  "/api/browser/navigate", "/api/browser/install-extension", "/api/browser/uninstall-extension",
]);

type WsData = { type: "status" } | { type: "cdp-proxy"; wsUrl: string } | { type: "pw"; port: number };
const wsClients = new Set<ServerWebSocket<WsData>>();
const cdpProxies = new Map<ServerWebSocket<WsData>, { ws: WebSocket; queue: string[] }>();

async function broadcastStatus(): Promise<void> {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type: "status", instances: await getStatus() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

function log(method: string, url: string, status: number, start: number): void {
  const ms = Date.now() - start;
  const color = status < 400 ? "\x1b[32m" : "\x1b[31m";
  console.log(`  ${color}${method}\x1b[0m ${url} \x1b[2m${status} ${ms}ms\x1b[0m`);
}

function getLocalIP(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const publicDir = path.resolve(import.meta.dirname!, "public");
const docsPath = path.resolve(import.meta.dirname!, "..", "docs", "api.md");

// --- Shared fetch handler & websocket config ---
async function handleFetch(req: Request, server: any) {
  const url = new URL(req.url);
  const p = url.pathname;
  const start = Date.now();

  // Token check helper
  const checkToken = () => {
    if (!API_TOKEN) return true;
    const t = url.searchParams.get("token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    return t === API_TOKEN;
  };

  // WebSocket upgrade — status push
  if (p === "/ws") {
    if (API_TOKEN && !checkToken()) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
    }
    if (server.upgrade(req, { data: { type: "status" } as WsData })) return;
    return new Response("WebSocket upgrade failed", { status: 400, headers: CORS });
  }

  // Playwright connect() endpoint
  const pwMatch = p.match(/^\/pw\/(\d+)$/);
  if (pwMatch) {
    const pwPort = parseInt(pwMatch[1]);
    if (!pwPort || pwPort < 1 || pwPort > 65535) {
      return Response.json({ error: "invalid port" }, { status: 400, headers: CORS });
    }
    if (API_TOKEN && !checkToken()) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
    }
    if (server.upgrade(req, { data: { type: "pw", port: pwPort } as WsData })) return;
    return new Response("WebSocket upgrade failed", { status: 400, headers: CORS });
  }

  // CDP reverse proxy — Playwright compatible
  // GET  /cdp/:port/json/version → proxy + rewrite webSocketDebuggerUrl
  // GET  /cdp/:port/json         → proxy + rewrite webSocketDebuggerUrl per tab
  // WS   /cdp/:port/devtools/*   → bidirectional proxy to Chrome
  const cdpMatch = p.match(/^\/cdp\/(\d+)(\/.*)?$/);
  if (cdpMatch) {
    const cdpPort = parseInt(cdpMatch[1]);
    const cdpPath = cdpMatch[2] || "";
    if (!cdpPort || cdpPort < 1 || cdpPort > 65535) {
      return Response.json({ error: "invalid port" }, { status: 400, headers: CORS });
    }
    if (API_TOKEN && !checkToken()) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
    }

    // WS upgrade for /devtools/* paths — validate path contains only safe chars
    if (cdpPath.startsWith("/devtools/") && /^\/devtools\/[a-zA-Z0-9\-_\/]+$/.test(cdpPath)) {
      const targetWsUrl = `ws://127.0.0.1:${cdpPort}${cdpPath}`;
      if (server.upgrade(req, { data: { type: "cdp-proxy", wsUrl: targetWsUrl } as WsData })) return;
      return new Response("WebSocket upgrade failed", { status: 400, headers: CORS });
    }

    // HTTP proxy for /json endpoints — exact match only (no double-slash bypass)
    const normalizedCdpPath = cdpPath.replace(/\/+/g, "/");
    if (normalizedCdpPath === "/json/version" || normalizedCdpPath === "/json" || normalizedCdpPath === "/json/list" || normalizedCdpPath === "") {
      const chromePath = normalizedCdpPath || "/json/version";
      try {
        const chromeRes = await fetch(`http://127.0.0.1:${cdpPort}${chromePath}`, { signal: AbortSignal.timeout(5000) });
        const data = await chromeRes.json() as any;
        const host = req.headers.get("host") || `localhost:${PORT}`;
        const proto = req.headers.get("x-forwarded-proto") === "https" ? "wss" : "ws";
        const tokenQ = API_TOKEN ? `?token=${API_TOKEN}` : "";
        const rewrite = (wsUrl: string) => {
          const m = wsUrl.match(/^wss?:\/\/[^/]+(\/devtools\/.+)$/);
          return m ? `${proto}://${host}/cdp/${cdpPort}${m[1]}${tokenQ}` : wsUrl;
        };
        if (Array.isArray(data)) {
          for (const tab of data) {
            if (tab.webSocketDebuggerUrl) tab.webSocketDebuggerUrl = rewrite(tab.webSocketDebuggerUrl);
          }
        } else if (data.webSocketDebuggerUrl) {
          data.webSocketDebuggerUrl = rewrite(data.webSocketDebuggerUrl);
        }
        log("GET", p, 200, start);
        return Response.json(data, { headers: CORS });
      } catch {
        return Response.json({ error: "browser not running on port " + cdpPort }, { status: 502, headers: CORS });
      }
    }

    return Response.json({ error: "unknown cdp path" }, { status: 404, headers: CORS });
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // API docs (public, no auth required)
  if (p === "/api/browser/docs" || p === "/api/browser/docs/") {
    if (fs.existsSync(docsPath)) {
      log("GET", p, 200, start);
      return new Response(Bun.file(docsPath), {
        headers: { "Content-Type": "text/markdown; charset=utf-8", ...CORS },
      });
    }
    return new Response("docs not found", { status: 404, headers: CORS });
  }
  if (p === "/api/browser/docs/zh" || p === "/api/browser/docs/zh/") {
    const zhPath = docsPath.replace("api.md", "api_zh.md");
    if (fs.existsSync(zhPath)) {
      log("GET", p, 200, start);
      return new Response(Bun.file(zhPath), {
        headers: { "Content-Type": "text/markdown; charset=utf-8", ...CORS },
      });
    }
    return new Response("docs not found", { status: 404, headers: CORS });
  }

  // API routes
  if (p.startsWith("/api/browser")) {
    if (!checkToken()) {
      return Response.json({ error: "unauthorized", hint: "pass ?token=xxx or Authorization: Bearer xxx" }, { status: 401, headers: CORS });
    }
    try {
      const body = req.method === "POST" ? await req.text() : "";
      const result = await handleBrowserRoute(req.method!, p + url.search, body);
      const status = result.status ?? 200;
      log(req.method!, p + url.search, status, start);
      if (req.method === "POST" && status < 400 && MUTATION_ROUTES.has(p)) {
        broadcastStatus().catch(() => {});
      }
      return Response.json(result, { status, headers: CORS });
    } catch (err: any) {
      log(req.method!, p, 500, start);
      return Response.json({ error: err.message }, { status: 500, headers: CORS });
    }
  }

  // Static files
  const pathname = p === "/" ? "/index.html" : p;
  const filePath = path.resolve(publicDir, "." + pathname);
  if ((filePath === publicDir || filePath.startsWith(publicDir + path.sep)) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    // HTML pages require token, inject it for frontend JS
    if (ext === ".html" && API_TOKEN) {
      if (!checkToken()) {
        return new Response(`Unauthorized. Access: http://localhost:${PORT}/?token=YOUR_TOKEN`, { status: 401, headers: CORS });
      }
      let html = await Bun.file(filePath).text();
      html = html.replace("<script>", `<script>window.__CDPX_TOKEN=${JSON.stringify(API_TOKEN)};`);
      log("GET", p, 200, start);
      return new Response(html, { headers: { "Content-Type": mime } });
    }
    log("GET", p, 200, start);
    return new Response(Bun.file(filePath), { headers: { "Content-Type": mime } });
  }

  log(req.method, p, 404, start);
  return new Response("Not Found", { status: 404, headers: CORS });
}

const wsHandler = {
  async open(ws: ServerWebSocket<WsData>) {
    const data = ws.data;
    if (data.type === "pw") {
      pwOpen(ws, data.port);
      return;
    }
    if (data.type === "status") {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type: "status", instances: await getStatus() }));
      return;
    }
    // cdp-proxy: connect to Chrome WS and bridge
    const chromeWs = new WebSocket(data.wsUrl);
    const proxy = { ws: chromeWs, queue: [] as string[] };
    cdpProxies.set(ws, proxy);
    chromeWs.onopen = () => {
      for (const m of proxy.queue) chromeWs.send(m);
      proxy.queue.length = 0;
    };
    chromeWs.onmessage = (e) => {
      try { ws.send(e.data as string); } catch {}
    };
    chromeWs.onclose = () => {
      cdpProxies.delete(ws);
      try { ws.close(); } catch {}
    };
    chromeWs.onerror = () => {
      cdpProxies.delete(ws);
      try { ws.close(); } catch {}
    };
  },
  async message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    if (ws.data.type === "pw") {
      pwMessage(ws, msg);
      return;
    }
    if (ws.data.type === "cdp-proxy") {
      const proxy = cdpProxies.get(ws);
      if (!proxy) return;
      const str = String(msg);
      if (proxy.ws.readyState === WebSocket.OPEN) {
        proxy.ws.send(str);
      } else {
        proxy.queue.push(str);
      }
      return;
    }
    // status WS — API call forwarding
    let reqId: number | undefined;
    try {
      const req = JSON.parse(String(msg)) as { id: number; method?: string; path?: string; body?: any };
      reqId = req.id;
      if (!req.id || !req.path) return;
      const httpMethod = req.method || "GET";
      const body = req.body ? JSON.stringify(req.body) : "";
      const result = await handleBrowserRoute(httpMethod, "/api/browser" + req.path, body);
      ws.send(JSON.stringify({ id: req.id, result }));
      const p = "/api/browser" + req.path.split("?")[0];
      if (httpMethod === "POST" && (result.status ?? 200) < 400 && MUTATION_ROUTES.has(p)) {
        broadcastStatus().catch(() => {});
      }
    } catch (err: any) {
      if (reqId) {
        try { ws.send(JSON.stringify({ id: reqId, error: err.message || "internal error" })); } catch {}
      }
    }
  },
  close(ws: ServerWebSocket<WsData>) {
    if (ws.data.type === "pw") {
      pwClose(ws);
      return;
    }
    if (ws.data.type === "cdp-proxy") {
      const proxy = cdpProxies.get(ws);
      if (proxy) {
        cdpProxies.delete(ws);
        try { proxy.ws.close(); } catch {}
      }
      return;
    }
    wsClients.delete(ws);
  },
};

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: handleFetch,
  websocket: wsHandler,
});

// Check browser
if (!fs.existsSync(BROWSER_BIN)) {
  console.log();
  console.log("  \x1b[33m⚠ Ungoogled-Chromium not installed\x1b[0m");
  console.log("  \x1b[2m  brew install --cask eloston-chromium\x1b[0m");
  console.log();
}

const ip = getLocalIP();
const tokenSuffix = API_TOKEN ? `/?token=${API_TOKEN}` : "";
console.log();
console.log("  \x1b[1m\x1b[36m⚡ CDPX Web\x1b[0m");
console.log();
console.log(`  \x1b[2m➜\x1b[0m  Local:   \x1b[36mhttp://localhost:${PORT}${tokenSuffix}\x1b[0m`);
console.log(`  \x1b[2m➜\x1b[0m  Network: \x1b[36mhttp://${ip}:${PORT}${tokenSuffix}\x1b[0m`);
if (API_TOKEN) {
  console.log(`  \x1b[2m➜\x1b[0m  Token:   \x1b[33m${API_TOKEN}\x1b[0m`);
} else {
  console.log(`  \x1b[2m➜\x1b[0m  Auth:    \x1b[33mdisabled (--no-auth)\x1b[0m`);
}
console.log(`  \x1b[2m➜\x1b[0m  CDP:     \x1b[2m/cdp/{port}/json/version\x1b[0m`);
console.log(`  \x1b[2m➜\x1b[0m  PW:      \x1b[2m/pw/{port}  (Playwright connect)\x1b[0m`);
console.log();
