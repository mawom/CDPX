import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { handleBrowserRoute, BROWSER_BIN, getStatus } from "./cdp/index.ts";

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

const wsClients = new Set<ServerWebSocket<unknown>>();

function broadcastStatus(): void {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type: "status", instances: getStatus() });
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

  // WebSocket upgrade
  if (p === "/ws") {
    if (API_TOKEN && !checkToken()) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
    }
    if (server.upgrade(req)) return;
    return new Response("WebSocket upgrade failed", { status: 400, headers: CORS });
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
        broadcastStatus();
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
      html = html.replace("<script>", `<script>window.__CDPX_TOKEN="${API_TOKEN}";`);
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
  open(ws: ServerWebSocket<unknown>) {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: "status", instances: getStatus() }));
  },
  async message(ws: ServerWebSocket<unknown>, msg: string | Buffer) {
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
        broadcastStatus();
      }
    } catch (err: any) {
      if (reqId) {
        try { ws.send(JSON.stringify({ id: reqId, error: err.message || "internal error" })); } catch {}
      }
    }
  },
  close(ws: ServerWebSocket<unknown>) {
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
console.log();
