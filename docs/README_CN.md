# CDPX

[English](../README.md) | 中文

**AI 浏览器自动化平台** — 通过 REST API 控制 Chromium。零依赖。

为 AI 代理打造：看页面、点按钮、填表单、管会话 — 全部通过 HTTP 调用完成。不需要 Puppeteer、Playwright 或 Docker。

## 快速开始

```bash
# 1. 安装 Bun + Ungoogled-Chromium
curl -fsSL https://bun.sh/install | bash
brew install --cask eloston-chromium

# 2. 启动 CDPX
bun run dev

# 3. 启动浏览器实例
curl -X POST http://localhost:1024/api/browser/start \
  -H 'Content-Type: application/json' \
  -d '{"ports": [9222]}'

# 4. 打开页面（返回 tabId）
curl -X POST http://localhost:1024/api/browser/open \
  -H 'Content-Type: application/json' \
  -d '{"port": 9222, "url": "https://example.com"}'

# 5. 查看页面内容
curl "http://localhost:1024/api/browser/snapshot?port=9222&id=TAB_ID&content=1"
```

## 工作流

```
snapshot?content=1  →  获取可交互元素: [1] <button> 提交, [2] <input> 姓名...
click {ref: 2}      →  点击输入框
type {ref: 2, text}  →  输入文本
snapshot?content=1  →  确认结果
```

**snapshot** 返回带 `[ref=N]` 编号的可交互元素树。读取 snapshot，按 ref 编号调用 click/type/select。不需要 CSS 选择器、XPath 或浏览器 SDK。

## API 概览（80+ 个端点）

完整文档：`GET /api/browser/docs`

### 实例管理
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/start` | 启动 `{ports, proxy?, headless?, stealth?, fingerprint?}` |
| POST | `/api/browser/stop` | 停止 `{port}` |
| POST | `/api/browser/restart` | 重启 |
| POST | `/api/browser/connect` | 连接已有浏览器 `{port}` |
| GET | `/api/browser/status` | 运行中的实例 |

### 读取页面
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/browser/snapshot` | 可交互元素树 `[ref=N]` + 可选 Markdown |
| GET | `/api/browser/content` | 页面内容转 Markdown + 页面状态 |
| GET | `/api/browser/screenshot` | 截图（base64 JPEG）|
| GET | `/api/browser/pdf` | 导出 PDF |
| GET | `/api/browser/html` | 原始 HTML（支持 selector 范围）|
| GET | `/api/browser/form-state` | 表单字段状态 |
| GET | `/api/browser/perf` | 性能指标 |

### 控制页面
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/click` | 点击 `{ref}` / `{selector}` / `{x, y}` |
| POST | `/api/browser/type` | 输入 `{humanLike?, delayMs?}` 支持反检测逐字输入 |
| POST | `/api/browser/navigate` | 导航并等待加载 |
| POST | `/api/browser/scroll` | 滚动到元素或按像素 |
| POST | `/api/browser/mouse-move` | 鼠标轨迹模拟 |
| POST | `/api/browser/drag` | 拖拽 `{from, to, steps?, duration?}` |
| POST | `/api/browser/keypress` | 按键（Enter、Escape、Tab 等）|
| POST | `/api/browser/hover` | 悬停 |
| POST | `/api/browser/select` | 下拉选择 |
| POST | `/api/browser/upload` | 文件上传（本地路径或 base64）|
| POST | `/api/browser/fill-form` | 批量填表 |
| POST | `/api/browser/wait` | 等待元素 / 条件 / 延时 |
| POST | `/api/browser/eval` | 执行 JS（支持 await）|
| POST | `/api/browser/viewport` | 设置视口大小 |
| POST | `/api/browser/fetch` | 浏览器内 fetch（带 Cookie）|
| POST | `/api/browser/mock` | 请求 mock |
| POST | `/api/browser/batch` | 批量步骤执行 |
| POST | `/api/browser/wait-load` | 等待页面加载状态 `{state?}` |

### 模拟/仿真
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/set-geolocation` | 覆盖地理位置 `{latitude, longitude}` |
| POST | `/api/browser/set-timezone` | 覆盖时区 `{timezoneId}` |
| POST | `/api/browser/set-locale` | 覆盖语言区域 `{locale}` |
| POST | `/api/browser/set-permissions` | 授予权限 `{permissions: [...]}` |
| POST | `/api/browser/set-offline` | 切换离线模式 `{offline}` |
| POST | `/api/browser/emulate-media` | CSS 媒体仿真 `{media?, colorScheme?}` |
| POST | `/api/browser/add-init-script` | 每次导航前注入脚本 `{script}` |

### Context 隔离
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/context/create` | 创建独立 BrowserContext `{port, proxy?}` |
| POST | `/api/browser/context/open` | 在 Context 中打开标签页 `{port, contextId, url?}` |
| POST | `/api/browser/context/close` | 关闭 Context + 所有标签页 `{port, contextId}` |

### 性能分析
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/perf/trace` | 录制性能数据 `{duration?}` |
| GET | `/api/browser/perf/long-tasks` | 超过阈值的长任务 `?threshold=50` |
| POST | `/api/browser/perf/inp` | 测量 Interaction to Next Paint `{ref}` |
| POST | `/api/browser/coverage/start` | 开始 JS/CSS 覆盖率追踪 |
| GET | `/api/browser/coverage/report` | 每文件使用率统计 |

### 开发者工具
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/network/enable` | 开启流量捕获（F12 Network）|
| GET | `/api/browser/network/requests` | 请求列表（支持过滤）|
| GET | `/api/browser/network/response` | 响应体 |
| POST | `/api/browser/console/enable` | 开启日志捕获（F12 Console）|
| GET | `/api/browser/console/logs` | 日志列表 |

### 存储 & 会话
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/browser/cookies` | 获取 Cookie |
| POST | `/api/browser/set-cookie` | 设置 Cookie |
| POST | `/api/browser/clear-cookies` | 清除所有 Cookie |
| GET | `/api/browser/storage` | 读取 localStorage/sessionStorage |
| POST | `/api/browser/storage/set` | 写入 Storage |
| GET | `/api/browser/session/export` | 导出 Cookie + localStorage |
| POST | `/api/browser/session/import` | 恢复会话 |

### 扩展管理
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/install-extension` | 安装（CRX URL 或本地路径）|
| GET | `/api/browser/extensions` | 已安装列表 |
| POST | `/api/browser/uninstall-extension` | 卸载 |

### 标签页
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/browser/tabs` | 标签页列表 |
| POST | `/api/browser/open` | 打开标签页 `{url?, name?, proxy?}` 支持 per-tab 独立代理 |
| GET | `/api/browser/tab-by-name` | 按名字查找标签页 |
| POST | `/api/browser/cdp` | 通用 CDP 命令透传 |

### Profile 快照
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/browser/profile/save` | 保存浏览器完整状态 |
| POST | `/api/browser/profile/restore` | 恢复 |
| GET | `/api/browser/profile/list` | 快照列表 |

## 反检测（Stealth）

默认开启，双层防护：

**启动参数层：** `--disable-blink-features=AutomationControlled` + 11 个 Chrome 特性标志。

**JS 注入层：** 每个新页面自动修补 `navigator.webdriver`、`navigator.plugins`、`window.chrome`、`Permissions.query`。

**指纹随机化：** `{fingerprint: "random"}` 启动时随机化视口和 User-Agent。

## Per-Tab 独立代理

同一浏览器实例内，不同标签页可走不同代理：

```bash
# 日本代理
curl -X POST http://localhost:1024/api/browser/open \
  -d '{"port":9222, "url":"https://x.com", "proxy":"socks5://jp:1080"}'

# 美国代理
curl -X POST http://localhost:1024/api/browser/open \
  -d '{"port":9222, "url":"https://x.com", "proxy":"http://us:8080"}'
```

支持 `http://`、`https://`、`socks5://`、`http://user:pass@host:port`。

## CDP 反向代理

通过 CDPX 将 Chrome CDP 暴露到局域网，兼容 Playwright `connect_over_cdp()`：

```python
browser = playwright.chromium.connect_over_cdp("http://CDPX_IP:1024/cdp/9222?token=xxx")
```

| 路径 | 说明 |
|------|------|
| `GET /cdp/:port/json/version` | 浏览器信息（重写 `webSocketDebuggerUrl`）|
| `GET /cdp/:port/json` | 标签页列表（重写 WS URL）|
| `WS /cdp/:port/devtools/*` | 双向 CDP WebSocket 代理 |

## Playwright Connect

内置 Playwright 协议适配器，支持 `connect()` 直连：

```python
browser = playwright.chromium.connect("ws://CDPX_IP:1024/pw/9222?token=xxx")
page = browser.new_context().new_page()
page.goto("https://example.com")
```

## WebSocket 实时推送

```js
const ws = new WebSocket('ws://localhost:1024/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // {type: "status", instances: [...]}
};
```

## 架构

```
cdpx/
├── web/
│   ├── server.ts        # HTTP + WebSocket 服务
│   ├── mcp.ts           # MCP 协议服务（stdio）
│   ├── cdp/             # CDP API 模块
│   │   ├── index.ts     # 路由分发
│   │   ├── shared.ts    # 常量、类型、CDP 连接
│   │   ├── instance.ts  # 启动/停止/反检测
│   │   ├── page.ts      # snapshot/content/截图/PDF
│   │   ├── action.ts    # click/type/scroll/navigate/wait
│   │   ├── monitor.ts   # 网络/Console/下载监控
│   │   ├── storage.ts   # Cookie/Storage/Session
│   │   ├── extension.ts # 扩展管理
│   │   ├── proxy.ts     # Per-tab 代理 + Context 隔离
│   │   ├── profile.ts   # Profile 快照
│   │   ├── perf.ts      # 性能追踪 + 覆盖率
│   │   ├── playwright.ts # Playwright connect() 协议适配
│   │   └── batch.ts     # 批量执行
│   └── public/          # 管理面板
└── browser/             # 运行时数据（gitignored）
```

- **零 npm 依赖** — 纯 Bun API + `node:crypto`、`node:child_process`
- **原生 CDP** — 直连 Chromium WebSocket，不用 Puppeteer/Playwright
- **Bun** — 原生 TypeScript，快速启动，内置测试
- **模块化** — 按功能拆分为 13 个模块

## 环境要求

- **Bun**: `curl -fsSL https://bun.sh/install | bash`
- **Ungoogled-Chromium**: `brew install --cask eloston-chromium`
  - 或通过 `CHROMIUM_BIN` 环境变量指定路径

## 运行

```bash
bun run dev      # 开发（热重载）
bun run start    # 生产（pm2 守护进程）
bun run stop     # 停止
bun run restart  # 重启
bun run logs     # 查看日志
bun test         # 运行测试
```

## 许可证

MIT
