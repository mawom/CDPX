#!/usr/bin/env bun
/**
 * CDPX MCP Server — Model Context Protocol over stdio
 * Zero dependencies. Wraps the CDPX HTTP API as MCP tools.
 *
 * Usage:
 *   Add to Claude Code / Cursor MCP config:
 *   { "command": "bun", "args": ["path/to/cdpx/web/mcp.ts"] }
 */

import fs from "node:fs";
import path from "node:path";

const CDPX_BASE = process.env.CDPX_URL || process.env.SYNAPSE_URL || "http://127.0.0.1:1024";

// Read token for API authentication
const TOKEN = (() => {
  if (process.env.CDPX_TOKEN || process.env.SYNAPSE_TOKEN) return (process.env.CDPX_TOKEN || process.env.SYNAPSE_TOKEN)!;
  try {
    return fs.readFileSync(path.resolve(import.meta.dirname!, "..", ".token"), "utf-8").trim();
  } catch { return ""; }
})();
const authQuery = TOKEN ? `token=${encodeURIComponent(TOKEN)}` : "";

// ─── MCP Tool Definitions ────────────────────────────

const TOOLS = [
  {
    name: "browser_status",
    description: "Get running browser instances",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_start",
    description: "Start a browser instance",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Debug port (default 9222)" },
        proxy: { type: "string", description: "Proxy URL" },
        headless: { type: "boolean" },
        stealth: { type: "boolean", description: "Anti-detection (default true)" },
        fingerprint: { type: "string", description: "Fingerprint profile: 'random' for randomized UA+viewport" },
      },
    },
  },
  {
    name: "browser_connect",
    description: "Connect to an already-running Chrome/Chromium",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" } },
      required: ["port"],
    },
  },
  {
    name: "browser_stop",
    description: "Stop a browser instance",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" } },
      required: ["port"],
    },
  },
  {
    name: "browser_tabs",
    description: "List open tabs",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" } },
      required: ["port"],
    },
  },
  {
    name: "browser_open",
    description: "Open a new tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        url: { type: "string" },
        proxy: { type: "string", description: "Per-tab proxy" },
      },
      required: ["port"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Get interactive element tree with [ref=N] IDs + optional page content as Markdown",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        content: { type: "boolean", description: "Include Markdown content" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_content",
    description: "Get page content as Markdown with page state",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" }, tabId: { type: "string" } },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot (base64 JPEG)",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" }, tabId: { type: "string" } },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_click",
    description: "Click an element by ref (from snapshot), CSS selector, or x/y coordinates",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        ref: { type: "number" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into an element",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        ref: { type: "number" },
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean" },
        humanLike: { type: "boolean", description: "Type per-character with random delays" },
        delayMs: { type: "number", description: "Per-character delay in ms for humanLike typing (default 80)" },
      },
      required: ["port", "tabId", "text"],
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate to a URL and wait for page load",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        url: { type: "string" },
      },
      required: ["port", "tabId", "url"],
    },
  },
  {
    name: "browser_eval",
    description: "Execute JavaScript (supports await)",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        expression: { type: "string" },
      },
      required: ["port", "tabId", "expression"],
    },
  },
  {
    name: "browser_wait",
    description: "Wait for element, condition, or delay",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        selector: { type: "string" },
        condition: { type: "string", description: "url-contains:x, text-appears:x, element-gone:x, tab-with-url:x" },
        timeout: { type: "number" },
      },
      required: ["port"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll to element or by pixels",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        ref: { type: "number" },
        y: { type: "number" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_fetch",
    description: "Make an authenticated HTTP request using the browser's cookies",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
      },
      required: ["port", "tabId", "url"],
    },
  },
  {
    name: "browser_context_create",
    description: "Create a new browser context (incognito-like isolation)",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        proxy: { type: "string", description: "Proxy URL for this context" },
      },
      required: ["port"],
    },
  },
  {
    name: "browser_context_close",
    description: "Close a browser context",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        contextId: { type: "string" },
      },
      required: ["port", "contextId"],
    },
  },
  {
    name: "browser_cookies",
    description: "Get cookies for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_set_cookie",
    description: "Set a cookie on a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
        domain: { type: "string" },
      },
      required: ["port", "tabId", "name", "value", "domain"],
    },
  },
  {
    name: "browser_clear_cookies",
    description: "Clear all cookies for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_network_enable",
    description: "Enable network request monitoring for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_network_requests",
    description: "Get captured network requests for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_console_enable",
    description: "Enable console log capture for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_console_logs",
    description: "Get captured console logs for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
      },
      required: ["port", "tabId"],
    },
  },
  {
    name: "browser_keypress",
    description: "Press a keyboard key (Enter, Tab, Escape, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        key: { type: "string", description: "Key name (Enter, Tab, Escape, ArrowDown, etc.)" },
      },
      required: ["port", "tabId", "key"],
    },
  },
  {
    name: "browser_upload",
    description: "Upload a file to an input element",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        ref: { type: "number", description: "Element ref from snapshot" },
        selector: { type: "string", description: "CSS selector" },
        path: { type: "string", description: "Absolute file path to upload" },
      },
      required: ["port", "tabId", "path"],
    },
  },
  {
    name: "browser_set_geolocation",
    description: "Override geolocation for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
      required: ["port", "tabId", "latitude", "longitude"],
    },
  },
  {
    name: "browser_set_offline",
    description: "Toggle offline mode for a tab",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        offline: { type: "boolean" },
      },
      required: ["port", "tabId", "offline"],
    },
  },
  {
    name: "browser_dialog",
    description: "Accept or dismiss a JavaScript dialog (alert/confirm/prompt)",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        accept: { type: "boolean", description: "true to accept, false to dismiss" },
      },
      required: ["port", "tabId", "accept"],
    },
  },
  {
    name: "browser_fill_form",
    description: "Fill multiple form fields at once",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number" },
        tabId: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "number", description: "Element ref from snapshot" },
              selector: { type: "string", description: "CSS selector (alternative to ref)" },
              value: { type: "string" },
              checked: { type: "boolean", description: "For checkboxes/radios" },
            },
            required: ["value"],
          },
          description: "Array of {ref, value} pairs",
        },
      },
      required: ["port", "tabId", "fields"],
    },
  },
];

// ─── Tool → HTTP API mapping ─────────────────────────

const TOOL_MAP: Record<string, { method: string; path: string | ((args: any) => string) }> = {
  browser_status:     { method: "GET",  path: "/status" },
  browser_start:      { method: "POST", path: "/start" },
  browser_connect:    { method: "POST", path: "/connect" },
  browser_stop:       { method: "POST", path: "/stop" },
  browser_tabs:       { method: "GET",  path: (a) => `/tabs?port=${a.port}` },
  browser_open:       { method: "POST", path: "/open" },
  browser_snapshot:   { method: "GET",  path: (a) => `/snapshot?port=${a.port}&id=${a.tabId}${a.content ? "&content=1" : ""}` },
  browser_content:    { method: "GET",  path: (a) => `/content?port=${a.port}&id=${a.tabId}` },
  browser_screenshot: { method: "GET",  path: (a) => `/screenshot?port=${a.port}&id=${a.tabId}` },
  browser_click:      { method: "POST", path: "/click" },
  browser_type:       { method: "POST", path: "/type" },
  browser_navigate:   { method: "POST", path: "/navigate" },
  browser_eval:       { method: "POST", path: "/eval" },
  browser_wait:       { method: "POST", path: "/wait" },
  browser_scroll:     { method: "POST", path: "/scroll" },
  browser_fetch:      { method: "POST", path: "/fetch" },
  browser_context_create:  { method: "POST", path: "/context/create" },
  browser_context_close:   { method: "POST", path: "/context/close" },
  browser_cookies:         { method: "GET",  path: (a) => `/cookies?port=${a.port}&id=${a.tabId}` },
  browser_set_cookie:      { method: "POST", path: "/set-cookie" },
  browser_clear_cookies:   { method: "POST", path: "/clear-cookies" },
  browser_network_enable:  { method: "POST", path: "/network/enable" },
  browser_network_requests:{ method: "GET",  path: (a) => `/network/requests?port=${a.port}&id=${a.tabId}${a.url ? "&url=" + encodeURIComponent(a.url) : ""}${a.method ? "&method=" + a.method : ""}${a.type ? "&type=" + a.type : ""}` },
  browser_console_enable:  { method: "POST", path: "/console/enable" },
  browser_console_logs:    { method: "GET",  path: (a) => `/console/logs?port=${a.port}&id=${a.tabId}` },
  browser_keypress:        { method: "POST", path: "/keypress" },
  browser_upload:          { method: "POST", path: "/upload" },
  browser_set_geolocation: { method: "POST", path: "/set-geolocation" },
  browser_set_offline:     { method: "POST", path: "/set-offline" },
  browser_dialog:          { method: "POST", path: "/dismiss-dialog" },
  browser_fill_form:       { method: "POST", path: "/fill-form" },
};

async function callTool(name: string, args: Record<string, any>): Promise<any> {
  const spec = TOOL_MAP[name];
  if (!spec) return { error: `unknown tool: ${name}` };

  const urlPath = typeof spec.path === "function" ? spec.path(args) : spec.path;
  const sep = urlPath.includes("?") ? "&" : "?";
  const url = `${CDPX_BASE}/api/browser${urlPath}${authQuery ? sep + authQuery : ""}`;

  // Transform args for start (port → ports array)
  if (name === "browser_start") {
    args = { ...args, ports: [args.port || 9222] };
    delete args.port;
  }

  // Dynamic timeout: navigate/wait/eval can take longer
  const userTimeout = (args.timeout as number) || 0;
  const fetchTimeout = Math.max(30000, userTimeout + 15000);

  const fetchOpts: RequestInit = spec.method === "GET"
    ? {}
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      };
  const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(fetchTimeout) });
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (!res.ok) return { error: json.error || `server returned ${res.status}`, status: res.status };
    return json;
  } catch {
    return { error: `server returned non-JSON (${res.status}): ${text.slice(0, 200)}` };
  }
}

// ─── MCP JSON-RPC Protocol (stdio) ──────────────────

function send(msg: any): void {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

function handleRequest(msg: any): any {
  const { method, id, params } = msg;

  // Notifications (no id) must not receive a response
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cdpx", version: "0.1.0" },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0", id,
      result: { tools: TOOLS },
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    if (!toolName || typeof toolName !== "string") {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: missing tool name" } };
    }
    const toolArgs = params?.arguments || {};
    // Return a promise — handled async
    return callTool(toolName, toolArgs).then((result) => ({
      jsonrpc: "2.0", id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
    })).catch((err: any) => ({
      jsonrpc: "2.0", id,
      result: {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      },
    }));
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

// ─── stdio reader (byte-accurate for Content-Length) ─

let buffer = Buffer.alloc(0);
const SEP = Buffer.from("\r\n\r\n");
let processing = false;
const pendingChunks: Buffer[] = [];

async function processBuffer(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      // Drain any pending chunks into the buffer
      while (pendingChunks.length > 0) {
        buffer = Buffer.concat([buffer, pendingChunks.shift()!]);
      }

      const headerEnd = buffer.indexOf(SEP);
      if (headerEnd === -1) break;

      const header = buffer.subarray(0, headerEnd).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }

      const contentLength = parseInt(match[1], 10);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 10_000_000) break;
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString();
      buffer = buffer.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        const response = handleRequest(msg);
        if (response === null) continue;
        if (response instanceof Promise) {
          send(await response);
        } else {
          send(response);
        }
      } catch (err: any) {
        // Send parse error for malformed JSON
        try {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        } catch {}
      }
    }
  } finally {
    processing = false;
    if (pendingChunks.length > 0) processBuffer();
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  pendingChunks.push(chunk);
  processBuffer();
});

process.stderr.write("CDPX MCP server ready\n");
