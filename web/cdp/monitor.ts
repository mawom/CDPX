import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { monitorKey, getTabs } from "./shared.ts";
import type { Tab } from "./shared.ts";

// --- Network traffic monitoring (persistent CDP session) ---
export interface NetworkRequest {
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
  responseHeaders?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  postData?: string;
}

export interface NetworkMonitorHandle {
  ws: WebSocket;
  requests: Map<string, NetworkRequest>;
  nextCmdId: number;
  _pendingCmds?: Map<number, (msg: any) => void>;
}

export const networkMonitors = new Map<string, NetworkMonitorHandle>(); // key: "port:tabId"

export async function enableNetworkMonitor(
  port: number,
  tabId: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = monitorKey(port, tabId);
  if (networkMonitors.has(key)) return { ok: true }; // already monitoring

  const tabs = await getTabs(port);
  const tab = tabs.find((t) => t.id === tabId && t.webSocketDebuggerUrl);
  if (!tab) return { ok: false, error: "tab not found" };

  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl!);
    const handle: NetworkMonitorHandle = { ws, requests: new Map(), nextCmdId: 1 };
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: "timeout" });
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: handle.nextCmdId++, method: "Network.enable" }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));

        // Dispatch pending command responses (e.g. getResponseBody)
        if (msg.id && handle._pendingCmds?.has(msg.id)) {
          handle._pendingCmds.get(msg.id)!(msg);
          return;
        }

        // Enable response
        if (msg.id === 1) {
          clearTimeout(timeout);
          networkMonitors.set(key, handle);
          resolve({ ok: true });
          return;
        }

        // Capture request (cap at 10000 to prevent memory leak)
        if (msg.method === "Network.requestWillBeSent") {
          const p = msg.params;
          if (handle.requests.size >= 10000) {
            const oldest = handle.requests.keys().next().value;
            if (oldest !== undefined) handle.requests.delete(oldest);
          }
          handle.requests.set(p.requestId, {
            requestId: p.requestId,
            method: p.request.method,
            url: p.request.url,
            type: p.type,
            timestamp: Date.now(),
            requestHeaders: p.request.headers,
            postData: p.request.postData,
          });
        }

        // Capture response
        if (msg.method === "Network.responseReceived") {
          const p = msg.params;
          const req = handle.requests.get(p.requestId);
          if (req) {
            req.status = p.response.status;
            req.mimeType = p.response.mimeType;
            req.responseHeaders = p.response.headers;
          }
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      resolve({ ok: false, error: "websocket error" });
    };

    ws.onclose = () => {
      networkMonitors.delete(key);
    };
  });
}

export function disableNetworkMonitor(port: number, tabId: string): boolean {
  const key = monitorKey(port, tabId);
  const handle = networkMonitors.get(key);
  if (!handle) return false;
  try { handle.ws.close(); } catch {}
  networkMonitors.delete(key);
  return true;
}

export function getNetworkRequests(
  port: number,
  tabId: string,
  filter?: { url?: string; method?: string; type?: string },
): NetworkRequest[] {
  const key = monitorKey(port, tabId);
  const handle = networkMonitors.get(key);
  if (!handle) return [];
  let reqs = Array.from(handle.requests.values());
  if (filter?.url) {
    const pattern = filter.url;
    reqs = reqs.filter((r) => r.url.includes(pattern));
  }
  if (filter?.method) {
    const m = filter.method.toUpperCase();
    reqs = reqs.filter((r) => r.method === m);
  }
  if (filter?.type) {
    const t = filter.type.toLowerCase();
    reqs = reqs.filter((r) => r.type?.toLowerCase() === t);
  }
  return reqs;
}

export function clearNetworkRequests(port: number, tabId: string): void {
  const key = monitorKey(port, tabId);
  const handle = networkMonitors.get(key);
  if (handle) handle.requests.clear();
}

export async function getResponseBody(
  port: number,
  tabId: string,
  requestId: string,
): Promise<{ body?: string; base64Encoded?: boolean; error?: string }> {
  const key = monitorKey(port, tabId);
  const handle = networkMonitors.get(key);
  if (!handle) return { error: "network monitor not enabled" };

  // Use a pending map instead of replacing onmessage (safe for concurrent calls)
  if (!handle._pendingCmds) handle._pendingCmds = new Map();
  return new Promise((resolve) => {
    const id = handle.nextCmdId++;
    const timeout = setTimeout(() => {
      handle._pendingCmds?.delete(id);
      resolve({ error: "timeout" });
    }, 10000);
    handle._pendingCmds!.set(id, (msg: any) => {
      clearTimeout(timeout);
      handle._pendingCmds?.delete(id);
      if (msg.error) resolve({ error: msg.error.message || String(msg.error) });
      else if (msg.result) resolve({ body: msg.result.body, base64Encoded: msg.result.base64Encoded });
      else resolve({ error: "empty response" });
    });
    handle.ws.send(JSON.stringify({
      id,
      method: "Network.getResponseBody",
      params: { requestId },
    }));
  });
}

// --- Console log capture (persistent CDP session, like Network monitor) ---
export interface ConsoleEntry {
  level: string; // log, warning, error, info, debug
  text: string;
  url?: string;
  line?: number;
  timestamp: number;
}

export interface ConsoleMonitorHandle {
  ws: WebSocket;
  logs: ConsoleEntry[];
}

export const consoleMonitors = new Map<string, ConsoleMonitorHandle>();

export async function enableConsoleMonitor(
  port: number,
  tabId: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = monitorKey(port, tabId);
  if (consoleMonitors.has(key)) return { ok: true };

  const tabs = await getTabs(port);
  const tab = tabs.find((t) => t.id === tabId && t.webSocketDebuggerUrl);
  if (!tab) return { ok: false, error: "tab not found" };

  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl!);
    const handle: ConsoleMonitorHandle = { ws, logs: [] };
    const timeout = setTimeout(() => { ws.close(); resolve({ ok: false, error: "timeout" }); }, 10000);

    ws.onopen = () => {
      // Enable both Runtime (console API) and Log (browser errors) domains
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      ws.send(JSON.stringify({ id: 2, method: "Log.enable" }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 2) {
          clearTimeout(timeout);
          consoleMonitors.set(key, handle);
          resolve({ ok: true });
          return;
        }
        // console.log/warn/error/info (cap at 5000 entries)
        if (msg.method === "Runtime.consoleAPICalled") {
          const p = msg.params;
          if (handle.logs.length >= 5000) handle.logs.splice(0, 500);
          handle.logs.push({
            level: p.type, // log, warning, error, info, debug
            text: p.args?.map((a: any) => a.value ?? a.description ?? String(a.type)).join(" ") || "",
            timestamp: Date.now(),
          });
        }
        // JS exceptions (same cap as console logs)
        if (msg.method === "Runtime.exceptionThrown") {
          if (handle.logs.length >= 5000) handle.logs.splice(0, 500);
          const ex = msg.params?.exceptionDetails;
          handle.logs.push({
            level: "error",
            text: ex?.exception?.description || ex?.text || "unknown exception",
            url: ex?.url,
            line: ex?.lineNumber,
            timestamp: Date.now(),
          });
        }
        // Browser-level logs (network errors, security warnings, etc.)
        if (msg.method === "Log.entryAdded") {
          if (handle.logs.length >= 5000) handle.logs.splice(0, 500);
          const e = msg.params?.entry;
          handle.logs.push({
            level: e?.level || "info",
            text: e?.text || "",
            url: e?.url,
            line: e?.lineNumber,
            timestamp: Date.now(),
          });
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timeout); resolve({ ok: false, error: "websocket error" }); };
    ws.onclose = () => { consoleMonitors.delete(key); };
  });
}

export function disableConsoleMonitor(port: number, tabId: string): boolean {
  const key = monitorKey(port, tabId);
  const handle = consoleMonitors.get(key);
  if (!handle) return false;
  try { handle.ws.close(); } catch {}
  consoleMonitors.delete(key);
  return true;
}

export function getConsoleLogs(
  port: number,
  tabId: string,
  filter?: { level?: string },
): ConsoleEntry[] {
  const key = monitorKey(port, tabId);
  const handle = consoleMonitors.get(key);
  if (!handle) return [];
  let logs = handle.logs;
  if (filter?.level) {
    const lvl = filter.level.toLowerCase();
    logs = logs.filter((l) => l.level === lvl);
  }
  return logs;
}

export function clearConsoleLogs(port: number, tabId: string): void {
  const key = monitorKey(port, tabId);
  const handle = consoleMonitors.get(key);
  if (handle) handle.logs = [];
}

// --- Download interception ---
export interface DownloadEntry {
  guid: string;
  url: string;
  filename: string;
  state: string;
  timestamp: number;
}

export const downloadMonitors = new Map<string, { ws: WebSocket; downloads: DownloadEntry[]; _downloadMeta?: Record<string, { url: string; filename: string }> }>();

export async function enableDownloadIntercept(
  port: number,
  tabId: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = monitorKey(port, tabId);
  if (downloadMonitors.has(key)) return { ok: true };

  const tabs = await getTabs(port);
  const tab = tabs.find((t) => t.id === tabId && t.webSocketDebuggerUrl);
  if (!tab) return { ok: false, error: "tab not found" };

  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl!);
    const handle = { ws, downloads: [] as DownloadEntry[] };
    const timeout = setTimeout(() => { ws.close(); resolve({ ok: false, error: "timeout" }); }, 10000);

    const downloadDir = path.join(os.tmpdir(), "cdpx-downloads");
    ws.onopen = () => {
      // Ensure download dir exists before telling browser to use it
      fs.mkdirSync(downloadDir, { recursive: true });
      ws.send(JSON.stringify({ id: 1, method: "Browser.setDownloadBehavior", params: {
        behavior: "allowAndName", downloadPath: downloadDir,
        eventsEnabled: true,
      }}));
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) {
          clearTimeout(timeout);
          downloadMonitors.set(key, handle);
          resolve({ ok: true });
          return;
        }
        // Track download metadata from downloadWillBegin
        if (msg.method === "Browser.downloadWillBegin") {
          const p = msg.params;
          (handle as any)._downloadMeta = (handle as any)._downloadMeta || {};
          (handle as any)._downloadMeta[p.guid] = { url: p.url, filename: p.suggestedFilename };
        }
        if (msg.method === "Browser.downloadProgress" && msg.params?.state === "completed") {
          const meta = (handle as any)._downloadMeta?.[msg.params.guid];
          handle.downloads.push({
            guid: msg.params.guid,
            url: meta?.url || "",
            filename: meta?.filename || msg.params.guid,
            state: "completed",
            timestamp: Date.now(),
          });
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timeout); resolve({ ok: false, error: "websocket error" }); };
    ws.onclose = () => { downloadMonitors.delete(key); };
  });
}

export function getDownloads(port: number, tabId: string): DownloadEntry[] {
  const key = monitorKey(port, tabId);
  return downloadMonitors.get(key)?.downloads || [];
}
