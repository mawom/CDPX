import {
  invalidateTabCache, getTabs, cdpCommand,
  tabProxies, tabContexts,
  type Tab,
} from "./shared.ts";

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

    invalidateTabCache();
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
