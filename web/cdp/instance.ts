import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_BIN, ensureDirs, pidFile, metaFile, PROFILES_DIR, loadMeta, saveMeta, isRunning, PIDS_DIR,
  getTabs, invalidateTabCache, cdpCommand,
  tabNames, tabProxies, tabContexts,
  type Instance, type StartOpts,
} from "./shared.ts";
import { getExtensionLoadArg } from "./extension.ts";
import { networkMonitors, consoleMonitors, downloadMonitors } from "./monitor.ts";

// Anti-detection flags — mimic normal user browser, hide automation signals
// Sources: puppeteer-extra-plugin-stealth, undetected-chromedriver, patchright
export const STEALTH_ARGS = [
  // Core: remove navigator.webdriver=true signal
  "--disable-blink-features=AutomationControlled",
  // Suppress Chrome feature noise that differs from real user browsers
  "--disable-features=Translate,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,HttpsUpgrades,PaintHolding",
  // Prevent background throttling (real browsers don't throttle active tabs)
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-ipc-flooding-protection",
  // Misc
  "--no-service-autorun",
  "--password-store=basic",
  "--lang=en-US",
];

// Fingerprint profiles — UA + viewport + platform bound together to avoid detection
export const FINGERPRINT_PROFILES = [
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1920,1080" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "2560,1440" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1440,900" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1920,1080" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1366,768" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1536,864" },
  { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1920,1080" },
  { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", vp: "1366,768" },
];

// Stealth JS injection — patches navigator/window properties that headless Chrome leaks
export const STEALTH_INJECT_SCRIPT = `
// Hide webdriver flag
// Delete the webdriver property and redefine as a data property (matches real browser behavior)
delete Object.getPrototypeOf(navigator).webdriver;
Object.defineProperty(navigator, 'webdriver', { value: undefined, writable: true, configurable: true });
// Spoof plugins (headless has 0) — mimic PluginArray shape, return same reference
if (!window.__cdpxPlugins) window.__cdpxPlugins = [
  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
  { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
];
if (!window.__cdpxPlugins.item) {
  window.__cdpxPlugins.item = (i) => window.__cdpxPlugins[i];
  window.__cdpxPlugins.namedItem = (n) => window.__cdpxPlugins.find(x => x.name === n);
  window.__cdpxPlugins.refresh = () => {};
}
Object.defineProperty(navigator, 'plugins', { get: () => window.__cdpxPlugins });
if (!window.__cdpxLangs) window.__cdpxLangs = Object.freeze(['en-US', 'en']);
Object.defineProperty(navigator, 'languages', { get: () => window.__cdpxLangs });
// Spoof chrome object (missing or incomplete in headless)
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = {};
if (!window.chrome.app) window.chrome.app = { isInstalled: false };
// Fix permissions query (guard against double-injection)
if (!window.__cdpxPermPatched) {
  window.__cdpxPermPatched = true;
  const origQuery = window.Permissions?.prototype?.query;
  if (origQuery) {
    window.Permissions.prototype.query = function(params) {
      return params?.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(this, params);
    };
  }
}
`;

export function startInstance(port: number, opts?: StartOpts): Instance {
  const proxy = opts?.proxy;
  const headless = opts?.headless ?? false;
  const stealth = opts?.stealth ?? true;

  ensureDirs();

  // check if already running
  const pf = pidFile(port);
  try {
    const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
    if (isRunning(pid)) {
      const meta = loadMeta(port);
      return { port, pid, running: true, proxy: meta.proxy as string | undefined };
    }
  } catch {
    // no pid file, proceed to start
  }

  const profileDir = path.join(PROFILES_DIR, String(port));
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) args.push("--headless=new");
  if (stealth) args.push(...STEALTH_ARGS);
  if (opts?.fingerprint === "random") {
    const fp = FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
    args.push(`--window-size=${fp.vp}`, `--user-agent=${fp.ua}`);
  }
  if (proxy) {
    // Strip auth from proxy URL for --proxy-server (Chromium doesn't support inline auth)
    // Auth will be injected via CDP Fetch.authRequired after launch
    try {
      const proxyUrl = new URL(proxy);
      const proxyNoAuth = `${proxyUrl.protocol}//${proxyUrl.host}`;
      args.push(`--proxy-server=${proxyNoAuth}`);
    } catch {
      // Not a valid URL, pass as-is (e.g. "host:port")
      args.push(`--proxy-server=${proxy}`);
    }
  }
  const extArg = getExtensionLoadArg(port);
  if (extArg) {
    args.push(`--enable-extensions`, `--load-extension=${extArg}`);
  }

  const child = spawn(BROWSER_BIN, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // prevent unhandled crash (e.g. ENOENT)

  child.unref();
  const pid = child.pid;
  if (!pid) return { port, pid: 0, running: false };
  fs.writeFileSync(pf, String(pid));
  const existingMeta = loadMeta(port);
  saveMeta(port, { ...existingMeta, proxy: proxy || null, headless, stealth, fingerprint: opts?.fingerprint || null });

  return { port, pid, running: true, proxy };
}

export async function injectStealthScripts(port: number): Promise<void> {
  // Wait for CDP to be ready
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  // Inject stealth script on each tab (Page.addScriptToEvaluateOnNewDocument is tab-level, not browser-level)
  try {
    const tabs = await getTabs(port);
    for (const tab of tabs) {
      if (!tab.webSocketDebuggerUrl) continue;
      try {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise<void>((resolve) => {
          let received = 0;
          const done = () => { try { ws.close(); } catch {} resolve(); };
          const timeout = setTimeout(done, 3000);
          ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: STEALTH_INJECT_SCRIPT } }));
            ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: STEALTH_INJECT_SCRIPT } }));
          };
          ws.onmessage = () => {
            if (++received >= 2) { clearTimeout(timeout); done(); }
          };
          ws.onerror = () => { clearTimeout(timeout); done(); };
        });
      } catch {}
    }
  } catch {}
}

// --- Proxy auth injection (for http://user:pass@host:port proxies) ---
export async function injectProxyAuth(port: number, proxy: string): Promise<void> {
  let username: string, password: string;
  try {
    const u = new URL(proxy);
    if (!u.username) return; // No auth needed
    username = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } catch {
    return;
  }

  // Wait for CDP ready
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await res.json() as { webSocketDebuggerUrl: string };
    if (!webSocketDebuggerUrl) return;

    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve) => {
      let nextId = 1;
      ws.onopen = () => {
        // Enable Fetch domain to intercept auth challenges
        ws.send(JSON.stringify({ id: nextId++, method: "Fetch.enable", params: {
          handleAuthRequests: true,
        }}));
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          // Handle proxy auth challenge
          if (msg.method === "Fetch.authRequired") {
            ws.send(JSON.stringify({
              id: nextId++,
              method: "Fetch.continueWithAuth",
              params: {
                requestId: msg.params.requestId,
                authChallengeResponse: {
                  response: "ProvideCredentials",
                  username,
                  password,
                },
              },
            }));
          }
          // Let non-auth requests continue normally
          if (msg.method === "Fetch.requestPaused" && !msg.params.responseStatusCode) {
            ws.send(JSON.stringify({
              id: nextId++,
              method: "Fetch.continueRequest",
              params: { requestId: msg.params.requestId },
            }));
          }
        } catch {}
      };
      // Keep this connection alive (don't close it — auth challenges come at any time)
      ws.onerror = () => resolve();
      setTimeout(() => resolve(), 3000);
    });
    // Note: ws intentionally NOT closed — it stays open to handle ongoing auth challenges
  } catch {}
}

export function stopInstance(port: number): boolean {
  invalidateTabCache(port);
  // Clean up tab-level state for this port
  const portPrefix = `${port}:`;
  for (const [k, tabId] of tabNames) {
    if (k.startsWith(portPrefix)) {
      tabNames.delete(k);
      tabProxies.delete(tabId);
      const ctx = tabContexts.get(tabId);
      if (ctx) { try { ctx.authWs?.close(); } catch {} tabContexts.delete(tabId); }
    }
  }
  // Close all monitors for this port
  for (const [key, handle] of networkMonitors) {
    if (key.startsWith(`${port}:`)) {
      try { handle.ws.close(); } catch {}
      networkMonitors.delete(key);
    }
  }
  for (const [key, handle] of consoleMonitors) {
    if (key.startsWith(`${port}:`)) {
      try { handle.ws.close(); } catch {}
      consoleMonitors.delete(key);
    }
  }
  for (const [key, handle] of downloadMonitors) {
    if (key.startsWith(`${port}:`)) {
      try { handle.ws.close(); } catch {}
      downloadMonitors.delete(key);
    }
  }

  const pf = pidFile(port);
  let raw: string;
  try {
    raw = fs.readFileSync(pf, "utf-8").trim();
  } catch {
    return false;
  }
  const pid = parseInt(raw, 10);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  try { fs.unlinkSync(pf); } catch {}
  return true;
}

export function stopAll(): number {
  const instances = getStatus();
  let count = 0;
  for (const inst of instances) {
    if (stopInstance(inst.port)) count++;
  }
  return count;
}

export function getStatus(): Instance[] {
  ensureDirs();
  const files = fs.readdirSync(PIDS_DIR).filter((f) => f.endsWith(".pid"));
  return files.flatMap((f) => {
    const port = parseInt(f.replace(".pid", ""), 10);
    if (!Number.isFinite(port)) return [];
    try {
      const pid = parseInt(fs.readFileSync(pidFile(port), "utf-8").trim(), 10);
      if (!isRunning(pid)) {
        try { fs.unlinkSync(pidFile(port)); } catch {}
        try { fs.unlinkSync(metaFile(port)); } catch {}
        return [];
      }
      const meta = loadMeta(port);
      return [{
        port, pid, running: true,
        proxy: meta.proxy as string | undefined,
        stealth: !!meta.stealth,
        headless: !!meta.headless,
        fingerprint: meta.fingerprint as string | undefined,
      }];
    } catch {
      return [];
    }
  });
}
