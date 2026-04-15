# CDPX Browser API

Base URL: `http://localhost:1024`

All POST bodies are JSON. All responses are JSON.

---

## Instance Management

### POST /api/browser/start
Start browser instances.
```json
{"ports": [9222], "proxy": "socks5://127.0.0.1:1080", "headless": false, "stealth": true, "fingerprint": "random"}
```
- `ports` (required): array of debugging ports
- `proxy`: proxy server URL
- `headless`: run without UI (`--headless=new`)
- `stealth`: anti-detection flags (default: true)
- `fingerprint`: `"random"` randomizes viewport + User-Agent

### POST /api/browser/stop
```json
{"port": 9222}
```

### POST /api/browser/restart
Same params as `start`, plus `port` instead of `ports`.

### POST /api/browser/stop-all
No body required.

### POST /api/browser/connect
Connect to an already-running Chrome/Chromium with `--remote-debugging-port`.
```json
{"port": 9222}
```
Returns `{connected: true, port, browser, tabs}` or error with instructions.

### GET /api/browser/status
Returns `{instances: [{port, pid, running, proxy?}]}`.

---

## Tabs

### GET /api/browser/tabs?port=9222
Returns all tabs (pages + extensions).

### POST /api/browser/open
```json
{"port": 9222, "url": "https://example.com", "name": "my-tab", "proxy": "socks5://1.2.3.4:1080"}
```
- `name`: optional, assigns a name for `tab-by-name` lookup
- `proxy`: optional, per-tab proxy. Creates an isolated BrowserContext with its own proxy. All navigations within this tab stay on the same proxy. Supports `http://`, `https://`, `socks5://`, and `http://user:pass@host:port` formats.

### POST /api/browser/close-tab
```json
{"port": 9222, "tabId": "ABC123"}
```

### POST /api/browser/tab-name
```json
{"port": 9222, "tabId": "ABC123", "name": "my-tab"}
```

### GET /api/browser/tab-by-name?port=9222&name=my-tab
Returns `{tabId: "ABC123"}`.

---

## Perception (AI reads the page)

### GET /api/browser/snapshot?port=9222&id=TAB_ID&content=1
**Core AI endpoint.** Returns interactive element tree with `[ref=N]` IDs.
```
[1] <a href="/"> Home
[2] <button> Sign In
[3] <input placeholder="Search...">
[4] <input type=file files=0>
```
- `content=1`: also returns page Markdown content
- Response: `{url, title, snapshot, refCount, content?}`

### GET /api/browser/html?port=9222&id=TAB_ID&selector=.main
Raw HTML of the page or a specific element.
- `selector`: optional CSS selector to scope extraction
- Returns `{html: "<html>..."}`

### GET /api/browser/content?port=9222&id=TAB_ID
Page content as Markdown (pierces Shadow DOM).
Response includes `state`:
```json
{"title": "...", "url": "...", "content": "# Heading\n...", "state": {
  "hasFileInput": true, "hasModal": false, "hasAlert": false,
  "hasForm": true, "hasVideo": false, "hasPassword": false,
  "scrollHeight": 3200, "scrollTop": 0, "viewportHeight": 900
}}
```

### GET /api/browser/screenshot?port=9222&id=TAB_ID
Returns `{image: "base64..."}` (JPEG).

### GET /api/browser/pdf?port=9222&id=TAB_ID&landscape=1&scale=0.8
Returns `{pdf: "base64..."}`.

### GET /api/browser/form-state?port=9222&id=TAB_ID
All form field values:
```json
{"fields": [
  {"tag": "input", "type": "text", "name": "title", "ref": 18, "value": "My Project"},
  {"tag": "input", "type": "file", "name": "image", "ref": 31, "files": [{"name": "logo.png", "size": 403221}]},
  {"tag": "input", "type": "checkbox", "name": "featured", "ref": 22, "checked": true},
  {"tag": "select", "name": "category", "options": [{"value": "tech", "text": "Technology", "selected": true}]}
]}
```

### GET /api/browser/perf?port=9222&id=TAB_ID
Returns `{loadTime, domNodes, jsHeapUsedSize, jsHeapTotalSize, documents, frames, layoutCount}`.

---

## Actions (AI controls the page)

### POST /api/browser/click
```json
{"port": 9222, "tabId": "ABC", "ref": 3}
```
Or by CSS selector: `{"port": 9222, "tabId": "ABC", "selector": "button.submit"}`.
Or by coordinates: `{"port": 9222, "tabId": "ABC", "x": 100, "y": 200}`.
Auto-scrolls element into view before clicking.

### POST /api/browser/type
```json
{"port": 9222, "tabId": "ABC", "ref": 5, "text": "Hello World", "clear": true}
```
- `clear`: clears existing value first (React-compatible)
- `humanLike`: true = per-character typing with random delays
- `delayMs`: base delay between characters (default 80ms, +-40% jitter)

### POST /api/browser/navigate
```json
{"port": 9222, "tabId": "ABC", "url": "https://example.com"}
```
Waits for `Page.loadEventFired` before returning.

### POST /api/browser/scroll
By element: `{"port": 9222, "tabId": "ABC", "ref": 10}`
By pixels: `{"port": 9222, "tabId": "ABC", "y": 500}`

### POST /api/browser/mouse-move
```json
{"port": 9222, "tabId": "ABC", "path": [[100,200],[300,400],[500,362]], "duration": 800}
```
Simulates realistic mouse trajectory. Important for anti-bot detection.

### POST /api/browser/drag
```json
{"port": 9222, "tabId": "ABC", "from": {"x": 100, "y": 200}, "to": {"x": 400, "y": 200}, "steps": 20, "duration": 500}
```
Drag and drop — press at `from`, move along path, release at `to`. Useful for slider captchas and puzzle verification.

### POST /api/browser/keypress
```json
{"port": 9222, "tabId": "ABC", "key": "Enter"}
```
Supported: enter, escape, tab, backspace, delete, space, arrowup/down/left/right, or any single character.

### POST /api/browser/hover
```json
{"port": 9222, "tabId": "ABC", "ref": 3}
```

### POST /api/browser/select
```json
{"port": 9222, "tabId": "ABC", "ref": 7, "value": "tech"}
```

### POST /api/browser/upload
By local file: `{"port": 9222, "tabId": "ABC", "ref": 31, "files": ["/path/to/image.png"]}`
By base64: `{"port": 9222, "tabId": "ABC", "ref": 31, "base64": "iVBOR...", "filename": "logo.png"}`

### POST /api/browser/fill-form
```json
{"port": 9222, "tabId": "ABC", "fields": [
  {"ref": 18, "value": "My Project"},
  {"ref": 19, "value": "PROJ"},
  {"selector": "textarea", "value": "Description here"}
]}
```

### POST /api/browser/wait
Simple: `{"port": 9222, "tabId": "ABC", "selector": ".result", "timeout": 5000}`
Advanced conditions:
```json
{"port": 9222, "tabId": "ABC", "condition": "text-appears:确认交易", "timeout": 10000}
{"port": 9222, "condition": "tab-with-url:chrome-extension://", "timeout": 10000}
```
Condition types:
- `url-contains:string` — wait for URL to contain string
- `text-appears:string` — wait for text to appear on page
- `element-gone:selector` — wait for element to disappear
- `tab-with-url:pattern` — wait for new tab matching URL (returns `{tabId}`)

### POST /api/browser/dismiss-dialog
```json
{"port": 9222, "tabId": "ABC", "accept": true, "text": "response for prompt"}
```

### POST /api/browser/auto-dismiss
```json
{"port": 9222, "tabId": "ABC", "accept": true}
```
Overrides `window.alert/confirm/prompt` to auto-dismiss future dialogs.

### POST /api/browser/viewport
```json
{"port": 9222, "tabId": "ABC", "width": 1920, "height": 1080}
```

### POST /api/browser/eval
```json
{"port": 9222, "tabId": "ABC", "expression": "document.title"}
{"port": 9222, "tabId": "ABC", "expression": "await fetch('/api/data').then(r => r.json())"}
```
Supports `await` expressions.

### POST /api/browser/fetch
```json
{"port": 9222, "tabId": "ABC", "url": "https://api.example.com/data", "method": "GET"}
```
Authenticated fetch — runs in the browser context with full cookies. No page load needed.

### POST /api/browser/mock
```json
{"port": 9222, "tabId": "ABC", "patterns": [
  {"urlPattern": "api/price", "responseCode": 200, "responseBody": "{\"price\": 1.5}"}
]}
```
Overrides `window.fetch` to return custom responses for matching URLs.

### POST /api/browser/batch
```json
{"port": 9222, "tabId": "ABC", "steps": [
  {"action": "click", "params": {"ref": 3}},
  {"action": "type", "params": {"ref": 5, "text": "Hello"}},
  {"action": "screenshot", "params": {}}
]}
```
Executes steps sequentially, stops on first error.

---

## Network Monitoring (F12 Network)

### POST /api/browser/network/enable
```json
{"port": 9222, "tabId": "ABC"}
```
Opens a persistent CDP connection to capture all network traffic.

### GET /api/browser/network/requests?port=9222&id=ABC&url=api&method=POST&type=XHR
Filtered request list. All filters optional.
```json
{"requests": [
  {"requestId": "1.1", "method": "POST", "url": "https://api.example.com/data", "type": "XHR", "status": 200, "mimeType": "application/json"}
]}
```

### GET /api/browser/network/response?port=9222&id=ABC&requestId=1.1
Returns `{body: "...", base64Encoded: false}`.

### POST /api/browser/network/clear
Clear captured requests.

### POST /api/browser/network/disable
Stop capturing and close the persistent connection.

---

## Console Logs (F12 Console)

### POST /api/browser/console/enable
Captures `console.log/warn/error`, JS exceptions, and browser-level logs.

### GET /api/browser/console/logs?port=9222&id=ABC&level=error
```json
{"logs": [
  {"level": "error", "text": "Uncaught TypeError: Cannot read property 'x' of null", "url": "https://...", "line": 42, "timestamp": 1710000000}
]}
```

### POST /api/browser/console/clear
### POST /api/browser/console/disable

---

## Storage & Cookies

### GET /api/browser/storage?port=9222&id=ABC&type=local&key=token
- `type`: `local` (default) or `session`
- `key`: optional, returns single value. Omit for all.

### POST /api/browser/storage/set
```json
{"port": 9222, "tabId": "ABC", "type": "local", "key": "token", "value": "abc123"}
```

### POST /api/browser/storage/remove
```json
{"port": 9222, "tabId": "ABC", "key": "token"}
```

### GET /api/browser/cookies?port=9222&id=ABC
### POST /api/browser/set-cookie
```json
{"port": 9222, "tabId": "ABC", "name": "session", "value": "xyz", "domain": "example.com", "httpOnly": true}
```

### GET /api/browser/session/export?port=9222&id=ABC
Exports all cookies + localStorage for backup/restore.
```json
{"cookies": [...], "localStorage": {"key": "value"}}
```

### POST /api/browser/session/import
```json
{"port": 9222, "tabId": "ABC", "cookies": [...], "localStorage": {"key": "value"}}
```

---

## Performance Analysis

### POST /api/browser/perf/trace
Record performance data for a specified duration.
```json
{"port": 9222, "tabId": "ABC", "duration": 3000}
```
Returns `{trace: {timing: {loadTime, domReady, firstByte}, entries: [{name, duration, startTime}], memory: {usedJSHeapSize, totalJSHeapSize}}}`.

### GET /api/browser/perf/long-tasks?port=9222&id=ABC&threshold=50
Returns JS tasks exceeding the threshold (ms).
```json
{"tasks": [{"name": "self", "duration": 120, "startTime": 4500}]}
```

### POST /api/browser/perf/inp
Measure Interaction to Next Paint — clicks an element and measures input-to-paint delay.
```json
{"port": 9222, "tabId": "ABC", "ref": 8}
```
Returns `{inp: 21, processingStart: 3, processingEnd: 18}`.

---

## Coverage Analysis

### POST /api/browser/coverage/start
Start tracking JS and CSS code coverage.
```json
{"port": 9222, "tabId": "ABC"}
```

### GET /api/browser/coverage/report?port=9222&id=ABC
Returns per-file usage statistics.
```json
{"files": [
  {"url": "vendor-xxx.js", "type": "js", "used": 15200, "total": 380000, "pct": "4.0%"},
  {"url": "styles.css", "type": "css", "used": 8000, "total": 12000, "pct": "66.7%"}
]}
```

---

## Downloads

### POST /api/browser/download-intercept
```json
{"port": 9222, "tabId": "ABC"}
```

### GET /api/browser/downloads?port=9222&id=ABC
```json
{"downloads": [{"guid": "...", "url": "...", "filename": "report.pdf", "state": "completed", "timestamp": 1710000000}]}
```

---

## Profile Snapshots

Save/restore entire browser state (profile directory + extensions + IndexedDB).

### POST /api/browser/profile/save
```json
{"port": 9222, "name": "my-profile"}
```
Must stop instance first or call while running (copies current state).

### POST /api/browser/profile/restore
```json
{"port": 9222, "name": "my-profile"}
```
Stops the instance, replaces profile, ready to restart.

### GET /api/browser/profile/list
Returns `{snapshots: ["my-profile", "clean-state"]}`.

---

## Extensions

### POST /api/browser/install-extension
From CRX URL: `{"port": 9222, "url": "https://...ext.crx", "name": "phantom"}`
From local path: `{"port": 9222, "path": "/path/to/unpacked", "name": "phantom"}`
Restarts the browser to load the extension.

### GET /api/browser/extensions?port=9222
### POST /api/browser/uninstall-extension
```json
{"port": 9222, "name": "phantom"}
```

---

## Emulation

### POST /api/browser/set-geolocation
Override geolocation for a tab.
```json
{"port": 9222, "tabId": "ABC", "latitude": 35.6762, "longitude": 139.6503, "accuracy": 1}
```

### POST /api/browser/set-timezone
```json
{"port": 9222, "tabId": "ABC", "timezoneId": "Asia/Tokyo"}
```

### POST /api/browser/set-locale
```json
{"port": 9222, "tabId": "ABC", "locale": "ja-JP"}
```

### POST /api/browser/set-permissions
```json
{"port": 9222, "tabId": "ABC", "permissions": ["geolocation", "camera", "microphone"]}
```

### POST /api/browser/set-offline
```json
{"port": 9222, "tabId": "ABC", "offline": true}
```

### POST /api/browser/emulate-media
```json
{"port": 9222, "tabId": "ABC", "media": "print", "colorScheme": "dark"}
```
- `media`: `"screen"`, `"print"`, or `""` to reset
- `colorScheme`: `"light"`, `"dark"`, `"no-preference"`

### POST /api/browser/add-init-script
Inject JavaScript that runs before any page script on every navigation.
```json
{"port": 9222, "tabId": "ABC", "script": "window.__INJECTED = true"}
```
Returns `{ok: true, identifier: "..."}`. Use identifier to remove later via CDP.

---

## Context Isolation

### POST /api/browser/context/create
Create an isolated BrowserContext (optional proxy).
```json
{"port": 9222, "proxy": "socks5://127.0.0.1:1080"}
```
Returns `{contextId: "XXXXXXXX"}`.

### POST /api/browser/context/open
Open a tab in an existing BrowserContext.
```json
{"port": 9222, "contextId": "XXXXXXXX", "url": "https://example.com"}
```
Returns `{tab: {id, url, ...}}`.

### POST /api/browser/context/close
Close a BrowserContext and all tabs in it.
```json
{"port": 9222, "contextId": "XXXXXXXX"}
```

---

## Clear Cookies

### POST /api/browser/clear-cookies
Clear all browser cookies.
```json
{"port": 9222, "tabId": "ABC"}
```

---

## Wait for Load State

### POST /api/browser/wait-load
Wait for page load state (`load` or `domcontentloaded`).
```json
{"port": 9222, "tabId": "ABC", "state": "load", "timeout": 30000}
```

---

## CDP Reverse Proxy

Expose Chrome's CDP to LAN. URLs are rewritten so `webSocketDebuggerUrl` points back to CDPX.

| Path | Description |
|------|-------------|
| `GET /cdp/:port/json/version` | Browser info (rewrites WS URL) |
| `GET /cdp/:port/json` | Tab list (rewrites WS URLs) |
| `WS /cdp/:port/devtools/*` | Bidirectional CDP WebSocket proxy |

Usage with Playwright:
```python
browser = playwright.chromium.connect_over_cdp("http://CDPX_IP:1024/cdp/9222?token=xxx")
```

---

## Playwright Connect

Built-in Playwright protocol adapter. Connect via `WS /pw/:port`.

```python
browser = playwright.chromium.connect("ws://CDPX_IP:1024/pw/9222?token=xxx")
page = browser.new_context().new_page()
page.goto("https://example.com")
```

Supports: `newContext`, `newPage`, `goto`, `click`, `fill`, `type`, `press`, `evaluate`, `screenshot`, `content`, `title`, `close`, `cookies`, `waitForSelector`, `setViewportSize`, and more.

---

## Generic CDP

### POST /api/browser/cdp
```json
{"port": 9222, "tabId": "ABC", "method": "Network.getCookies", "params": {}}
```
Pass any CDP command directly. See [Chrome DevTools Protocol docs](https://chromedevtools.github.io/devtools-protocol/).

---

## WebSocket

Connect to `ws://localhost:1024/ws` for real-time instance status updates.

```json
{"type": "status", "instances": [{"port": 9222, "pid": 12345, "running": true, "proxy": null}]}
```

Broadcasts on: start, stop, stop-all, restart, open, close-tab, navigate, install/uninstall extension.

### WS API Calls

Send requests via WebSocket instead of HTTP:
```json
{"id": 1, "method": "GET", "path": "/status"}
{"id": 2, "method": "POST", "path": "/click", "body": {"port": 9222, "tabId": "ABC", "ref": 3}}
```
Response: `{"id": 1, "result": {...}}`
