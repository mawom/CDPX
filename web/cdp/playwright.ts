// Playwright browserServer protocol adapter for CDPX
// Enables: playwright.chromium.connect("ws://host:port/pw/CHROME_PORT?token=xxx")

import type { ServerWebSocket } from "bun";
import { getTabs, closeTab, type Tab } from "./shared.ts";
import { createContext, openTabInContext, closeContext } from "./proxy.ts";
import { getCookies, setCookie, clearCookies } from "./storage.ts";

// ======================== Playwright value serialization ========================

function serialize(value: unknown): unknown {
  if (value === null) return { v: "null" };
  if (value === undefined) return { v: "undefined" };
  if (typeof value === "boolean") return { b: value };
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { v: "-0" };
    if (Number.isNaN(value)) return { v: "NaN" };
    if (value === Infinity) return { v: "Infinity" };
    if (value === -Infinity) return { v: "-Infinity" };
    return { n: value };
  }
  if (typeof value === "string") return { s: value };
  if (typeof value === "bigint") return { bi: String(value) };
  if (Array.isArray(value)) return { a: value.map(serialize) };
  if (typeof value === "object") {
    return { o: Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ k, v: serialize(v) })) };
  }
  return { v: "undefined" };
}

function deserialize(arg: any): any {
  if (arg == null) return undefined;
  if ("v" in arg) {
    const m: Record<string, any> = { null: null, undefined: undefined, NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 };
    return arg.v in m ? m[arg.v] : undefined;
  }
  if ("b" in arg) return arg.b;
  if ("n" in arg) return arg.n;
  if ("s" in arg) return arg.s;
  if ("bi" in arg) return BigInt(arg.bi);
  if ("a" in arg) return (arg.a as any[]).map(deserialize);
  if ("o" in arg) {
    const obj: Record<string, any> = {};
    for (const { k, v } of arg.o) obj[k] = deserialize(v);
    return obj;
  }
  return undefined;
}

// ======================== Persistent CDP connection ========================

class CdpConn {
  ws: WebSocket;
  nextId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  handlers = new Map<string, ((params: any) => void)[]>();
  ready: Promise<void>;
  closed = false;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP connection failed")); };
    });
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        const fns = this.handlers.get(msg.method);
        if (fns) for (const fn of fns) fn(msg.params);
      }
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP disconnected"));
      this.pending.clear();
    };
  }

  async send(method: string, params?: any): Promise<any> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: any) => void): void {
    let arr = this.handlers.get(event);
    if (!arr) {
      arr = [];
      this.handlers.set(event, arr);
    }
    arr.push(handler);
  }

  once(event: string, timeout = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Timeout ${timeout}ms waiting for ${event}`));
      }, timeout);
      const handler = (params: any) => {
        clearTimeout(timer);
        remove();
        resolve(params);
      };
      const remove = () => {
        const arr = this.handlers.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      };
      this.on(event, handler);
    });
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch {}
    for (const [, p] of this.pending) p.reject(new Error("closed"));
    this.pending.clear();
  }
}

// ======================== Key map (from action.ts) ========================

const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  space: { key: " ", code: "Space", keyCode: 32 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function mapKey(name: string) {
  return KEY_MAP[name.toLowerCase()] || { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.charCodeAt(0) };
}

// ======================== Object types ========================

interface PwObject {
  type: string;
  guid: string;
  tabId?: string;
  contextId?: string;
  parentContext?: string; // context guid that owns this page
  objectId?: string; // CDP remote object ID (ElementHandle)
}

// ======================== PlaywrightSession ========================

class PlaywrightSession {
  ws: ServerWebSocket<any>;
  port: number;
  objects = new Map<string, PwObject>();
  cdpConns = new Map<string, CdpConn>();
  contextCounter = 0;
  elementCounter = 0;

  constructor(ws: ServerWebSocket<any>, port: number) {
    this.ws = ws;
    this.port = port;
  }

  // --- Send helpers ---

  private msg(data: any): void {
    try { this.ws.send(JSON.stringify(data)); } catch {}
  }

  private create(parentGuid: string, type: string, guid: string, initializer: any): void {
    this.objects.set(guid, { type, guid });
    this.msg({ guid: parentGuid, method: "__create__", params: { type, guid, initializer } });
  }

  private dispose(guid: string): void {
    const obj = this.objects.get(guid);
    if (!obj) return;
    const parent = this.findParentGuid(guid);
    this.objects.delete(guid);
    this.msg({ guid: parent, method: "__dispose__", params: { guid } });
  }

  private reply(id: number, result: any): void {
    this.msg({ id, result });
  }

  private error(id: number, message: string, name = "Error"): void {
    this.msg({ id, error: { error: { name, message } } });
  }

  private findParentGuid(guid: string): string {
    const obj = this.objects.get(guid);
    if (!obj) return "";
    if (obj.type === "Page" || obj.type === "Frame") return obj.parentContext || "";
    if (obj.type === "BrowserContext") return "browser";
    return "";
  }

  // --- CDP connections ---

  private async getCdp(tabId: string): Promise<CdpConn> {
    let conn = this.cdpConns.get(tabId);
    if (conn && !conn.closed) return conn;
    // Clean up stale connection before creating new one
    if (conn) { conn.close(); this.cdpConns.delete(tabId); }
    const tabs = await getTabs(this.port);
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab?.webSocketDebuggerUrl) throw new Error("tab not found");
    conn = new CdpConn(tab.webSocketDebuggerUrl);
    await conn.ready;
    await Promise.all([conn.send("Page.enable"), conn.send("Runtime.enable"), conn.send("Network.enable")]);
    // Event forwarding — fresh handlers per connection (old conn is closed above)
    const frameGuid = `frame-${tabId}`;
    conn.on("Page.frameNavigated", (p) => {
      if (this.objects.has(frameGuid)) {
        this.msg({ guid: frameGuid, method: "navigated", params: { url: p.frame?.url || "", name: p.frame?.name || "", newDocument: null } });
      }
    });
    conn.on("Page.loadEventFired", () => {
      if (this.objects.has(frameGuid)) {
        this.msg({ guid: frameGuid, method: "loadstate", params: { add: "load" } });
      }
    });
    conn.on("Page.domContentEventFired", () => {
      if (this.objects.has(frameGuid)) {
        this.msg({ guid: frameGuid, method: "loadstate", params: { add: "domcontentloaded" } });
      }
    });
    this.cdpConns.set(tabId, conn);
    return conn;
  }

  private async getBrowserCdp(): Promise<CdpConn> {
    let conn = this.cdpConns.get("__browser__");
    if (conn && !conn.closed) return conn;
    const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
    conn = new CdpConn(webSocketDebuggerUrl);
    await conn.ready;
    this.cdpConns.set("__browser__", conn);
    return conn;
  }

  // --- Initialization ---

  async init(): Promise<void> {
    // Get browser version
    let version = "unknown";
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as { Browser?: string };
      version = data.Browser || "unknown";
    } catch {}

    // Children first, then parent
    this.create("", "Selectors", "selectors", {});
    this.create("", "Android", "android", {});
    this.create("", "Electron", "electron", {});
    this.create("", "LocalUtils", "utils", { deviceDescriptors: [] });
    this.create("", "BrowserType", "browser-type-chromium", { name: "chromium", executablePath: "" });
    this.create("", "BrowserType", "browser-type-firefox", { name: "firefox", executablePath: "" });
    this.create("", "BrowserType", "browser-type-webkit", { name: "webkit", executablePath: "" });
    this.create("", "Browser", "browser", { version, name: "chromium" });

    // Root Playwright object
    this.create("", "Playwright", "Playwright", {
      chromium: { guid: "browser-type-chromium" },
      firefox: { guid: "browser-type-firefox" },
      webkit: { guid: "browser-type-webkit" },
      android: { guid: "android" },
      electron: { guid: "electron" },
      utils: { guid: "utils" },
      selectors: { guid: "selectors" },
      preLaunchedBrowser: { guid: "browser" },
    });

    // Default context + existing tabs
    this.create("browser", "BrowserContext", "context-default", { isChromium: true });
    this.objects.set("context-default", { type: "BrowserContext", guid: "context-default", contextId: undefined });

    const tabs = await getTabs(this.port);
    for (const tab of tabs) {
      if (tab.type !== "page") continue;
      this.createPageObjects("context-default", tab.id, tab.url);
    }
  }

  private createPageObjects(contextGuid: string, tabId: string, url: string): void {
    const pageGuid = `page-${tabId}`;
    const frameGuid = `frame-${tabId}`;
    this.create(contextGuid, "Frame", frameGuid, {
      url, name: "", parentFrame: null, loadStates: ["load", "domcontentloaded"],
    });
    this.create(contextGuid, "Page", pageGuid, {
      mainFrame: { guid: frameGuid }, viewportSize: null, isClosed: false, opener: null,
    });
    this.objects.set(pageGuid, { type: "Page", guid: pageGuid, tabId, parentContext: contextGuid });
    this.objects.set(frameGuid, { type: "Frame", guid: frameGuid, tabId, parentContext: contextGuid });
  }

  // --- Find page in a context ---

  private findPageInContext(contextGuid: string): PwObject | undefined {
    for (const obj of this.objects.values()) {
      if (obj.type === "Page" && obj.parentContext === contextGuid && obj.tabId) return obj;
    }
    return undefined;
  }

  // --- Message routing ---

  async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, guid, method, params } = msg;
    if (id === undefined || !guid || !method) return;

    const obj = this.objects.get(guid);
    if (!obj) {
      this.error(id, `Object not found: ${guid}`);
      return;
    }

    try {
      switch (obj.type) {
        case "Browser":
          await this.handleBrowser(id, method, params);
          break;
        case "BrowserContext":
          await this.handleContext(id, guid, method, params);
          break;
        case "Page":
          await this.handlePage(id, guid, obj, method, params);
          break;
        case "Frame":
          await this.handleFrame(id, guid, obj, method, params);
          break;
        case "ElementHandle":
          await this.handleElement(id, guid, obj, method, params);
          break;
        default:
          // Stubs for BrowserType, Selectors, etc.
          this.reply(id, {});
      }
    } catch (e: any) {
      this.error(id, e.message || "unknown error");
    }
  }

  // --- Browser methods ---

  private async handleBrowser(id: number, method: string, params: any): Promise<void> {
    switch (method) {
      case "newContext": {
        const res = await createContext(this.port, { proxy: params?.proxy?.server });
        if (res.error || !res.contextId) throw new Error(res.error || "failed to create context");
        const guid = `context-${++this.contextCounter}`;
        this.create("browser", "BrowserContext", guid, { isChromium: true });
        this.objects.set(guid, { type: "BrowserContext", guid, contextId: res.contextId });
        this.reply(id, { context: { guid } });
        break;
      }
      case "close":
        this.reply(id, {});
        break;
      default:
        this.reply(id, {});
    }
  }

  // --- BrowserContext methods ---

  private async handleContext(id: number, guid: string, method: string, params: any): Promise<void> {
    const ctx = this.objects.get(guid)!;
    switch (method) {
      case "newPage": {
        if (ctx.contextId) {
          const res = await openTabInContext(this.port, ctx.contextId);
          if (res.error || !res.tab) throw new Error(res.error || "failed to open tab");
          this.createPageObjects(guid, res.tab.id, "about:blank");
          this.reply(id, { page: { guid: `page-${res.tab.id}` } });
        } else {
          // Default context — use regular tab open
          const tabs = await getTabs(this.port);
          const browser = await this.getBrowserCdp();
          const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
          this.createPageObjects(guid, targetId, "about:blank");
          this.reply(id, { page: { guid: `page-${targetId}` } });
        }
        break;
      }
      case "cookies": {
        const page = this.findPageInContext(guid);
        if (!page?.tabId) { this.reply(id, { cookies: [] }); break; }
        const res = await getCookies(this.port, page.tabId);
        this.reply(id, { cookies: res.cookies || [] });
        break;
      }
      case "addCookies": {
        const page = this.findPageInContext(guid);
        if (!page?.tabId) { this.reply(id, {}); break; }
        for (const cookie of params.cookies || []) {
          await setCookie(this.port, page.tabId, cookie);
        }
        this.reply(id, {});
        break;
      }
      case "clearCookies": {
        const page = this.findPageInContext(guid);
        if (!page?.tabId) { this.reply(id, {}); break; }
        await clearCookies(this.port, page.tabId);
        this.reply(id, {});
        break;
      }
      case "close": {
        // Clean up CDP connections for pages in this context
        for (const obj of [...this.objects.values()]) {
          if (obj.type === "Page" && obj.parentContext === guid && obj.tabId) {
            const conn = this.cdpConns.get(obj.tabId);
            if (conn) { conn.close(); this.cdpConns.delete(obj.tabId); }
            this.dispose(`frame-${obj.tabId}`);
            this.dispose(obj.guid);
          }
        }
        // Use closeContext to close tabs + dispose context
        if (ctx.contextId) {
          await closeContext(this.port, ctx.contextId);
        }
        this.dispose(guid);
        this.reply(id, {});
        break;
      }
      case "setDefaultNavigationTimeoutNoReply":
      case "setDefaultTimeoutNoReply":
        // Store locally, no reply for "NoReply" methods
        break;
      default:
        this.reply(id, {});
    }
  }

  // --- Page methods ---

  private async handlePage(id: number, guid: string, obj: PwObject, method: string, params: any): Promise<void> {
    const tabId = obj.tabId!;
    switch (method) {
      case "screenshot": {
        const cdp = await this.getCdp(tabId);
        const opts: any = { format: params?.type === "jpeg" ? "jpeg" : "png" };
        if (params?.quality) opts.quality = params.quality;
        if (params?.fullPage) {
          const metrics = await cdp.send("Page.getLayoutMetrics");
          const { width, height } = metrics.contentSize || metrics.cssContentSize;
          opts.clip = { x: 0, y: 0, width, height, scale: 1 };
        }
        const { data } = await cdp.send("Page.captureScreenshot", opts);
        this.reply(id, { binary: data });
        break;
      }
      case "close": {
        await closeTab(this.port, tabId);
        const conn = this.cdpConns.get(tabId);
        if (conn) { conn.close(); this.cdpConns.delete(tabId); }
        this.dispose(`frame-${tabId}`);
        this.dispose(guid);
        this.reply(id, {});
        break;
      }
      case "setViewportSize": {
        const cdp = await this.getCdp(tabId);
        const { width, height } = params.viewportSize;
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        this.reply(id, {});
        break;
      }
      case "reload": {
        const cdp = await this.getCdp(tabId);
        await cdp.send("Page.reload");
        await cdp.once("Page.loadEventFired", params?.timeout || 30000).catch(() => {});
        this.reply(id, {});
        break;
      }
      case "pdf": {
        const cdp = await this.getCdp(tabId);
        const { data } = await cdp.send("Page.printToPDF", {
          landscape: params?.landscape, printBackground: params?.printBackground ?? true,
          paperWidth: params?.width ? parseFloat(params.width) / 96 : undefined,
          paperHeight: params?.height ? parseFloat(params.height) / 96 : undefined,
        });
        this.reply(id, { pdf: data });
        break;
      }
      case "keyboardDown": {
        const cdp = await this.getCdp(tabId);
        const k = mapKey(params.key);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        this.reply(id, {});
        break;
      }
      case "keyboardUp": {
        const cdp = await this.getCdp(tabId);
        const k = mapKey(params.key);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        this.reply(id, {});
        break;
      }
      case "keyboardInsertText": {
        const cdp = await this.getCdp(tabId);
        await cdp.send("Input.insertText", { text: params.text });
        this.reply(id, {});
        break;
      }
      case "keyboardType": {
        const cdp = await this.getCdp(tabId);
        for (const char of params.text) {
          const k = mapKey(char);
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
          if (params.delay) await new Promise((r) => setTimeout(r, params.delay));
        }
        this.reply(id, {});
        break;
      }
      case "keyboardPress": {
        const cdp = await this.getCdp(tabId);
        const k = mapKey(params.key);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        this.reply(id, {});
        break;
      }
      case "mouseClick": {
        const cdp = await this.getCdp(tabId);
        const { x, y, button, clickCount, delay } = params;
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: button || "left", clickCount: clickCount || 1 });
        if (delay) await new Promise((r) => setTimeout(r, delay));
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: button || "left", clickCount: clickCount || 1 });
        this.reply(id, {});
        break;
      }
      case "mouseMove": {
        const cdp = await this.getCdp(tabId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: params.x, y: params.y });
        this.reply(id, {});
        break;
      }
      case "mouseDown": {
        const cdp = await this.getCdp(tabId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: params.x || 0, y: params.y || 0, button: params.button || "left", clickCount: 1 });
        this.reply(id, {});
        break;
      }
      case "mouseUp": {
        const cdp = await this.getCdp(tabId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: params.x || 0, y: params.y || 0, button: params.button || "left", clickCount: 1 });
        this.reply(id, {});
        break;
      }
      case "setDefaultNavigationTimeoutNoReply":
      case "setDefaultTimeoutNoReply":
        break;
      default:
        this.reply(id, {});
    }
  }

  // --- Frame methods ---

  private async handleFrame(id: number, guid: string, obj: PwObject, method: string, params: any): Promise<void> {
    const tabId = obj.tabId!;
    const cdp = await this.getCdp(tabId);
    switch (method) {
      case "goto": {
        const waitUntil = params.waitUntil || "load";
        const timeout = params.timeout || 30000;
        const { errorText } = await cdp.send("Page.navigate", { url: params.url }) as any;
        if (errorText) throw new Error(errorText);
        const event = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
        await cdp.once(event, timeout).catch(() => {});
        this.reply(id, { response: null });
        break;
      }
      case "content": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: "document.documentElement.outerHTML", returnByValue: true,
        });
        this.reply(id, { value: result.value });
        break;
      }
      case "title": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: "document.title", returnByValue: true,
        });
        this.reply(id, { value: result.value });
        break;
      }
      case "evaluateExpression":
      case "evaluateExpressionHandle": {
        let expr = params.expression;
        if (params.isFunction) {
          const arg = deserialize(params.arg?.value);
          expr = arg !== undefined ? `(${expr})(${JSON.stringify(arg)})` : `(${expr})()`;
        }
        const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
          expression: expr, returnByValue: true, awaitPromise: true,
        });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        this.reply(id, { value: serialize(result.value) });
        break;
      }
      case "click": {
        const pos = await this.resolveSelector(cdp, params.selector);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: params.button || "left", clickCount: params.clickCount || 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: params.button || "left", clickCount: params.clickCount || 1 });
        this.reply(id, {});
        break;
      }
      case "dblclick": {
        const pos = await this.resolveSelector(cdp, params.selector);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 2 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 2 });
        this.reply(id, {});
        break;
      }
      case "hover": {
        const pos = await this.resolveSelector(cdp, params.selector);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
        this.reply(id, {});
        break;
      }
      case "fill": {
        const sel = JSON.stringify(params.selector);
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector(${sel});
            if (!el) throw new Error('Element not found: ' + ${sel});
            el.focus();
            const p = Object.getPrototypeOf(el);
            const d = Object.getOwnPropertyDescriptor(p, 'value');
            if (d && d.set) { d.set.call(el, ''); } else { el.value = ''; }
            el.dispatchEvent(new Event('input', {bubbles: true}));
          })()`, awaitPromise: true,
        });
        await cdp.send("Input.insertText", { text: params.value });
        await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${sel})?.dispatchEvent(new Event('change', {bubbles: true}))`,
        });
        this.reply(id, {});
        break;
      }
      case "type": {
        const sel = JSON.stringify(params.selector);
        await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${sel})?.focus()`,
        });
        for (const char of params.text) {
          const k = mapKey(char);
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
          if (params.delay) await new Promise((r) => setTimeout(r, params.delay));
        }
        this.reply(id, {});
        break;
      }
      case "press": {
        if (params.selector) {
          await cdp.send("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(params.selector)})?.focus()`,
          });
        }
        const k = mapKey(params.key);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        this.reply(id, {});
        break;
      }
      case "selectOption": {
        const sel = JSON.stringify(params.selector);
        const values = params.options?.map((o: any) => o.value || o.label) || params.elements?.map((e: any) => e.value) || [];
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector(${sel});
            if (!el || el.tagName !== 'SELECT') throw new Error('Not a select element');
            const vals = ${JSON.stringify(values)};
            for (const opt of el.options) { opt.selected = vals.includes(opt.value) || vals.includes(opt.text); }
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            return [...el.selectedOptions].map(o => o.value);
          })()`, returnByValue: true, awaitPromise: true,
        });
        this.reply(id, { values: values });
        break;
      }
      case "setInputFiles": {
        // Minimal: set file path via CDP DOM.setFileInputFiles
        const { result: nodeResult } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})`,
        });
        if (nodeResult.objectId) {
          const { node } = await cdp.send("DOM.describeNode", { objectId: nodeResult.objectId });
          if (node?.backendNodeId) {
            const files = (params.localPaths || []) as string[];
            await cdp.send("DOM.setFileInputFiles", { files, backendNodeId: node.backendNodeId });
          }
        }
        this.reply(id, {});
        break;
      }
      case "waitForSelector": {
        const timeout = Math.min(Math.max(0, Number(params.timeout) || 30000), 300000);
        const state = params.state || "visible";
        const sel = JSON.stringify(params.selector);
        const check = state === "detached" || state === "hidden" ? `!document.querySelector(${sel})` : `document.querySelector(${sel})`;
        const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
          expression: `new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout ' + ${timeout} + 'ms waiting for selector')), ${timeout});
            const ck = () => { if (${check}) { clearTimeout(t); resolve(true); return true; } return false; };
            if (ck()) return;
            new MutationObserver((_, obs) => { if (ck()) obs.disconnect(); }).observe(document.body || document.documentElement, {childList:true,subtree:true,attributes:true});
          })`, returnByValue: true, awaitPromise: true,
        });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "timeout");
        this.reply(id, { element: null });
        break;
      }
      case "waitForFunction": {
        let expr = params.expression;
        if (params.isFunction) {
          const arg = deserialize(params.arg?.value);
          expr = arg !== undefined ? `(${expr})(${JSON.stringify(arg)})` : `(${expr})()`;
        }
        const timeout = params.timeout || 30000;
        const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
          expression: `new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout')), ${timeout});
            const ck = () => { const v = ${expr}; if (v) { clearTimeout(t); resolve(v); return true; } return false; };
            if (ck()) return;
            const i = setInterval(() => { if (ck()) clearInterval(i); }, 100);
          })`, returnByValue: true, awaitPromise: true,
        });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "timeout");
        this.reply(id, { value: serialize(result?.value) });
        break;
      }
      case "querySelector": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})`,
        });
        if (!result.objectId) {
          this.reply(id, { element: null });
          break;
        }
        const elGuid = `element-${++this.elementCounter}`;
        this.create(guid, "ElementHandle", elGuid, { preview: params.selector });
        this.objects.set(elGuid, { type: "ElementHandle", guid: elGuid, tabId, objectId: result.objectId });
        this.reply(id, { element: { guid: elGuid } });
        break;
      }
      case "focus": {
        await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})?.focus()`,
        });
        this.reply(id, {});
        break;
      }
      case "textContent": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})?.textContent`,
          returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "innerText": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})?.innerText`,
          returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "innerHTML": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})?.innerHTML`,
          returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "getAttribute": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(params.selector)})?.getAttribute(${JSON.stringify(params.name)})`,
          returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "isVisible": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'; })()`,
          returnByValue: true,
        });
        this.reply(id, { value: !!result.value });
        break;
      }
      case "isHidden": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return true; const s = getComputedStyle(el); return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0'; })()`,
          returnByValue: true,
        });
        this.reply(id, { value: !!result.value });
        break;
      }
      case "isEnabled": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `!document.querySelector(${JSON.stringify(params.selector)})?.disabled`,
          returnByValue: true,
        });
        this.reply(id, { value: !!result.value });
        break;
      }
      case "isChecked": {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `!!document.querySelector(${JSON.stringify(params.selector)})?.checked`,
          returnByValue: true,
        });
        this.reply(id, { value: !!result.value });
        break;
      }
      case "setContent": {
        await cdp.send("Runtime.evaluate", {
          expression: `document.documentElement.innerHTML = ${JSON.stringify(params.html)}`,
        });
        this.reply(id, {});
        break;
      }
      default:
        this.reply(id, {});
    }
  }

  // --- ElementHandle methods ---

  private async handleElement(id: number, guid: string, obj: PwObject, method: string, params: any): Promise<void> {
    if (!obj.tabId || !obj.objectId) { this.error(id, "stale element"); return; }
    const cdp = await this.getCdp(obj.tabId);
    switch (method) {
      case "click": {
        const { result } = await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: "function(){this.scrollIntoView({block:'center'});const r=this.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}",
          returnByValue: true,
        });
        const { x, y } = result.value;
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        this.reply(id, {});
        break;
      }
      case "fill": {
        await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: "function(){this.focus();const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this),'value');if(d&&d.set){d.set.call(this,'')}else{this.value=''}this.dispatchEvent(new Event('input',{bubbles:true}))}",
        });
        await cdp.send("Input.insertText", { text: params.value });
        await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: "function(){this.dispatchEvent(new Event('change',{bubbles:true}))}",
        });
        this.reply(id, {});
        break;
      }
      case "textContent": {
        const { result } = await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: "function(){return this.textContent}", returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "getAttribute": {
        const { result } = await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: `function(){return this.getAttribute(${JSON.stringify(params.name)})}`, returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "innerHTML": {
        const { result } = await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: "function(){return this.innerHTML}", returnByValue: true,
        });
        this.reply(id, { value: result.value ?? null });
        break;
      }
      case "isVisible": {
        const { result } = await cdp.send("Runtime.callFunctionOn", {
          objectId: obj.objectId, functionDeclaration: "function(){const s=getComputedStyle(this);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'}", returnByValue: true,
        });
        this.reply(id, { value: !!result.value });
        break;
      }
      case "dispose": {
        try { await cdp.send("Runtime.releaseObject", { objectId: obj.objectId }); } catch {}
        this.objects.delete(guid);
        this.reply(id, {});
        break;
      }
      default:
        this.reply(id, {});
    }
  }

  // --- Selector resolution ---

  private async resolveSelector(cdp: CdpConn, selector: string): Promise<{ x: number; y: number }> {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
        el.scrollIntoView({block:'center',inline:'center'});
        const r = el.getBoundingClientRect();
        return {x: r.x + r.width/2, y: r.y + r.height/2};
      })()`, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "selector failed");
    return result.value;
  }

  // --- Cleanup ---

  cleanup(): void {
    for (const conn of this.cdpConns.values()) conn.close();
    this.cdpConns.clear();
    this.objects.clear();
  }
}

// ======================== Module exports ========================

const sessions = new Map<ServerWebSocket<any>, PlaywrightSession>();

export function pwOpen(ws: ServerWebSocket<any>, port: number): void {
  const session = new PlaywrightSession(ws, port);
  sessions.set(ws, session);
  session.init().catch((e) => {
    try { ws.close(); } catch {}
  });
}

export function pwMessage(ws: ServerWebSocket<any>, msg: string | Buffer): void {
  const session = sessions.get(ws);
  if (session) session.handleMessage(String(msg)).catch(() => {});
}

export function pwClose(ws: ServerWebSocket<any>): void {
  const session = sessions.get(ws);
  if (session) {
    session.cleanup();
    sessions.delete(ws);
  }
}
