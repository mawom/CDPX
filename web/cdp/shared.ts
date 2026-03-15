import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const BROWSER_BIN =
  process.env.CHROMIUM_BIN || "/Applications/Chromium.app/Contents/MacOS/Chromium";

export const BASE_DIR = path.join(os.homedir(), "cdpx/browser");
export const PROFILES_DIR = path.join(BASE_DIR, "profiles");
export const PIDS_DIR = path.join(BASE_DIR, "pids");
export const EXTENSIONS_DIR = path.join(BASE_DIR, "extensions");
export const SNAPSHOTS_DIR = path.join(BASE_DIR, "snapshots");
// Reserve the web server port
export const RESERVED_PORTS = new Set([parseInt(process.env.PORT || "1024", 10)]);

export function ensureDirs(): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(PIDS_DIR, { recursive: true });
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

export function pidFile(port: number): string {
  return path.join(PIDS_DIR, `${port}.pid`);
}

export function metaFile(port: number): string {
  return path.join(PIDS_DIR, `${port}.json`);
}

export function saveMeta(port: number, data: Record<string, unknown>): void {
  fs.writeFileSync(metaFile(port), JSON.stringify(data));
}

export function loadMeta(port: number): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(metaFile(port), "utf-8"));
  } catch {
    return {};
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeExtName(name: string): string {
  // Strip path separators and dangerous chars, keep alphanumeric + dash/underscore/dot
  let safe = name.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 64);
  // Prevent directory traversal: collapse consecutive dots
  safe = safe.replace(/\.{2,}/g, ".");
  // Prevent empty or dot-only names
  if (!safe || safe === ".") safe = "_";
  return safe;
}

export function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const parsed = new URL(url, "http://localhost");
  const query: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) query[k] = v;
  return { path: parsed.pathname, query };
}

export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1024 && n <= 65535 && !RESERVED_PORTS.has(n);
}

export function parseBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return { __invalid: true };
  }
}

export function monitorKey(port: number, tabId: string): string {
  return `${port}:${tabId}`;
}

export interface Instance {
  port: number;
  pid: number;
  running: boolean;
  proxy?: string;
  stealth?: boolean;
  headless?: boolean;
  fingerprint?: string;
}

export interface Tab {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
  faviconUrl?: string;
}

export interface RouteResult {
  status?: number;
  [key: string]: unknown;
}

export interface StartOpts {
  proxy?: string;
  headless?: boolean;
  stealth?: boolean;
  fingerprint?: "random" | "default";
}

// --- Tab list cache per port ---
const _tabCache = new Map<number, { tabs: Tab[]; ts: number }>();
const TAB_CACHE_TTL = 1000; // 1s

export async function getTabs(port: number): Promise<Tab[]> {
  const now = Date.now();
  const cached = _tabCache.get(port);
  if (cached && now - cached.ts < TAB_CACHE_TTL) {
    return cached.tabs;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) });
    const tabs = (await res.json()) as Tab[];
    // Include any target with a debugger URL (pages, extensions, service workers, etc.)
    const filtered = tabs.filter((t) => t.webSocketDebuggerUrl);
    _tabCache.set(port, { tabs: filtered, ts: now });
    return filtered;
  } catch {
    return [];
  }
}

export function invalidateTabCache(port?: number): void {
  if (port) _tabCache.delete(port);
  else _tabCache.clear();
}

export async function cdpCommand(
  port: number,
  tabId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const tabs = await getTabs(port);
  const tab = tabs.find(
    (t) => t.id === tabId && t.webSocketDebuggerUrl,
  );
  if (!tab) return { error: "tab not found" };

  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { result?: unknown; error?: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(v);
      try { ws.close(); } catch {}
    };

    const ws = new WebSocket(tab.webSocketDebuggerUrl!);
    const timeout = setTimeout(() => finish({ error: "timeout" }), 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== 1) return;
        finish(msg.error ? { error: msg.error } : { result: msg.result });
      } catch {
        finish({ error: "invalid response" });
      }
    };

    ws.onerror = () => finish({ error: "websocket error" });
    ws.onclose = () => finish({ error: "websocket closed" });
  });
}

export async function cdpSession(
  port: number,
  tabId: string,
  fn: (api: {
    send: (method: string, params?: Record<string, unknown>) => Promise<any>;
    waitEvent: (method: string, timeoutMs?: number) => Promise<any>;
  }) => Promise<any>,
  timeoutMs = 30000,
): Promise<{ result?: any; error?: string }> {
  const tabs = await getTabs(port);
  const tab = tabs.find((t) => t.id === tabId && t.webSocketDebuggerUrl);
  if (!tab) return { error: "tab not found" };

  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl!);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const eventWaiters = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();

    const globalTimeout = setTimeout(() => {
      ws.close();
      resolve({ error: "session timeout" });
    }, timeoutMs);

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(msg.error);
          else p.resolve(msg.result);
        }
        if (msg.method && eventWaiters.has(msg.method)) {
          const w = eventWaiters.get(msg.method)!;
          eventWaiters.delete(msg.method);
          clearTimeout(w.timer);
          w.resolve(msg.params);
        }
      } catch {}
    };

    function rejectAllPending(reason: string) {
      for (const [, p] of pending) {
        p.reject(new Error(reason));
      }
      pending.clear();
      for (const [, w] of eventWaiters) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
      eventWaiters.clear();
    }

    ws.onerror = () => {
      rejectAllPending("websocket error");
      clearTimeout(globalTimeout);
      resolve({ error: "websocket error" });
    };

    ws.onclose = () => {
      rejectAllPending("websocket closed");
      clearTimeout(globalTimeout);
      resolve({ error: "websocket closed" });
    };

    ws.onopen = async () => {
      const api = {
        send(method: string, params?: Record<string, unknown>): Promise<any> {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (err) {
              pending.delete(id);
              rej(err);
            }
          });
        },
        waitEvent(method: string, ms = 15000): Promise<any> {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              eventWaiters.delete(method);
              rej(new Error(`waitEvent timeout: ${method}`));
            }, ms);
            eventWaiters.set(method, { resolve: res, timer });
          });
        },
      };

      try {
        const result = await fn(api);
        clearTimeout(globalTimeout);
        resolve({ result });
        ws.close();
      } catch (err: any) {
        clearTimeout(globalTimeout);
        resolve({ error: err?.message || String(err) });
        ws.close();
      }
    };
  });
}

export async function openTab(port: number, url?: string): Promise<Tab | null> {
  invalidateTabCache(port);
  try {
    const endpoint = url
      ? `http://127.0.0.1:${port}/json/new?${encodeURI(url)}`
      : `http://127.0.0.1:${port}/json/new`;
    const res = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(5000) });
    return (await res.json()) as Tab;
  } catch {
    return null;
  }
}

export async function closeTab(port: number, tabId: string): Promise<boolean> {
  invalidateTabCache(port);

  // Close tab first, then clean up resources (avoid half-dead state)
  let closed = false;
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${tabId}`, { signal: AbortSignal.timeout(5000) });
    closed = true;
  } catch {}

  // Clean up all tab resources regardless of close success
  tabProxies.delete(tabId);
  const key = monitorKey(port, tabId);
  const { networkMonitors, consoleMonitors, downloadMonitors } = await import("./monitor.ts");
  const nm = networkMonitors.get(key);
  if (nm) { try { nm.ws.close(); } catch {} networkMonitors.delete(key); }
  const cm = consoleMonitors.get(key);
  if (cm) { try { cm.ws.close(); } catch {} consoleMonitors.delete(key); }
  const dm = downloadMonitors.get(key);
  if (dm) { try { dm.ws.close(); } catch {} downloadMonitors.delete(key); }
  for (const [k, v] of tabNames) { if (v === tabId) tabNames.delete(k); }
  const ctx = tabContexts.get(tabId);
  if (ctx) {
    tabContexts.delete(tabId);
    try { ctx.authWs?.close(); } catch {}
    try {
      const vRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      const { webSocketDebuggerUrl } = await vRes.json() as { webSocketDebuggerUrl: string };
      if (webSocketDebuggerUrl) {
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(webSocketDebuggerUrl);
          const t = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 3000);
          ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method: "Target.disposeBrowserContext", params: { browserContextId: ctx.contextId } }));
          };
          ws.onmessage = () => { clearTimeout(t); try { ws.close(); } catch {} resolve(); };
          ws.onerror = () => { clearTimeout(t); resolve(); };
          ws.onclose = () => { clearTimeout(t); resolve(); };
        });
      }
    } catch {}
  }

  return closed;
}

export function refOrSelectorExpr(ref?: number, selector?: string): string {
  if (ref != null) {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1) return "null";
    return `document.querySelector('[data-cdpx-ref="${n}"]')`;
  }
  if (selector) return `document.querySelector(${JSON.stringify(selector)})`;
  return "null";
}

// --- Tab naming ---
export const tabNames = new Map<string, string>(); // "port:name" → tabId
export const tabProxies = new Map<string, string>(); // tabId → proxy URL
export const tabContexts = new Map<string, { contextId: string; authWs?: WebSocket }>(); // tabId → context info

export function setTabName(port: number, tabId: string, name: string): void {
  tabNames.set(`${port}:${name}`, tabId);
}

export function getTabByName(port: number, name: string): string | null {
  return tabNames.get(`${port}:${name}`) || null;
}
