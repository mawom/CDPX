import {
  BROWSER_BIN, parseUrl, isValidPort, parseBody,
  getTabs, invalidateTabCache, cdpCommand, cdpSession,
  openTab, closeTab, setTabName, getTabByName,
  tabProxies,
  type RouteResult,
} from "./shared.ts";
import { startInstance, stopInstance, stopAll, getStatus, injectStealthScripts, injectProxyAuth } from "./instance.ts";
import { installExtension, uninstallExtension, listExtensions } from "./extension.ts";
import { getContent, getSnapshot, getScreenshot, getPdf, getFormState, getPerfMetrics, getHtml } from "./page.ts";
import { perfTrace, getLongTasks, measureINP, startCoverage, getCoverageReport } from "./perf.ts";
import {
  clickElement, typeText, typeHuman, scrollPage, navigateTo,
  pressKey, hoverElement, mouseMove, drag,
  waitFor, waitForCondition, waitForLoadState, selectOption,
  dismissDialog, autoHandleDialogs, uploadFile, fillForm,
  setViewport, evalScript, authFetch, enableMock,
  setGeolocation, setPermissions, setTimezone, setLocale,
  addInitScript, setOffline, emulateMedia,
} from "./action.ts";
import {
  enableNetworkMonitor, disableNetworkMonitor, getNetworkRequests, clearNetworkRequests, getResponseBody,
  enableConsoleMonitor, disableConsoleMonitor, getConsoleLogs, clearConsoleLogs,
  enableDownloadIntercept, getDownloads,
} from "./monitor.ts";
import { getCookies, setCookie, clearCookies, getStorage, setStorage, removeStorage, exportSession, importSession } from "./storage.ts";
import { saveProfileSnapshot, restoreProfileSnapshot, listSnapshots } from "./profile.ts";
import { openTabWithProxy, createContext, openTabInContext, closeContext } from "./proxy.ts";
import { executeBatch, setHandleRoute } from "./batch.ts";

export { BROWSER_BIN, getStatus };

export async function handleRoute(
  method: string,
  url: string,
  body: string,
): Promise<RouteResult> {
  const { path: p, query: q } = parseUrl(url);

  // GET /api/browser/status
  if (method === "GET" && p === "/api/browser/status") {
    return { instances: await getStatus() };
  }

  // GET /api/browser/tabs?port=9222
  if (method === "GET" && p === "/api/browser/tabs") {
    const port = parseInt(q.port, 10);
    if (!isValidPort(port)) return { status: 400, error: "invalid port" };
    const tabs = await getTabs(port);
    // Enrich tabs with proxy info if available
    const enriched = tabs.map((t) => {
      const proxy = tabProxies.get(t.id);
      return proxy ? { ...t, proxy } : t;
    });
    return { tabs: enriched };
  }

  // GET /api/browser/screenshot?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/screenshot") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    const data = await getScreenshot(port, id);
    if (!data) return { status: 404, error: "screenshot failed" };
    return { image: data };
  }

  // GET /api/browser/pdf?port=9222&id=xxx&landscape=1
  if (method === "GET" && p === "/api/browser/pdf") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    const data = await getPdf(port, id, {
      landscape: q.landscape === "1" || q.landscape === "true",
      scale: q.scale && Number(q.scale) > 0 ? Number(q.scale) : undefined,
    });
    if (!data) return { status: 500, error: "pdf generation failed" };
    return { pdf: data };
  }

  // GET /api/browser/content?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/content") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    const data = await getContent(port, id);
    if (!data) return { status: 500, error: "content extraction failed" };
    return data;
  }

  // GET /api/browser/html?port=9222&id=xxx&selector=.main
  if (method === "GET" && p === "/api/browser/html") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    const result = await getHtml(port, id, q.selector);
    if (result.error) return { status: 404, error: result.error };
    return { html: result.html };
  }

  // GET /api/browser/snapshot?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/snapshot") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    const includeContent = q.content === "1" || q.content === "true";
    const snap = await getSnapshot(port, id);
    if (!snap) return { status: 500, error: "snapshot failed" };
    if (includeContent) {
      const content = await getContent(port, id);
      return { ...snap, content: content?.content || "" };
    }
    return snap;
  }

  // POST /api/browser/navigate  body: { port, tabId, url }
  if (method === "POST" && p === "/api/browser/navigate") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, url: navUrl, timeout } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!navUrl || typeof navUrl !== "string") return { status: 400, error: "missing url" };
    return await navigateTo(port as number, tabId, navUrl, typeof timeout === "number" ? timeout : undefined);
  }

  // POST /api/browser/click  body: { port, tabId, ref?, selector?, x?, y? }
  if (method === "POST" && p === "/api/browser/click") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector, x, y } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    // Coordinate click (canvas, SVG, maps, etc.)
    if (typeof x === "number" && typeof y === "number") {
      const res = await cdpSession(port as number, tabId, async ({ send }) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return true;
      });
      if (res.error) return { ok: false, error: res.error };
      return { ok: true };
    }
    if (!ref && !selector) return { status: 400, error: "ref, selector, or x/y required" };
    return await clickElement(port as number, tabId, {
      ref: ref as number | undefined,
      selector: selector as string | undefined,
    });
  }

  // POST /api/browser/type  body: { port, tabId, ref?, selector?, text, clear?, humanLike?, delayMs? }
  if (method === "POST" && p === "/api/browser/type") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector, text: inputText, clear, humanLike, delayMs } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!ref && !selector) return { status: 400, error: "ref or selector required" };
    if (typeof inputText !== "string") return { status: 400, error: "missing text" };
    if (humanLike) {
      return await typeHuman(port as number, tabId, {
        ref: ref as number | undefined,
        selector: selector as string | undefined,
        text: inputText,
        delayMs: delayMs as number | undefined,
      });
    }
    return await typeText(port as number, tabId, {
      ref: ref as number | undefined,
      selector: selector as string | undefined,
      text: inputText,
      clear: !!clear,
    });
  }

  // POST /api/browser/scroll  body: { port, tabId, ref?, selector?, x?, y? }
  if (method === "POST" && p === "/api/browser/scroll") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector, x, y } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await scrollPage(port as number, tabId, {
      ref: ref as number | undefined,
      selector: selector as string | undefined,
      x: x as number | undefined,
      y: y as number | undefined,
    });
  }

  // POST /api/browser/eval  body: { port, tabId, expression }
  if (method === "POST" && p === "/api/browser/eval") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, expression, timeout } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!expression || typeof expression !== "string") return { status: 400, error: "missing expression" };
    return await evalScript(port as number, tabId, expression, typeof timeout === "number" ? timeout : undefined);
  }

  // POST /api/browser/keypress  body: { port, tabId, key }
  if (method === "POST" && p === "/api/browser/keypress") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, key } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!key || typeof key !== "string") return { status: 400, error: "missing key" };
    return await pressKey(port as number, tabId, key);
  }

  // POST /api/browser/hover  body: { port, tabId, ref?, selector? }
  if (method === "POST" && p === "/api/browser/hover") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!ref && !selector) return { status: 400, error: "ref or selector required" };
    return await hoverElement(port as number, tabId, {
      ref: ref as number | undefined,
      selector: selector as string | undefined,
    });
  }

  // POST /api/browser/wait  body: { port, tabId?, selector?, condition?, timeout? }
  if (method === "POST" && p === "/api/browser/wait") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, selector, condition, timeout } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (condition) {
      // Advanced condition mode
      return await waitForCondition(
        port as number,
        tabId as string | undefined,
        condition as string,
        typeof timeout === "number" ? timeout : 10000,
      );
    }
    // Simple selector/delay mode (backward compat)
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await waitFor(port as number, tabId as string, {
      selector: selector as string | undefined,
      timeout: timeout as number | undefined,
    });
  }

  // POST /api/browser/upload  body: { port, tabId, ref?, selector?, files?, base64?, filename? }
  if (method === "POST" && p === "/api/browser/upload") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector, files, base64, filename } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!ref && !selector) return { status: 400, error: "ref or selector required" };
    if (!base64 && (!Array.isArray(files) || files.length === 0)) {
      return { status: 400, error: "files array or base64 required" };
    }
    return await uploadFile(port as number, tabId, {
      ref: ref as number | undefined,
      selector: selector as string | undefined,
      files: Array.isArray(files) ? files as string[] : undefined,
      base64: base64 as string | undefined,
      filename: filename as string | undefined,
    });
  }

  // POST /api/browser/mouse-move  body: { port, tabId, path: [[x,y],...], duration }
  if (method === "POST" && p === "/api/browser/mouse-move") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, path: pathPts, duration } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!Array.isArray(pathPts) || pathPts.length < 2) return { status: 400, error: "path needs >= 2 points" };
    return await mouseMove(port as number, tabId, pathPts as number[][], typeof duration === "number" ? duration : 500);
  }

  // POST /api/browser/drag  body: { port, tabId, from: {x,y}, to: {x,y}, steps?, duration? }
  if (method === "POST" && p === "/api/browser/drag") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, from, to, steps, duration } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!from || !to) return { status: 400, error: "from and to required" };
    return await drag(port as number, tabId, {
      from: from as { x: number; y: number },
      to: to as { x: number; y: number },
      steps: steps as number | undefined,
      duration: duration as number | undefined,
    });
  }

  // POST /api/browser/viewport  body: { port, tabId, width, height }
  if (method === "POST" && p === "/api/browser/viewport") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, width, height } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return { status: 400, error: "width/height must be positive numbers" };
    return await setViewport(port as number, tabId, width, height);
  }

  // POST /api/browser/set-geolocation  body: { port, tabId, latitude, longitude, accuracy? }
  if (method === "POST" && p === "/api/browser/set-geolocation") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, latitude, longitude, accuracy } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (typeof latitude !== "number" || typeof longitude !== "number") return { status: 400, error: "latitude and longitude required" };
    return await setGeolocation(port as number, tabId, latitude, longitude, accuracy as number | undefined);
  }

  // POST /api/browser/set-permissions  body: { port, tabId, permissions: [...] }
  if (method === "POST" && p === "/api/browser/set-permissions") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, permissions } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!Array.isArray(permissions)) return { status: 400, error: "permissions must be an array" };
    return await setPermissions(port as number, tabId, permissions as string[]);
  }

  // POST /api/browser/set-timezone  body: { port, tabId, timezoneId }
  if (method === "POST" && p === "/api/browser/set-timezone") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, timezoneId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!timezoneId || typeof timezoneId !== "string") return { status: 400, error: "missing timezoneId" };
    return await setTimezone(port as number, tabId, timezoneId);
  }

  // POST /api/browser/set-locale  body: { port, tabId, locale }
  if (method === "POST" && p === "/api/browser/set-locale") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, locale } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!locale || typeof locale !== "string") return { status: 400, error: "missing locale" };
    return await setLocale(port as number, tabId, locale);
  }

  // POST /api/browser/add-init-script  body: { port, tabId, script }
  if (method === "POST" && p === "/api/browser/add-init-script") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, script } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!script || typeof script !== "string") return { status: 400, error: "missing script" };
    return await addInitScript(port as number, tabId, script);
  }

  // POST /api/browser/set-offline  body: { port, tabId, offline }
  if (method === "POST" && p === "/api/browser/set-offline") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, offline } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (typeof offline !== "boolean") return { status: 400, error: "offline must be a boolean" };
    return await setOffline(port as number, tabId, offline);
  }

  // POST /api/browser/emulate-media  body: { port, tabId, media?, colorScheme? }
  if (method === "POST" && p === "/api/browser/emulate-media") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, media, colorScheme } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await emulateMedia(port as number, tabId, media as string | undefined, colorScheme as string | undefined);
  }

  // GET /api/browser/perf?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/perf") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await getPerfMetrics(port, id);
  }

  // POST /api/browser/perf/trace  body: { port, tabId, duration? }
  if (method === "POST" && p === "/api/browser/perf/trace") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, duration } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await perfTrace(port as number, tabId, (duration as number) || 3000);
  }

  // GET /api/browser/perf/long-tasks?port=&id=&threshold=50
  if (method === "GET" && p === "/api/browser/perf/long-tasks") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await getLongTasks(port, id, q.threshold ? parseInt(q.threshold) : 50);
  }

  // POST /api/browser/perf/inp  body: { port, tabId, ref?, selector? }
  if (method === "POST" && p === "/api/browser/perf/inp") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await measureINP(port as number, tabId, { ref: ref as number, selector: selector as string });
  }

  // POST /api/browser/coverage/start  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/coverage/start") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await startCoverage(port as number, tabId);
  }

  // GET /api/browser/coverage/report?port=&id=
  if (method === "GET" && p === "/api/browser/coverage/report") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await getCoverageReport(port, id);
  }

  // POST /api/browser/mock  body: { port, tabId, patterns: [{urlPattern, responseCode?, responseBody?}] }
  if (method === "POST" && p === "/api/browser/mock") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, patterns } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!Array.isArray(patterns) || patterns.length === 0) return { status: 400, error: "patterns required" };
    return await enableMock(port as number, tabId, patterns as any[]);
  }

  // POST /api/browser/download-intercept  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/download-intercept") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await enableDownloadIntercept(port as number, tabId);
  }

  // GET /api/browser/downloads?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/downloads") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return { downloads: getDownloads(port, id) };
  }

  // POST /api/browser/fetch  body: { port, tabId, url, method?, headers?, body? }
  if (method === "POST" && p === "/api/browser/fetch") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, url: fetchUrl, method: fetchMethod, headers, body: fetchBody } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!fetchUrl || typeof fetchUrl !== "string") return { status: 400, error: "missing url" };
    return await authFetch(port as number, tabId, fetchUrl, {
      method: fetchMethod as string | undefined,
      headers: headers as Record<string, string> | undefined,
      body: fetchBody as string | undefined,
    });
  }

  // POST /api/browser/batch  body: { port, tabId?, steps: [{action, params}], parallel? }
  if (method === "POST" && p === "/api/browser/batch") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, steps } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!Array.isArray(steps) || steps.length === 0) return { status: 400, error: "steps required" };
    return await executeBatch(steps as any[], port as number, tabId as string | undefined);
  }

  // POST /api/browser/tab-name  body: { port, tabId, name }
  if (method === "POST" && p === "/api/browser/tab-name") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, name } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!name || typeof name !== "string") return { status: 400, error: "missing name" };
    setTabName(port as number, tabId, name);
    return { ok: true };
  }

  // GET /api/browser/tab-by-name?port=9222&name=xxx
  if (method === "GET" && p === "/api/browser/tab-by-name") {
    const port = parseInt(q.port, 10);
    const name = q.name;
    if (!isValidPort(port) || !name) return { status: 400, error: "missing port or name" };
    const tabId = getTabByName(port, name);
    if (!tabId) return { status: 404, error: "tab name not found" };
    return { tabId };
  }

  // GET /api/browser/form-state?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/form-state") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await getFormState(port, id);
  }

  // POST /api/browser/fill-form  body: { port, tabId, fields: [{ref?, selector?, value}] }
  if (method === "POST" && p === "/api/browser/fill-form") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, fields } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!Array.isArray(fields) || fields.length === 0) return { status: 400, error: "fields must be a non-empty array" };
    return await fillForm(port as number, tabId, fields as any[]);
  }

  // GET /api/browser/session/export?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/session/export") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await exportSession(port, id);
  }

  // POST /api/browser/session/import  body: { port, tabId, cookies?, localStorage? }
  if (method === "POST" && p === "/api/browser/session/import") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, cookies, localStorage } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await importSession(port as number, tabId, {
      cookies: cookies as any[] | undefined,
      localStorage: localStorage as Record<string, string> | undefined,
    });
  }

  // POST /api/browser/dismiss-dialog  body: { port, tabId, accept?, text? }
  if (method === "POST" && p === "/api/browser/dismiss-dialog") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, accept, text } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await dismissDialog(port as number, tabId, {
      accept: accept as boolean | undefined,
      text: text as string | undefined,
    });
  }

  // POST /api/browser/auto-dismiss  body: { port, tabId, accept? }
  if (method === "POST" && p === "/api/browser/auto-dismiss") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, accept } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await autoHandleDialogs(port as number, tabId, accept !== false);
  }

  // POST /api/browser/select  body: { port, tabId, ref?, selector?, value }
  if (method === "POST" && p === "/api/browser/select") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ref, selector, value } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!ref && !selector) return { status: 400, error: "ref or selector required" };
    if (typeof value !== "string") return { status: 400, error: "missing value" };
    return await selectOption(port as number, tabId, {
      ref: ref as number | undefined,
      selector: selector as string | undefined,
      value,
    });
  }

  // POST /api/browser/network/enable  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/network/enable") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await enableNetworkMonitor(port as number, tabId);
  }

  // POST /api/browser/network/disable  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/network/disable") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return { ok: disableNetworkMonitor(port as number, tabId) };
  }

  // GET /api/browser/network/requests?port=9222&id=xxx&url=&method=&type=
  if (method === "GET" && p === "/api/browser/network/requests") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    const requests = getNetworkRequests(port, id, {
      url: q.url,
      method: q.method,
      type: q.type,
    });
    return { requests };
  }

  // POST /api/browser/network/clear  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/network/clear") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    clearNetworkRequests(port as number, tabId);
    return { ok: true };
  }

  // GET /api/browser/network/response?port=9222&id=xxx&requestId=yyy
  if (method === "GET" && p === "/api/browser/network/response") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    const requestId = q.requestId;
    if (!isValidPort(port) || !id || !requestId) return { status: 400, error: "missing port, id, or requestId" };
    return await getResponseBody(port, id, requestId);
  }

  // POST /api/browser/console/enable  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/console/enable") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await enableConsoleMonitor(port as number, tabId);
  }

  // POST /api/browser/console/disable  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/console/disable") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return { ok: disableConsoleMonitor(port as number, tabId) };
  }

  // GET /api/browser/console/logs?port=9222&id=xxx&level=error
  if (method === "GET" && p === "/api/browser/console/logs") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return { logs: getConsoleLogs(port, id, { level: q.level }) };
  }

  // POST /api/browser/console/clear  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/console/clear") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    clearConsoleLogs(port as number, tabId);
    return { ok: true };
  }

  // GET /api/browser/storage?port=9222&id=xxx&type=local&key=foo
  if (method === "GET" && p === "/api/browser/storage") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    const type = q.type === "session" ? "session" : "local";
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await getStorage(port, id, type, q.key);
  }

  // POST /api/browser/storage/set  body: { port, tabId, type?, key, value }
  if (method === "POST" && p === "/api/browser/storage/set") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, type, key, value } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!key || typeof key !== "string") return { status: 400, error: "missing key" };
    if (typeof value !== "string") return { status: 400, error: "missing value" };
    const storageType = type === "session" ? "session" : "local";
    return await setStorage(port as number, tabId, storageType, key, value);
  }

  // POST /api/browser/storage/remove  body: { port, tabId, type?, key }
  if (method === "POST" && p === "/api/browser/storage/remove") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, type, key } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!key || typeof key !== "string") return { status: 400, error: "missing key" };
    const storageType = type === "session" ? "session" : "local";
    return await removeStorage(port as number, tabId, storageType, key);
  }

  // GET /api/browser/cookies?port=9222&id=xxx
  if (method === "GET" && p === "/api/browser/cookies") {
    const port = parseInt(q.port, 10);
    const id = q.id;
    if (!isValidPort(port) || !id) return { status: 400, error: "missing port or id" };
    return await getCookies(port, id);
  }

  // POST /api/browser/set-cookie  body: { port, tabId, name, value, domain, ... }
  if (method === "POST" && p === "/api/browser/set-cookie") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, ...cookie } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    if (!cookie.name || cookie.value === undefined || cookie.value === null) return { status: 400, error: "missing name or value" };
    return await setCookie(port as number, tabId, cookie);
  }

  // POST /api/browser/clear-cookies  body: { port, tabId }
  if (method === "POST" && p === "/api/browser/clear-cookies") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await clearCookies(port as number, tabId);
  }

  // POST /api/browser/context/create  body: { port, proxy? }
  if (method === "POST" && p === "/api/browser/context/create") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, proxy } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    return await createContext(port as number, { proxy: proxy as string | undefined });
  }

  // POST /api/browser/context/open  body: { port, contextId, url? }
  if (method === "POST" && p === "/api/browser/context/open") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, contextId, url } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!contextId || typeof contextId !== "string") return { status: 400, error: "missing contextId" };
    return await openTabInContext(port as number, contextId, url as string | undefined);
  }

  // POST /api/browser/context/close  body: { port, contextId }
  if (method === "POST" && p === "/api/browser/context/close") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, contextId } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!contextId || typeof contextId !== "string") return { status: 400, error: "missing contextId" };
    return await closeContext(port as number, contextId);
  }

  // POST /api/browser/wait-load  body: { port, tabId, state? }
  if (method === "POST" && p === "/api/browser/wait-load") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, state, timeout } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!tabId || typeof tabId !== "string") return { status: 400, error: "missing tabId" };
    return await waitForLoadState(port as number, tabId, (state as "load" | "domcontentloaded") || "load", (timeout as number) || 30000);
  }

  // POST /api/browser/connect  body: { port }
  if (method === "POST" && p === "/api/browser/connect") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    // Verify CDP is reachable
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { status: 502, error: "CDP not reachable on port " + port };
      const info = await res.json() as Record<string, string>;
      invalidateTabCache(port as number);
      const tabs = await getTabs(port as number);
      return { connected: true, port, browser: info["Browser"], tabs: tabs.length };
    } catch {
      return { status: 502, error: `no browser found on port ${port}. Start Chrome with: --remote-debugging-port=${port}` };
    }
  }

  // POST /api/browser/start  body: { ports: [9222], proxy?: "socks5://127.0.0.1:1080" }
  if (method === "POST" && p === "/api/browser/start") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { ports = [9222], proxy, headless, stealth, fingerprint } = parsed;
    if (!Array.isArray(ports) || ports.length === 0) {
      return { status: 400, error: "ports must be a non-empty array" };
    }
    const numericPorts: number[] = [];
    for (const port of ports) {
      const p = typeof port === "string" ? parseInt(port, 10) : port;
      if (!isValidPort(p)) {
        return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
      }
      numericPorts.push(p);
    }
    if (proxy !== undefined && typeof proxy !== "string") {
      return { status: 400, error: "proxy must be a string" };
    }
    const results = numericPorts.map((p: number) =>
      startInstance(p, {
        proxy: proxy as string | undefined,
        headless: headless as boolean | undefined,
        stealth: stealth as boolean | undefined,
        fingerprint: fingerprint as "random" | "default" | undefined,
      }),
    );
    // Post-launch setup in background (don't block response)
    for (const inst of results) {
      if (!inst.running) continue;
      if (stealth !== false) injectStealthScripts(inst.port).catch(() => {});
      if (proxy) injectProxyAuth(inst.port, proxy as string).catch(() => {});
    }
    return { instances: results };
  }

  // POST /api/browser/stop  body: { port: 9222 }
  if (method === "POST" && p === "/api/browser/stop") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }
    const ok = stopInstance(port as number);
    return { ok };
  }

  // POST /api/browser/restart  body: { port: 9222, proxy?: "..." }
  if (method === "POST" && p === "/api/browser/restart") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, proxy, headless, stealth, fingerprint } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }
    if (proxy !== undefined && typeof proxy !== "string") {
      return { status: 400, error: "proxy must be a string" };
    }
    stopInstance(port as number);
    await new Promise((r) => setTimeout(r, 500));
    const instance = startInstance(port as number, {
      proxy: proxy as string | undefined,
      headless: headless as boolean | undefined,
      stealth: stealth as boolean | undefined,
      fingerprint: fingerprint as "random" | "default" | undefined,
    });
    if (instance.running) {
      if (stealth !== false) injectStealthScripts(instance.port).catch(() => {});
      if (proxy) injectProxyAuth(instance.port, proxy as string).catch(() => {});
    }
    return { instance };
  }

  // POST /api/browser/stop-all
  if (method === "POST" && p === "/api/browser/stop-all") {
    const count = await stopAll();
    return { stopped: count };
  }

  // POST /api/browser/open  body: { port, url?, name?, proxy? }
  if (method === "POST" && p === "/api/browser/open") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, url: tabUrl, name, proxy } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }

    if (proxy && typeof proxy === "string") {
      // Per-tab proxy via isolated browser context
      const result = await openTabWithProxy(port as number, proxy, tabUrl as string | undefined);
      if (result.error) return { status: 500, error: result.error };
      if (result.tab && name && typeof name === "string") setTabName(port as number, result.tab.id, name);
      return { tab: result.tab, contextId: result.contextId, proxy };
    }

    const tab = await openTab(port as number, tabUrl as string | undefined);
    if (!tab) return { status: 500, error: "failed to open tab" };
    if (name && typeof name === "string") setTabName(port as number, tab.id, name);
    return { tab };
  }

  // POST /api/browser/close-tab  body: { port: 9222, tabId: "xxx" }
  if (method === "POST" && p === "/api/browser/close-tab") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }
    if (!tabId || typeof tabId !== "string") {
      return { status: 400, error: "missing tabId" };
    }
    const ok = await closeTab(port as number, tabId);
    return { ok };
  }

  // POST /api/browser/cdp  body: { port: 9222, tabId: "xxx", method: "Page.navigate", params?: {} }
  if (method === "POST" && p === "/api/browser/cdp") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, tabId, method: cdpMethod, params } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }
    if (!tabId || typeof tabId !== "string") {
      return { status: 400, error: "missing tabId" };
    }
    if (!cdpMethod || typeof cdpMethod !== "string") {
      return { status: 400, error: "missing method" };
    }
    const res = await cdpCommand(
      port as number,
      tabId,
      cdpMethod,
      params as Record<string, unknown> | undefined,
    );
    if (res.error) return { status: 500, error: res.error };
    return { result: res.result };
  }

  // POST /api/browser/profile/save  body: { port, name }
  if (method === "POST" && p === "/api/browser/profile/save") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, name } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!name || typeof name !== "string") return { status: 400, error: "missing name" };
    return saveProfileSnapshot(port as number, name);
  }

  // POST /api/browser/profile/restore  body: { port, name }
  if (method === "POST" && p === "/api/browser/profile/restore") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, name } = parsed;
    if (!isValidPort(port as number)) return { status: 400, error: "invalid port" };
    if (!name || typeof name !== "string") return { status: 400, error: "missing name" };
    return restoreProfileSnapshot(port as number, name);
  }

  // GET /api/browser/profile/list
  if (method === "GET" && p === "/api/browser/profile/list") {
    return { snapshots: listSnapshots() };
  }

  // GET /api/browser/extensions?port=9222
  if (method === "GET" && p === "/api/browser/extensions") {
    const port = parseInt(q.port, 10);
    if (!isValidPort(port)) return { status: 400, error: "invalid port" };
    return { extensions: listExtensions(port) };
  }

  // POST /api/browser/install-extension  body: { port, url?, path?, name? }
  if (method === "POST" && p === "/api/browser/install-extension") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, url: extUrl, path: extPath, name: extName } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }
    if (!extUrl && !extPath) {
      return { status: 400, error: "url or path required" };
    }
    try {
      const info = await installExtension(port as number, {
        url: extUrl as string | undefined,
        path: extPath as string | undefined,
        name: extName as string | undefined,
      }, startInstance, stopInstance);
      return { installed: info };
    } catch (err: any) {
      return { status: 500, error: err.message };
    }
  }

  // POST /api/browser/uninstall-extension  body: { port, name }
  if (method === "POST" && p === "/api/browser/uninstall-extension") {
    const parsed = parseBody(body);
    if (parsed.__invalid) return { status: 400, error: "invalid JSON body" };
    const { port, name: extName } = parsed;
    if (!isValidPort(port as number)) {
      return { status: 400, error: `invalid port: ${port} (must be 1024-65535, not reserved by server)` };
    }
    if (!extName || typeof extName !== "string") {
      return { status: 400, error: "missing name" };
    }
    const ok = uninstallExtension(port as number, extName);
    return { ok };
  }

  return { status: 404, error: "not found" };
}

// Wire up batch to use handleRoute (breaks circular dep)
setHandleRoute(handleRoute);

// Re-export as handleBrowserRoute for backward compat
export { handleRoute as handleBrowserRoute };
