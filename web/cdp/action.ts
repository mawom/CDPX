import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  cdpCommand, cdpSession, refOrSelectorExpr, invalidateTabCache, getTabs, sanitizeExtName,
} from "./shared.ts";

export async function clickElement(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string },
): Promise<{ ok: boolean; error?: string }> {
  const expr = refOrSelectorExpr(opts.ref, opts.selector);
  const res = await cdpSession(port, tabId, async ({ send }) => {
    // Scroll into view first, then get position
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
      returnByValue: true,
    });
    const pos = result?.value;
    if (!pos) throw new Error("element not found");

    // Move mouse to element first (mimics real user behavior)
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: pos.x, y: pos.y,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1,
    });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function typeText(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string; text: string; clear?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const expr = refOrSelectorExpr(opts.ref, opts.selector);
  const res = await cdpSession(port, tabId, async ({ send }) => {
    // Focus the element
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (!el) return false; el.focus(); return true; })()`,
      returnByValue: true,
    });
    if (!result?.value) throw new Error("element not found");

    // Clear existing content if requested (trigger input event for React)
    if (opts.clear) {
      await send("Runtime.evaluate", {
        expression: `(() => { const el = ${expr}; if (!el) return; const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; if (nativeSet) nativeSet.call(el, ''); else el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      });
    }

    // Insert text
    await send("Input.insertText", { text: opts.text });
    // Dispatch change event (some frameworks only commit on change, not input)
    await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (el) el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function typeHuman(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string; text: string; delayMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  const expr = refOrSelectorExpr(opts.ref, opts.selector);
  const baseDelay = opts.delayMs ?? 80;
  // Dynamic timeout: base 5s + 200ms per character (covers jitter)
  const sessionTimeout = 5000 + opts.text.length * (baseDelay * 2);
  const res = await cdpSession(port, tabId, async ({ send }) => {
    // Focus
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (!el) return false; el.focus(); return true; })()`,
      returnByValue: true,
    });
    if (!result?.value) throw new Error("element not found");

    // Type character by character
    const charCode = (c: string): string => {
      if (c === " ") return "Space";
      if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) return `Key${c.toUpperCase()}`;
      if (c >= "0" && c <= "9") return `Digit${c}`;
      return "";
    };
    for (const char of opts.text) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown", text: char, key: char,
        code: charCode(char),
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp", key: char,
        code: charCode(char),
      });
      // Random delay: 60%-140% of baseDelay
      const jitter = baseDelay * (0.6 + Math.random() * 0.8);
      await new Promise((r) => setTimeout(r, jitter));
    }
    // Dispatch change event after finishing
    await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (el) el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    });
    return true;
  }, sessionTimeout);
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function scrollPage(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string; x?: number; y?: number },
): Promise<{ ok: boolean; error?: string }> {
  let expression: string;
  if (opts.ref != null || opts.selector) {
    const expr = refOrSelectorExpr(opts.ref, opts.selector);
    expression = `(() => { const el = ${expr}; if (!el) return false; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; })()`;
  } else {
    const x = Number(opts.x) || 0;
    const y = Number(opts.y) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "invalid x/y" };
    expression = `(() => { window.scrollBy(${x}, ${y}); return true; })()`;
  }
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  if (!(res.result as any)?.result?.value) return { ok: false, error: "element not found" };
  return { ok: true };
}

export async function navigateTo(
  port: number,
  tabId: string,
  url: string,
  timeoutMs = 15000,
): Promise<{ url?: string; error?: string }> {
  invalidateTabCache(port);
  const res = await cdpSession(port, tabId, async ({ send, waitEvent }) => {
    await send("Page.enable");
    // Race: loadEventFired (full page) vs frameNavigated (SPA) — whichever fires first
    const loadOrNav = Promise.race([
      waitEvent("Page.loadEventFired", timeoutMs).catch(() => {}),
      waitEvent("Page.frameNavigated", timeoutMs).catch(() => {}),
    ]);
    const nav = await send("Page.navigate", { url });
    if (nav.errorText) throw new Error(nav.errorText);
    await loadOrNav;
    // Brief wait for SPA content to settle
    await new Promise((r) => setTimeout(r, 300));
    const { result } = await send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    return { url: result?.value || url };
  }, timeoutMs + 5000);
  if (res.error) return { error: res.error };
  return res.result;
}

export const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
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
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 },
  f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 },
  f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 },
};

export async function pressKey(
  port: number,
  tabId: string,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const mapped = KEY_MAP[key.toLowerCase()] || { key, code: `Key${key.toUpperCase()}`, keyCode: key.charCodeAt(0) };
  const res = await cdpSession(port, tabId, async ({ send }) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown", key: mapped.key, code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", key: mapped.key, code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
    });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function hoverElement(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string },
): Promise<{ ok: boolean; error?: string }> {
  const expr = refOrSelectorExpr(opts.ref, opts.selector);
  const res = await cdpSession(port, tabId, async ({ send }) => {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
      returnByValue: true,
    });
    const pos = result?.value;
    if (!pos) throw new Error("element not found");
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: pos.x, y: pos.y,
    });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function mouseMove(
  port: number,
  tabId: string,
  pathPoints: number[][],
  duration: number,
): Promise<{ ok: boolean; error?: string }> {
  if (pathPoints.length < 2) return { ok: false, error: "path needs at least 2 points" };
  const res = await cdpSession(port, tabId, async ({ send }) => {
    const stepDelay = duration / (pathPoints.length - 1);
    for (const [x, y] of pathPoints) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await new Promise((r) => setTimeout(r, stepDelay));
    }
    return true;
  }, duration + 5000);
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

// Drag and drop — press at start, move along path, release at end
export async function drag(
  port: number,
  tabId: string,
  opts: { from: { x: number; y: number }; to: { x: number; y: number }; steps?: number; duration?: number },
): Promise<{ ok: boolean; error?: string }> {
  const steps = opts.steps ?? 20;
  const duration = opts.duration ?? 500;
  const stepDelay = duration / steps;
  const res = await cdpSession(port, tabId, async ({ send }) => {
    // Move to start position
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: opts.from.x, y: opts.from.y });
    await new Promise((r) => setTimeout(r, 50));
    // Press
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: opts.from.x, y: opts.from.y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 50));
    // Move along path (linear interpolation)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = opts.from.x + (opts.to.x - opts.from.x) * t;
      const y = opts.from.y + (opts.to.y - opts.from.y) * t;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
      await new Promise((r) => setTimeout(r, stepDelay));
    }
    // Release
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: opts.to.x, y: opts.to.y, button: "left", clickCount: 1 });
    return true;
  }, duration + 5000);
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function waitFor(
  port: number,
  tabId: string,
  opts: { selector?: string; timeout?: number },
): Promise<{ ok: boolean; error?: string }> {
  const timeout = opts.timeout ?? 5000;
  if (!opts.selector) {
    // Just wait for timeout ms
    await new Promise((r) => setTimeout(r, timeout));
    return { ok: true };
  }
  const sel = JSON.stringify(opts.selector);
  const res = await cdpSession(port, tabId, async ({ send }) => {
    const { result } = await send("Runtime.evaluate", {
      expression: `new Promise((resolve) => { const check = () => { if (document.querySelector(${sel})) { ob.disconnect(); return resolve(true); } }; const ob = new MutationObserver(check); check(); ob.observe(document.body, { childList: true, subtree: true }); setTimeout(() => { ob.disconnect(); resolve(false); }, ${timeout}); })`,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.value;
  }, timeout + 5000);
  if (res.error) return { ok: false, error: res.error };
  return res.result ? { ok: true } : { ok: false, error: "timeout waiting for selector" };
}

export async function waitForCondition(
  port: number,
  tabId: string | undefined,
  condition: string,
  timeout = 10000,
): Promise<{ ok: boolean; tabId?: string; error?: string }> {
  const [type, ...rest] = condition.split(":");
  const param = rest.join(":");
  const deadline = Date.now() + timeout;

  if (type === "tab-with-url") {
    // Poll for a tab matching URL pattern (e.g. chrome-extension://)
    while (Date.now() < deadline) {
      invalidateTabCache(port ? port : undefined);
      if (port) {
        const tabs = await getTabs(port);
        const match = tabs.find((t) => t.url.includes(param));
        if (match) return { ok: true, tabId: match.id };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, error: "timeout waiting for tab" };
  }

  // Remaining conditions need tabId
  if (!tabId) return { ok: false, error: "tabId required for this condition" };

  if (type === "url-contains") {
    const expr = `new Promise(r => { let done = false; const check = () => { if (done) return; if (location.href.includes(${JSON.stringify(param)})) { done = true; r(true); } else { setTimeout(check, 200); } }; check(); setTimeout(() => { if (!done) { done = true; r(false); } }, ${timeout}); })`;
    const res = await cdpSession(port!, tabId, async ({ send }) => {
      const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      return result?.value;
    }, timeout + 5000);
    if (res.error) return { ok: false, error: res.error };
    return res.result ? { ok: true } : { ok: false, error: "timeout" };
  }

  if (type === "text-appears") {
    const sel = JSON.stringify(param);
    const expr = `new Promise(r => { const check = () => { if (document.body.innerText.includes(${sel})) { ob.disconnect(); return r(true); } }; const ob = new MutationObserver(check); check(); ob.observe(document.body, { childList: true, subtree: true, characterData: true }); setTimeout(() => { ob.disconnect(); r(false); }, ${timeout}); })`;
    const res = await cdpSession(port!, tabId, async ({ send }) => {
      const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      return result?.value;
    }, timeout + 5000);
    if (res.error) return { ok: false, error: res.error };
    return res.result ? { ok: true } : { ok: false, error: "timeout" };
  }

  if (type === "element-gone") {
    const expr = `new Promise(r => { const check = () => { if (!document.querySelector(${JSON.stringify(param)})) { ob.disconnect(); return r(true); } }; const ob = new MutationObserver(check); check(); ob.observe(document.body, { childList: true, subtree: true }); setTimeout(() => { ob.disconnect(); r(false); }, ${timeout}); })`;
    const res = await cdpSession(port!, tabId, async ({ send }) => {
      const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      return result?.value;
    }, timeout + 5000);
    if (res.error) return { ok: false, error: res.error };
    return res.result ? { ok: true } : { ok: false, error: "timeout" };
  }

  return { ok: false, error: `unknown condition type: ${type}` };
}

export async function selectOption(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string; value: string },
): Promise<{ ok: boolean; error?: string }> {
  const expr = refOrSelectorExpr(opts.ref, opts.selector);
  const val = JSON.stringify(opts.value);
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `(() => { const el = ${expr}; if (!el || el.tagName !== 'SELECT') return false; el.value = ${val}; if (el.value !== ${val}) return false; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    returnByValue: true,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  if (!(res.result as any)?.result?.value) return { ok: false, error: "select element not found" };
  return { ok: true };
}

export async function dismissDialog(
  port: number,
  tabId: string,
  opts: { accept?: boolean; text?: string },
): Promise<{ ok: boolean; error?: string }> {
  // Enable Page domain first so we can handle dialogs, then dismiss any current one
  const res = await cdpSession(port, tabId, async ({ send }) => {
    await send("Page.enable");
    await send("Page.handleJavaScriptDialog", {
      accept: opts.accept !== false,
      promptText: opts.text || "",
    });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

// Auto-dismiss dialogs on a tab (enable event listener)
export async function autoHandleDialogs(
  port: number,
  tabId: string,
  accept = true,
): Promise<{ ok: boolean; error?: string }> {
  const script = `(() => {
    window.alert = () => {};
    window.confirm = () => ${accept ? "true" : "false"};
    window.prompt = () => ${accept ? "''" : "null"};
  })()`;
  const res = await cdpSession(port, tabId, async ({ send }) => {
    await send("Page.enable");
    // Persist across navigations
    await send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    // Also run immediately on current page
    await send("Runtime.evaluate", { expression: script });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function uploadFile(
  port: number,
  tabId: string,
  opts: { ref?: number; selector?: string; files?: string[]; base64?: string; filename?: string },
): Promise<{ ok: boolean; error?: string }> {
  // If base64 provided, write to temp file first
  let tempFile: string | null = null;
  let filePaths = opts.files || [];

  if (opts.base64) {
    // Limit base64 to ~15MB decoded (20MB base64 string)
    if (opts.base64.length > 20 * 1024 * 1024) {
      return { ok: false, error: "base64 too large (max 15MB)" };
    }
    const fname = sanitizeExtName(opts.filename || `upload-${Date.now()}.bin`);
    tempFile = path.join(os.tmpdir(), `cdpx-upload-${fname}`);
    fs.writeFileSync(tempFile, Buffer.from(opts.base64, "base64"));
    filePaths = [tempFile];
  }

  // Verify all file paths exist
  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) return { ok: false, error: `file not found: ${fp}` };
  }

  const expr = refOrSelectorExpr(opts.ref, opts.selector);
  const res = await cdpSession(port, tabId, async ({ send }) => {
    await send("DOM.getDocument");

    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (!el || el.tagName !== 'INPUT' || el.type !== 'file') return null; return el; })()`,
    });
    if (!result?.objectId) throw new Error("file input not found");

    const { nodeId } = await send("DOM.requestNode", { objectId: result.objectId });
    if (!nodeId) throw new Error("could not resolve DOM node");

    await send("DOM.setFileInputFiles", { nodeId, files: filePaths });
    return true;
  });

  // Clean up temp file after a delay (give browser time to read it)
  if (tempFile) {
    const f = tempFile;
    setTimeout(() => { try { fs.unlinkSync(f); } catch {} }, 5000);
  }

  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

export async function fillForm(
  port: number,
  tabId: string,
  fields: { ref?: number; selector?: string; value: string; checked?: boolean }[],
): Promise<{ ok: boolean; filled: number; error?: string }> {
  let filled = 0;
  for (const field of fields) {
    // For checkbox/radio: click to toggle if current state doesn't match desired
    if (field.checked !== undefined) {
      const expr = refOrSelectorExpr(field.ref, field.selector);
      const checkRes = await cdpCommand(port, tabId, "Runtime.evaluate", {
        expression: `(() => { const el = ${expr}; if (!el) return null; if (el.checked !== ${field.checked}) el.click(); return true; })()`,
        returnByValue: true,
      });
      if (checkRes.error || !(checkRes.result as any)?.result?.value) {
        return { ok: false, filled, error: `field ${filled}: checkbox/radio not found` };
      }
      filled++;
      continue;
    }
    // Try as select first (auto-detect by tagName), fall back to type
    {
      const expr = refOrSelectorExpr(field.ref, field.selector);
      const selRes = await cdpCommand(port, tabId, "Runtime.evaluate", {
        expression: `(() => { const el = ${expr}; if (el?.tagName === 'SELECT') { el.value = ${JSON.stringify(field.value)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'select'; } return 'text'; })()`,
        returnByValue: true,
      });
      if ((selRes.result as any)?.result?.value === 'select') { filled++; continue; }
    }
    // For text inputs
    const res = await typeText(port, tabId, {
      ref: field.ref,
      selector: field.selector,
      text: field.value,
      clear: true,
    });
    if (res.ok) filled++;
    else return { ok: false, filled, error: `field ${filled}: ${res.error}` };
  }
  return { ok: true, filled };
}

export async function setViewport(
  port: number,
  tabId: string,
  width: number,
  height: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await cdpCommand(port, tabId, "Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 0, mobile: false,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  return { ok: true };
}

export async function evalScript(
  port: number,
  tabId: string,
  expression: string,
  timeoutMs = 30000,
): Promise<{ value?: any; error?: string }> {
  const res = await cdpSession(port, tabId, async ({ send }) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) return { error: exceptionDetails.exception?.description || exceptionDetails.text };
    if (result?.subtype === "error") return { error: result.description || result.value };
    return { value: result?.value };
  }, timeoutMs);
  if (res.error) return { error: res.error };
  return res.result;
}

export async function authFetch(
  port: number,
  tabId: string,
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status?: number; headers?: Record<string, string>; body?: string; error?: string }> {
  const fetchOpts = JSON.stringify({
    method: opts?.method || "GET",
    headers: opts?.headers || {},
    body: opts?.body,
    credentials: "include",
  });
  const res = await cdpSession(port, tabId, async ({ send }) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression: `(async () => {
        const r = await fetch(${JSON.stringify(url)}, ${fetchOpts});
        const body = await r.text();
        const headers = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        return JSON.stringify({ status: r.status, headers, body });
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result?.value;
  }, 60000);
  if (res.error) return { error: res.error };
  try {
    return JSON.parse(res.result);
  } catch {
    return { error: "fetch failed" };
  }
}

export async function enableMock(
  port: number,
  tabId: string,
  patterns: { urlPattern: string; method?: string; responseCode?: number; responseBody?: string; responseHeaders?: Record<string, string> }[],
): Promise<{ ok: boolean; error?: string }> {
  const res = await cdpSession(port, tabId, async ({ send }) => {
    // Persist mock across navigations via JS injection
    // (CDP Fetch.enable would die with this session, so we only use Runtime)
    const mockScript = `(() => {
        if (!window.__cdpxMocks) window.__cdpxMocks = [];
        window.__cdpxMocks.push(...${JSON.stringify(patterns)});
        if (!window.__cdpxMockInstalled) {
          window.__cdpxMockInstalled = true;
          const origFetch = window.fetch;
          window.fetch = async function(input, init) {
            const url = typeof input === 'string' ? input : input.url;
            const method = init?.method || 'GET';
            for (const mock of window.__cdpxMocks) {
              try { if (!url.match(new RegExp(mock.urlPattern))) continue; } catch { continue; }
              if (!mock.method || mock.method === method) {
                return new Response(mock.responseBody || '', {
                  status: mock.responseCode || 200,
                  headers: mock.responseHeaders || {},
                });
              }
            }
            return origFetch.call(this, input, init);
          };
        }
      })()`;
    await send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript });
    await send("Runtime.evaluate", { expression: mockScript });
    return true;
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}
