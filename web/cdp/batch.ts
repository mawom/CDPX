import type { RouteResult } from "./shared.ts";

// Will be set by index.ts to avoid circular dependency
let _handleBrowserRoute: (method: string, url: string, body: string) => Promise<RouteResult>;

export function setHandleRoute(fn: typeof _handleBrowserRoute): void {
  _handleBrowserRoute = fn;
}

const GET_ACTIONS = new Set(["status", "tabs", "screenshot", "content", "snapshot", "cookies", "extensions", "pdf", "form-state", "perf", "downloads", "html", "storage", "tab-by-name", "session/export", "network/requests", "network/response", "console/logs", "profile/list"]);

export async function executeBatch(
  steps: { action: string; params: Record<string, unknown> }[],
  portOverride: number,
  tabIdOverride?: string,
): Promise<{ results: { action: string; result: RouteResult }[]; error?: string }> {
  const results: { action: string; result: RouteResult }[] = [];
  for (const step of steps) {
    if (!step.action || typeof step.action !== "string") {
      results.push({ action: step.action || "unknown", result: { status: 400, error: "missing action" } });
      break;
    }
    const p = { port: portOverride, tabId: tabIdOverride, ...(step.params || {}) };
    const body = JSON.stringify(p);
    // Map action to route path
    const routePath = `/api/browser/${step.action}`;
    const httpMethod = GET_ACTIONS.has(step.action) ? "GET" : "POST";
    try {
      // Build query string from all params for GET routes
      let qs = "";
      if (httpMethod === "GET") {
        const params = new URLSearchParams();
        if (p.port) params.set("port", String(p.port));
        if (p.tabId) params.set("id", String(p.tabId));
        // Forward any extra params (selector, key, type, level, url, etc.)
        for (const [k, v] of Object.entries(step.params || {})) {
          if (k !== "port" && k !== "tabId" && v != null) params.set(k, String(v));
        }
        qs = "?" + params.toString();
      }
      const result = await _handleBrowserRoute(httpMethod, routePath + qs, body);
      results.push({ action: step.action, result });
      if (result.status && result.status >= 400) break; // stop on error
    } catch (err: any) {
      results.push({ action: step.action, result: { status: 500, error: err.message } });
      break;
    }
  }
  return { results };
}
