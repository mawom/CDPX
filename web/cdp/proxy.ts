import {
  invalidateTabCache, getTabs, cdpCommand, closeTab,
  tabProxies, tabContexts,
  type Tab,
} from "./shared.ts";

// Create an isolated BrowserContext (optional proxy)
export async function createContext(
  port: number,
  opts?: { proxy?: string },
): Promise<{ contextId?: string; error?: string }> {
  try {
    const vRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await vRes.json() as { webSocketDebuggerUrl: string };
    if (!webSocketDebuggerUrl) return { error: "cannot get browser WS endpoint" };

    const params: any = {};
    if (opts?.proxy) {
      try {
        const u = new URL(opts.proxy);
        params.proxyServer = `${u.protocol}//${u.host}`;
      } catch {
        params.proxyServer = opts.proxy;
      }
    }

    const contextId = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: "Target.createBrowserContext", params }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          clearTimeout(timeout);
          ws.close();
          if (msg.result?.browserContextId) resolve(msg.result.browserContextId);
          else reject(new Error(msg.error?.message || "failed"));
        } catch (e) {
          clearTimeout(timeout);
          ws.close();
          reject(e instanceof Error ? e : new Error("parse error"));
        }
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("ws error")); };
      ws.onclose = () => { clearTimeout(timeout); reject(new Error("ws closed")); };
    });

    return { contextId };
  } catch (err: any) {
    return { error: err.message };
  }
}

// Open tab in an existing BrowserContext
export async function openTabInContext(
  port: number,
  contextId: string,
  url?: string,
): Promise<{ tab?: Tab; error?: string }> {
  try {
    const vRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await vRes.json() as { webSocketDebuggerUrl: string };
    if (!webSocketDebuggerUrl) return { error: "cannot get browser WS endpoint" };

    const targetId = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1, method: "Target.createTarget",
          params: { url: url || "about:blank", browserContextId: contextId },
        }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          clearTimeout(timeout);
          ws.close();
          if (msg.result?.targetId) resolve(msg.result.targetId);
          else reject(new Error(msg.error?.message || "failed"));
        } catch (e) {
          clearTimeout(timeout);
          ws.close();
          reject(e instanceof Error ? e : new Error("parse error"));
        }
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("ws error")); };
      ws.onclose = () => { clearTimeout(timeout); reject(new Error("ws closed")); };
    });

    invalidateTabCache(port);
    const tabs = await getTabs(port);
    const tab = tabs.find((t) => t.id === targetId) ||
      { id: targetId, title: "", url: url || "about:blank", type: "page" } as Tab;
    tabContexts.set(tab.id, { contextId });
    return { tab };
  } catch (err: any) {
    return { error: err.message };
  }
}

// Close a BrowserContext and all tabs in it
export async function closeContext(
  port: number,
  contextId: string,
): Promise<{ ok: boolean; error?: string }> {
  // Collect tab IDs first to avoid mutating map during iteration
  const tabIds = [...tabContexts.entries()]
    .filter(([, ctx]) => ctx.contextId === contextId)
    .map(([tabId]) => tabId);
  for (const tabId of tabIds) {
    await closeTab(port, tabId);
  }
  // Dispose the context
  try {
    const vRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await vRes.json() as { webSocketDebuggerUrl: string };
    if (webSocketDebuggerUrl) {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(webSocketDebuggerUrl);
        const t = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 3000);
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: "Target.disposeBrowserContext", params: { browserContextId: contextId } }));
        };
        ws.onmessage = () => { clearTimeout(t); try { ws.close(); } catch {} resolve(); };
        ws.onerror = () => { clearTimeout(t); resolve(); };
        ws.onclose = () => { clearTimeout(t); resolve(); };
      });
    }
  } catch {}
  return { ok: true };
}

// Open tab in an isolated browser context with its own proxy
export async function openTabWithProxy(
  port: number,
  proxy: string,
  url?: string,
): Promise<{ tab?: Tab; contextId?: string; error?: string }> {
  invalidateTabCache(port);

  // Parse proxy: strip auth for context creation, keep auth for Fetch injection
  let proxyNoAuth = proxy;
  let proxyUser = "", proxyPass = "";
  try {
    const u = new URL(proxy);
    proxyUser = decodeURIComponent(u.username);
    proxyPass = decodeURIComponent(u.password);
    proxyNoAuth = `${u.protocol}//${u.host}`;
  } catch {}

  try {
    const vRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await vRes.json() as { webSocketDebuggerUrl: string };
    if (!webSocketDebuggerUrl) return { error: "cannot get browser WS endpoint" };

    // Step 1+2: Create context + target via browser-level WS
    const { targetId, contextId } = await new Promise<{ targetId: string; contextId: string }>((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      let nextId = 1;
      let ctxId = "";
      const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 10000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: nextId++,
          method: "Target.createBrowserContext",
          params: { proxyServer: proxyNoAuth },
        }));
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1 && msg.result?.browserContextId) {
            ctxId = msg.result.browserContextId;
            // Always open about:blank first — auth handler needs to be ready before real navigation
            ws.send(JSON.stringify({
              id: nextId++,
              method: "Target.createTarget",
              params: { url: "about:blank", browserContextId: ctxId },
            }));
          }
          if (msg.id === 2 && msg.result?.targetId) {
            clearTimeout(timeout);
            ws.close();
            resolve({ targetId: msg.result.targetId, contextId: ctxId });
          }
          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          }
        } catch {}
      };

      ws.onerror = () => { clearTimeout(timeout); reject(new Error("websocket error")); };
      ws.onclose = () => { clearTimeout(timeout); reject(new Error("websocket closed")); };
    });

    invalidateTabCache(port);
    const tabs = await getTabs(port);
    const tab = tabs.find((t) => t.id === targetId) ||
      { id: targetId, title: "", url: url || "about:blank", type: "page" } as Tab;

    // Step 3: If proxy has auth, inject Fetch auth handler on this tab
    if (proxyUser && tab.webSocketDebuggerUrl) {
      // Navigate to about:blank first, enable Fetch auth, then navigate to real URL
      const authWs = new WebSocket(tab.webSocketDebuggerUrl);
      let nextId = 1;
      await new Promise<void>((resolve) => {
        authWs.onopen = () => {
          // Enable Fetch with auth handling
          authWs.send(JSON.stringify({
            id: nextId++,
            method: "Fetch.enable",
            params: { handleAuthRequests: true },
          }));
        };
        authWs.onmessage = (ev: MessageEvent) => {
          try {
            const msg = JSON.parse(String(ev.data));
            // Enable response
            if (msg.id === 1) resolve();
            // Auth challenge from proxy
            if (msg.method === "Fetch.authRequired") {
              authWs.send(JSON.stringify({
                id: nextId++,
                method: "Fetch.continueWithAuth",
                params: {
                  requestId: msg.params.requestId,
                  authChallengeResponse: { response: "ProvideCredentials", username: proxyUser, password: proxyPass },
                },
              }));
            }
            // Continue all paused requests (skip response-stage interceptions)
            if (msg.method === "Fetch.requestPaused" && !msg.params.responseStatusCode) {
              authWs.send(JSON.stringify({
                id: nextId++,
                method: "Fetch.continueRequest",
                params: { requestId: msg.params.requestId },
              }));
            }
          } catch {}
        };
        authWs.onerror = () => resolve();
        setTimeout(() => {
          // Auth handler setup timed out — still usable, just might miss first auth
          resolve();
        }, 5000);
      });
      // Now navigate to the real URL (auth handler is ready)
      if (url) {
        await cdpCommand(port, tab.id, "Page.navigate", { url });
      }
      // Record with authWs for cleanup
      tabProxies.set(tab.id, proxy);
      tabContexts.set(tab.id, { contextId, authWs });
    } else {
      if (url) {
        await cdpCommand(port, tab.id, "Page.navigate", { url });
      }
      tabProxies.set(tab.id, proxy);
      tabContexts.set(tab.id, { contextId });
    }

    return { tab, contextId };
  } catch (err: any) {
    return { error: err.message };
  }
}
