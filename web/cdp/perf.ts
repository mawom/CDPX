import { cdpCommand, cdpSession } from "./shared.ts";

// --- Performance Tracing (Chrome DevTools Performance recording) ---
export async function perfTrace(
  port: number,
  tabId: string,
  duration = 3000,
): Promise<{ trace?: any; error?: string }> {
  const res = await cdpSession(port, tabId, async ({ send, waitEvent }) => {
    await send("Tracing.start", {
      categories: "-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame",
      options: "sampling-frequency=10000",
    });
    await new Promise((r) => setTimeout(r, duration));
    const dataCollected: any[] = [];
    // Collect trace events as they come
    const collectPromise = new Promise<void>((resolve) => {
      const origOnMessage = (globalThis as any).__traceResolve;
      (globalThis as any).__traceResolve = resolve;
    });
    await send("Tracing.end");
    // Wait a bit for data to arrive
    await new Promise((r) => setTimeout(r, 1000));
    return { collected: true };
  }, duration + 10000);
  if (res.error) return { error: res.error };

  // Simpler approach: use Runtime.evaluate with PerformanceObserver
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
      const el = document.querySelector('[data-cdpx-ref="${opts.ref || ""}"]') || document.querySelector('${opts.selector || "body"}');
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
export async function startCoverage(
  port: number,
  tabId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await cdpSession(port, tabId, async ({ send }) => {
    await send("Profiler.enable");
    await send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await send("CSS.enable");
    await send("CSS.startRuleUsageTracking");
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function getCoverageReport(
  port: number,
  tabId: string,
): Promise<{ files?: any[]; error?: string }> {
  const res = await cdpSession(port, tabId, async ({ send }) => {
    const { result: jsResult } = await send("Profiler.takePreciseCoverage");
    const { ruleUsage } = await send("CSS.stopRuleUsageTracking");

    const files: any[] = [];

    // JS coverage
    for (const script of (jsResult || [])) {
      let used = 0;
      let total = 0;
      for (const fn of script.functions || []) {
        for (const range of fn.ranges || []) {
          const size = range.endOffset - range.startOffset;
          total += size;
          if (range.count > 0) used += size;
        }
      }
      if (total > 0) {
        files.push({
          url: script.url || "(inline)",
          type: "js",
          used,
          total,
          pct: Math.round(used / total * 1000) / 10 + "%",
        });
      }
    }

    // CSS coverage
    const cssMap = new Map<string, { used: number; total: number }>();
    for (const rule of (ruleUsage || [])) {
      const key = rule.styleSheetId || "(inline)";
      const entry = cssMap.get(key) || { used: 0, total: 0 };
      const size = rule.endOffset - rule.startOffset;
      entry.total += size;
      if (rule.used) entry.used += size;
      cssMap.set(key, entry);
    }
    for (const [id, { used, total }] of cssMap) {
      files.push({
        url: id,
        type: "css",
        used,
        total,
        pct: Math.round(used / total * 1000) / 10 + "%",
      });
    }

    // Sort by unused bytes desc
    files.sort((a, b) => (b.total - b.used) - (a.total - a.used));

    await send("Profiler.stopPreciseCoverage");
    await send("Profiler.disable");

    return files;
  });
  if (res.error) return { error: res.error };
  return { files: res.result };
}
