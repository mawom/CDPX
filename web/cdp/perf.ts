import { cdpCommand, cdpSession, getTabs } from "./shared.ts";

// --- Performance Tracing (Chrome DevTools Performance recording) ---
export async function perfTrace(
  port: number,
  tabId: string,
  duration = 3000,
): Promise<{ trace?: any; error?: string }> {
  // Collect performance data via Runtime.evaluate (PerformanceObserver + timing API)
  // Wait for the specified duration to capture longtask entries
  await new Promise((r) => setTimeout(r, duration));
  const evalRes = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `JSON.stringify({
      timing: performance.timing ? {
        loadTime: performance.timing.loadEventEnd - performance.timing.navigationStart,
        domReady: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart,
        firstByte: performance.timing.responseStart - performance.timing.navigationStart,
      } : null,
      entries: performance.getEntriesByType('longtask').map(e => ({
        name: e.name, duration: e.duration, startTime: e.startTime
      })),
      memory: performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
      } : null,
      fps: null,
    })`,
    returnByValue: true,
  });
  try {
    return { trace: JSON.parse((evalRes.result as any)?.result?.value) };
  } catch {
    return { error: "trace failed" };
  }
}

// --- Long Task monitoring ---
export async function getLongTasks(
  port: number,
  tabId: string,
  threshold = 50,
): Promise<{ tasks?: any[]; error?: string }> {
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `JSON.stringify(
      performance.getEntriesByType('longtask')
        .filter(e => e.duration > ${threshold})
        .map(e => ({
          name: e.name,
          duration: Math.round(e.duration),
          startTime: Math.round(e.startTime),
        }))
    )`,
    returnByValue: true,
  });
  try {
    return { tasks: JSON.parse((res.result as any)?.result?.value) };
  } catch {
    return { error: "failed to get long tasks" };
  }
}

// --- INP measurement (Interaction to Next Paint) ---
export async function measureINP(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string },
): Promise<{ inp?: number; error?: string }> {
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `new Promise(resolve => {
      const observer = new PerformanceObserver(list => {
        const entries = list.getEntries();
        for (const entry of entries) {
          if (entry.entryType === 'event') {
            observer.disconnect();
            resolve(JSON.stringify({
              inp: Math.round(entry.duration),
              processingStart: Math.round(entry.processingStart - entry.startTime),
              processingEnd: Math.round(entry.processingEnd - entry.startTime),
            }));
            return;
          }
        }
      });
      observer.observe({ type: 'event', buffered: false, durationThreshold: 0 });
      // Trigger a click on the element
      const el = document.querySelector('[data-cdpx-ref="' + ${JSON.stringify(String(opts.ref || ""))} + '"]') || document.querySelector(${JSON.stringify(opts.selector || "body")});
      if (el) {
        el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        el.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
        el.click();
      }
      // Timeout after 5s
      setTimeout(() => { observer.disconnect(); resolve(JSON.stringify({inp: -1, error: "timeout"})); }, 5000);
    })`,
    returnByValue: true,
    awaitPromise: true,
  });
  try {
    return JSON.parse((res.result as any)?.result?.value);
  } catch {
    return { error: "INP measurement failed" };
  }
}

// --- Coverage API (JS/CSS usage) ---
// Persistent WS connection to keep coverage state alive between start and report
export const coverageSessions = new Map<string, { ws: WebSocket; nextId: number; pending: Map<number, (v: any) => void> }>();

function coverageKey(port: number, tabId: string): string { return `${port}:${tabId}`; }

function coverageSend(handle: { ws: WebSocket; nextId: number; pending: Map<number, (v: any) => void> }, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = handle.nextId++;
    const timer = setTimeout(() => { handle.pending.delete(id); reject(new Error("timeout")); }, 15000);
    handle.pending.set(id, (msg) => { clearTimeout(timer); handle.pending.delete(id); resolve(msg.result); });
    handle.ws.send(JSON.stringify({ id, method, params }));
  });
}

export async function startCoverage(
  port: number,
  tabId: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = coverageKey(port, tabId);
  // Close existing session if any
  const old = coverageSessions.get(key);
  if (old) { try { old.ws.close(); } catch {} coverageSessions.delete(key); }

  const tabs = await getTabs(port);
  const tab = tabs.find(t => t.id === tabId);
  if (!tab?.webSocketDebuggerUrl) return { ok: false, error: "tab not found" };

  try {
    const handle = await new Promise<{ ws: WebSocket; nextId: number; pending: Map<number, (v: any) => void> }>((resolve, reject) => {
      const ws = new WebSocket(tab.webSocketDebuggerUrl!);
      const h = { ws, nextId: 1, pending: new Map<number, (v: any) => void>() };
      const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 10000);
      ws.onopen = () => { clearTimeout(timeout); resolve(h); };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && h.pending.has(msg.id)) h.pending.get(msg.id)!(msg);
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("ws error")); };
    });

    await coverageSend(handle, "Profiler.enable");
    await coverageSend(handle, "Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await coverageSend(handle, "CSS.enable");
    await coverageSend(handle, "CSS.startRuleUsageTracking");

    coverageSessions.set(key, handle);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function getCoverageReport(
  port: number,
  tabId: string,
): Promise<{ files?: any[]; error?: string }> {
  const key = coverageKey(port, tabId);
  const handle = coverageSessions.get(key);
  if (!handle || handle.ws.readyState !== WebSocket.OPEN) {
    return { error: "no coverage session — call /coverage/start first" };
  }

  try {
    const jsResult = await coverageSend(handle, "Profiler.takePreciseCoverage");
    const cssResult = await coverageSend(handle, "CSS.stopRuleUsageTracking");

    const files: any[] = [];

    // JS coverage
    for (const script of (jsResult || [])) {
      let used = 0, total = 0;
      for (const fn of script.functions || []) {
        for (const range of fn.ranges || []) {
          const size = range.endOffset - range.startOffset;
          total += size;
          if (range.count > 0) used += size;
        }
      }
      if (total > 0) {
        files.push({ url: script.url || "(inline)", type: "js", used, total, pct: Math.round(used / total * 1000) / 10 + "%" });
      }
    }

    // CSS coverage
    const cssMap = new Map<string, { used: number; total: number }>();
    for (const rule of (cssResult?.ruleUsage || [])) {
      const k = rule.styleSheetId || "(inline)";
      const entry = cssMap.get(k) || { used: 0, total: 0 };
      const size = rule.endOffset - rule.startOffset;
      entry.total += size;
      if (rule.used) entry.used += size;
      cssMap.set(k, entry);
    }
    for (const [id, { used, total }] of cssMap) {
      files.push({ url: id, type: "css", used, total, pct: Math.round(used / total * 1000) / 10 + "%" });
    }

    files.sort((a, b) => (b.total - b.used) - (a.total - a.used));

    // Cleanup
    await coverageSend(handle, "Profiler.stopPreciseCoverage").catch(() => {});
    await coverageSend(handle, "Profiler.disable").catch(() => {});
    handle.ws.close();
    coverageSessions.delete(key);

    return { files };
  } catch (err: any) {
    handle.ws.close();
    coverageSessions.delete(key);
    return { error: err.message };
  }
}
