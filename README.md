# CDPX

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1.svg)](https://bun.sh)

[中文](./docs/README_CN.md) | English

**AI browser automation platform** — control Chromium via REST API. Zero dependencies.

Built for AI agents that need to browse the web: see pages, click buttons, fill forms, manage sessions — all through simple HTTP calls. No Puppeteer, no Playwright, no Docker.


## Quick Start

```bash
# 1. Install Bun + Ungoogled-Chromium
curl -fsSL https://bun.sh/install | bash
brew install --cask eloston-chromium

# 2. Start CDPX
bun run dev

# 3. Launch a browser instance
curl -X POST http://localhost:1024/api/browser/start \
  -H 'Content-Type: application/json' \
  -d '{"ports": [9222]}'

# 4. Open a page (returns tabId)
curl -X POST http://localhost:1024/api/browser/open \
  -H 'Content-Type: application/json' \
  -d '{"port": 9222, "url": "https://example.com"}'

# 5. See what's on the page (use tabId from step 4)
curl "http://localhost:1024/api/browser/snapshot?port=9222&id=TAB_ID&content=1"
```

## Workflow

```
snapshot?content=1  →  See interactive elements: [1] <button> Submit, [2] <input> Name...
click {ref: 2}      →  Click the input field
type {ref: 2, text}  →  Type into it
snapshot?content=1  →  Confirm the result
```

The **snapshot** returns a tree of interactive elements with `[ref=N]` IDs. Read the snapshot, pick an element by ref, and call click/type/select. No CSS selectors, no XPath, no browser SDK needed.

## API Overview (~60 endpoints)

### Instance Management
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/browser/start` | Start browser `{ports, proxy?, headless?, stealth?, fingerprint?}` |
| POST | `/api/browser/stop` | Stop instance `{port}` |
| POST | `/api/browser/restart` | Restart `{port, proxy?, headless?, stealth?, fingerprint?}` |
| POST | `/api/browser/connect` | Connect to existing browser `{port}` |
| GET | `/api/browser/status` | Running instances |

### Read Page
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/browser/snapshot` | Interactive element tree with `[ref=N]` + optional Markdown |
| GET | `/api/browser/content` | Page content as Markdown + page state |
| GET | `/api/browser/screenshot` | Screenshot (base64 JPEG) |
| GET | `/api/browser/pdf` | Export PDF |
| GET | `/api/browser/html` | Raw HTML `?selector=` |
| GET | `/api/browser/form-state` | All form field values + file status |

### Control Page
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/browser/click` | Click element `{ref}` or `{selector}` |
| POST | `/api/browser/type` | Type text `{humanLike?, delayMs?}` for anti-detection |
| POST | `/api/browser/navigate` | Navigate + wait for load |
| POST | `/api/browser/scroll` | Scroll to element or by pixels |
| POST | `/api/browser/mouse-move` | Mouse trajectory simulation |
| POST | `/api/browser/drag` | Drag and drop `{from, to, steps?, duration?}` |
| POST | `/api/browser/keypress` | Keyboard (Enter, Escape, Tab, etc.) |
| POST | `/api/browser/hover` | Hover |
| POST | `/api/browser/select` | Dropdown select |
| POST | `/api/browser/upload` | File upload (local path or base64) |
| POST | `/api/browser/fill-form` | Batch form fill |
| POST | `/api/browser/wait` | Wait for element, condition, or delay |
| POST | `/api/browser/eval` | Execute JS (supports await) |
| POST | `/api/browser/viewport` | Set viewport size |
| POST | `/api/browser/fetch` | Authenticated fetch (uses browser cookies) |
| POST | `/api/browser/mock` | Mock HTTP requests |
| POST | `/api/browser/batch` | Execute multiple steps |

### Performance Analysis
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/browser/perf/trace` | Record performance trace `{duration?}` |
| GET | `/api/browser/perf/long-tasks` | Long tasks exceeding threshold `?threshold=50` |
| POST | `/api/browser/perf/inp` | Measure Interaction to Next Paint `{ref}` |
| POST | `/api/browser/coverage/start` | Start JS/CSS coverage tracking |
| GET | `/api/browser/coverage/report` | Per-file usage statistics |

### DevTools
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/browser/network/enable` | Start network capture (F12 Network) |
| GET | `/api/browser/network/requests` | Request list (filter by url/method/type) |
| GET | `/api/browser/network/response` | Response body |
| POST | `/api/browser/console/enable` | Start console capture (F12 Console) |
| GET | `/api/browser/console/logs` | Console logs (filter by level) |
| GET | `/api/browser/perf` | Performance metrics |

### Storage & Session
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/browser/cookies` | Get cookies |
| POST | `/api/browser/set-cookie` | Set cookie |
| GET | `/api/browser/storage` | Read localStorage/sessionStorage |
| POST | `/api/browser/storage/set` | Write storage |
| GET | `/api/browser/session/export` | Export cookies + localStorage |
| POST | `/api/browser/session/import` | Restore session |

### Extensions
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/browser/install-extension` | Install from CRX URL or local path |
| GET | `/api/browser/extensions` | List installed |
| POST | `/api/browser/uninstall-extension` | Uninstall |

### Tabs & Generic
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/browser/tabs` | Tab list |
| POST | `/api/browser/open` | Open tab `{url?, name?, proxy?}` — proxy enables per-tab proxy |
| GET | `/api/browser/tab-by-name` | Find tab by name |
| POST | `/api/browser/cdp` | Raw CDP command passthrough |

### Profile Snapshots
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/browser/profile/save` | Save full browser state `{port, name}` |
| POST | `/api/browser/profile/restore` | Restore `{port, name}` |
| GET | `/api/browser/profile/list` | List snapshots |

## Anti-Detection (Stealth)

Enabled by default. Two layers:

**Launch flags:** `--disable-blink-features=AutomationControlled` + 11 Chrome feature flags that suppress automation signals.

**JS injection:** Patches `navigator.webdriver`, `navigator.plugins`, `window.chrome`, `Permissions.query` on every new page via `Page.addScriptToEvaluateOnNewDocument`.

**Fingerprint randomization:** `{fingerprint: "random"}` randomizes viewport size and User-Agent on start.

## WebSocket

Real-time status updates:

```js
const ws = new WebSocket('ws://localhost:1024/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // msg = {type: "status", instances: [...]}
};
```

Broadcasts on: start, stop, restart, open, close-tab, navigate, install/uninstall extension.

## Architecture

```
cdpx/
├── web/
│   ├── server.ts        # HTTP + WebSocket server
│   ├── mcp.ts           # MCP protocol server (stdio)
│   ├── cdp/             # CDP API modules
│   │   ├── index.ts     # Route dispatcher
│   │   ├── shared.ts    # Constants, types, CDP connection
│   │   ├── instance.ts  # Start/stop/restart/stealth
│   │   ├── page.ts      # Snapshot/content/screenshot/pdf
│   │   ├── action.ts    # Click/type/scroll/navigate/wait
│   │   ├── monitor.ts   # Network/console/download capture
│   │   ├── storage.ts   # Cookie/storage/session
│   │   ├── extension.ts # Extension install/uninstall
│   │   ├── proxy.ts     # Per-tab proxy
│   │   ├── profile.ts   # Profile snapshots
│   │   ├── perf.ts      # Performance tracing + coverage
│   │   └── batch.ts     # Batch execution
│   └── public/          # Management UI
└── browser/             # Runtime data (gitignored)
```

- **Zero npm dependencies** — pure `node:http`, `node:crypto`, `node:child_process`
- **Raw CDP** — direct WebSocket to Chromium, no Puppeteer/Playwright layer
- **Bun** — native TypeScript, fast startup, built-in test runner
- **Modular** — 11 modules split by function, easy to hack

## Requirements

- **Bun**: `curl -fsSL https://bun.sh/install | bash`
- **Ungoogled-Chromium**: `brew install --cask eloston-chromium`
  - Or set `CHROMIUM_BIN` env var for custom path

## Testing

```bash
bun test
```

## License

MIT
