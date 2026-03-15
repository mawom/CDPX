# CDPX 浏览器 API

Base URL: `http://localhost:1024`

所有 POST 请求体为 JSON，所有响应为 JSON。

---

## 实例管理

### POST /api/browser/start
启动浏览器实例。
```json
{"ports": [9222], "proxy": "socks5://127.0.0.1:1080", "headless": false, "stealth": true, "fingerprint": "random"}
```
- `ports`（必填）：调试端口数组
- `proxy`：代理服务器 URL
- `headless`：无界面运行（`--headless=new`）
- `stealth`：反检测参数（默认开启）
- `fingerprint`：`"random"` 随机化视口和 User-Agent

### POST /api/browser/stop
```json
{"port": 9222}
```

### POST /api/browser/restart
参数同 `start`，用 `port` 替代 `ports`。

### POST /api/browser/stop-all
无需请求体。

### POST /api/browser/connect
连接到已运行的 Chrome/Chromium（需要 `--remote-debugging-port` 启动）。
```json
{"port": 9222}
```
返回 `{connected: true, port, browser, tabs}` 或错误提示。

### GET /api/browser/status
返回 `{instances: [{port, pid, running, proxy?}]}`。

---

## 标签页

### GET /api/browser/tabs?port=9222
返回所有标签页（页面 + 扩展）。

### POST /api/browser/open
```json
{"port": 9222, "url": "https://example.com", "name": "my-tab", "proxy": "socks5://1.2.3.4:1080"}
```
- `name`：可选，为标签页命名，用于 `tab-by-name` 查找
- `proxy`：可选，per-tab 独立代理。创建隔离的 BrowserContext，该标签页内所有导航都走此代理。支持 `http://`、`https://`、`socks5://`、`http://user:pass@host:port` 格式

### POST /api/browser/close-tab
```json
{"port": 9222, "tabId": "ABC123"}
```

### POST /api/browser/tab-name
```json
{"port": 9222, "tabId": "ABC123", "name": "my-tab"}
```

### GET /api/browser/tab-by-name?port=9222&name=my-tab
返回 `{tabId: "ABC123"}`。

---

## 读取页面

### GET /api/browser/snapshot?port=9222&id=TAB_ID&content=1
**核心端点。** 返回可交互元素树，每个元素带 `[ref=N]` 索引。
```
[1] <a href="/"> 首页
[2] <button> 登录
[3] <input placeholder="搜索...">
[4] <input type=file files=0>
```
- `content=1`：同时返回页面 Markdown 内容
- 响应：`{url, title, snapshot, refCount, content?}`

### GET /api/browser/html?port=9222&id=TAB_ID&selector=.main
获取页面或指定元素的原始 HTML。
- `selector`：可选 CSS 选择器，限定提取范围
- 返回 `{html: "<html>..."}`

### GET /api/browser/content?port=9222&id=TAB_ID
页面内容转 Markdown（穿透 Shadow DOM）。
响应包含 `state`：
```json
{"title": "...", "url": "...", "content": "# 标题\n...", "state": {
  "hasFileInput": true, "hasModal": false, "hasAlert": false,
  "hasForm": true, "hasVideo": false, "hasPassword": false,
  "scrollHeight": 3200, "scrollTop": 0, "viewportHeight": 900
}}
```

### GET /api/browser/screenshot?port=9222&id=TAB_ID
返回 `{image: "base64..."}` (JPEG)。

### GET /api/browser/pdf?port=9222&id=TAB_ID&landscape=1&scale=0.8
返回 `{pdf: "base64..."}`。

### GET /api/browser/form-state?port=9222&id=TAB_ID
所有表单字段的当前值：
```json
{"fields": [
  {"tag": "input", "type": "text", "name": "title", "ref": 18, "value": "My Project"},
  {"tag": "input", "type": "file", "name": "image", "ref": 31, "files": [{"name": "logo.png", "size": 403221}]},
  {"tag": "input", "type": "checkbox", "name": "featured", "ref": 22, "checked": true},
  {"tag": "select", "name": "category", "options": [{"value": "tech", "text": "Technology", "selected": true}]}
]}
```

### GET /api/browser/perf?port=9222&id=TAB_ID
返回 `{loadTime, domNodes, jsHeapUsedSize, jsHeapTotalSize, documents, frames, layoutCount}`。

---

## 控制页面

### POST /api/browser/click
```json
{"port": 9222, "tabId": "ABC", "ref": 3}
```
也支持 CSS 选择器：`{"port": 9222, "tabId": "ABC", "selector": "button.submit"}`
或坐标点击：`{"port": 9222, "tabId": "ABC", "x": 100, "y": 200}`
点击前自动滚动到元素可视区域。

### POST /api/browser/type
```json
{"port": 9222, "tabId": "ABC", "ref": 5, "text": "Hello World", "clear": true}
```
- `clear`：先清空已有内容（兼容 React）
- `humanLike`：true = 逐字符输入，带随机延迟
- `delayMs`：字符间基础延迟（默认 80ms，±40% 抖动）

### POST /api/browser/navigate
```json
{"port": 9222, "tabId": "ABC", "url": "https://example.com"}
```
等待 `Page.loadEventFired` 后返回。

### POST /api/browser/scroll
按元素：`{"port": 9222, "tabId": "ABC", "ref": 10}`
按像素：`{"port": 9222, "tabId": "ABC", "y": 500}`

### POST /api/browser/mouse-move
```json
{"port": 9222, "tabId": "ABC", "path": [[100,200],[300,400],[500,362]], "duration": 800}
```
模拟真实鼠标轨迹。对绕过反机器人检测很重要。

### POST /api/browser/drag
```json
{"port": 9222, "tabId": "ABC", "from": {"x": 100, "y": 200}, "to": {"x": 400, "y": 200}, "steps": 20, "duration": 500}
```
拖拽操作 — 在 `from` 按下，沿路径移动，在 `to` 释放。用于滑块验证码、拼图验证。

### POST /api/browser/keypress
```json
{"port": 9222, "tabId": "ABC", "key": "Enter"}
```
支持：enter、escape、tab、backspace、delete、space、arrowup/down/left/right 或任意单字符。

### POST /api/browser/hover
```json
{"port": 9222, "tabId": "ABC", "ref": 3}
```

### POST /api/browser/select
```json
{"port": 9222, "tabId": "ABC", "ref": 7, "value": "tech"}
```

### POST /api/browser/upload
本地文件：`{"port": 9222, "tabId": "ABC", "ref": 31, "files": ["/path/to/image.png"]}`
Base64：`{"port": 9222, "tabId": "ABC", "ref": 31, "base64": "iVBOR...", "filename": "logo.png"}`

### POST /api/browser/fill-form
```json
{"port": 9222, "tabId": "ABC", "fields": [
  {"ref": 18, "value": "My Project"},
  {"ref": 19, "value": "PROJ"},
  {"selector": "textarea", "value": "描述"}
]}
```

### POST /api/browser/wait
简单模式：`{"port": 9222, "tabId": "ABC", "selector": ".result", "timeout": 5000}`
高级条件：
```json
{"port": 9222, "tabId": "ABC", "condition": "text-appears:确认交易", "timeout": 10000}
{"port": 9222, "condition": "tab-with-url:chrome-extension://", "timeout": 10000}
```
条件类型：
- `url-contains:字符串` — 等待 URL 包含指定字符串
- `text-appears:字符串` — 等待页面出现指定文本
- `element-gone:选择器` — 等待元素消失
- `tab-with-url:模式` — 等待匹配 URL 的新标签页出现（返回 `{tabId}`）

### POST /api/browser/dismiss-dialog
```json
{"port": 9222, "tabId": "ABC", "accept": true, "text": "prompt 的回复"}
```

### POST /api/browser/auto-dismiss
```json
{"port": 9222, "tabId": "ABC", "accept": true}
```
覆盖 `window.alert/confirm/prompt`，自动关闭后续弹窗。

### POST /api/browser/viewport
```json
{"port": 9222, "tabId": "ABC", "width": 1920, "height": 1080}
```

### POST /api/browser/eval
```json
{"port": 9222, "tabId": "ABC", "expression": "document.title"}
{"port": 9222, "tabId": "ABC", "expression": "await fetch('/api/data').then(r => r.json())"}
```
支持 `await` 表达式。

### POST /api/browser/fetch
```json
{"port": 9222, "tabId": "ABC", "url": "https://api.example.com/data", "method": "GET"}
```
在浏览器上下文内执行认证请求，自动带上所有 Cookie。不加载页面。

### POST /api/browser/mock
```json
{"port": 9222, "tabId": "ABC", "patterns": [
  {"urlPattern": "api/price", "responseCode": 200, "responseBody": "{\"price\": 1.5}"}
]}
```
覆盖 `window.fetch`，对匹配 URL 返回自定义响应。

### POST /api/browser/batch
```json
{"port": 9222, "tabId": "ABC", "steps": [
  {"action": "click", "params": {"ref": 3}},
  {"action": "type", "params": {"ref": 5, "text": "Hello"}},
  {"action": "screenshot", "params": {}}
]}
```
按顺序执行，遇到错误即停止。

---

## 网络监控（F12 Network）

### POST /api/browser/network/enable
```json
{"port": 9222, "tabId": "ABC"}
```
建立持久 CDP 连接，捕获所有网络流量。

### GET /api/browser/network/requests?port=9222&id=ABC&url=api&method=POST&type=XHR
过滤请求列表，所有过滤条件可选。
```json
{"requests": [
  {"requestId": "1.1", "method": "POST", "url": "https://api.example.com/data", "type": "XHR", "status": 200, "mimeType": "application/json"}
]}
```

### GET /api/browser/network/response?port=9222&id=ABC&requestId=1.1
返回 `{body: "...", base64Encoded: false}`。

### POST /api/browser/network/clear
清空已捕获的请求。

### POST /api/browser/network/disable
停止捕获并关闭持久连接。

---

## Console 日志（F12 Console）

### POST /api/browser/console/enable
捕获 `console.log/warn/error`、JS 异常和浏览器级日志。

### GET /api/browser/console/logs?port=9222&id=ABC&level=error
```json
{"logs": [
  {"level": "error", "text": "Uncaught TypeError: Cannot read property 'x' of null", "url": "https://...", "line": 42, "timestamp": 1710000000}
]}
```

### POST /api/browser/console/clear
### POST /api/browser/console/disable

---

## Storage & Cookie

### GET /api/browser/storage?port=9222&id=ABC&type=local&key=token
- `type`：`local`（默认）或 `session`
- `key`：可选，返回单个值。不传返回全部。

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
导出所有 Cookie + localStorage，用于备份/恢复。
```json
{"cookies": [...], "localStorage": {"key": "value"}}
```

### POST /api/browser/session/import
```json
{"port": 9222, "tabId": "ABC", "cookies": [...], "localStorage": {"key": "value"}}
```

---

## 性能分析

### POST /api/browser/perf/trace
录制指定时长的性能数据。
```json
{"port": 9222, "tabId": "ABC", "duration": 3000}
```
返回 `{trace: {timing: {loadTime, domReady, firstByte}, entries: [{name, duration, startTime}], memory: {usedJSHeapSize, totalJSHeapSize}}}`。

### GET /api/browser/perf/long-tasks?port=9222&id=ABC&threshold=50
返回超过阈值（毫秒）的 JS 长任务列表。
```json
{"tasks": [{"name": "self", "duration": 120, "startTime": 4500}]}
```

### POST /api/browser/perf/inp
测量交互到下次绘制的延迟（INP）— 点击元素并测量 input-to-paint 延迟。
```json
{"port": 9222, "tabId": "ABC", "ref": 8}
```
返回 `{inp: 21, processingStart: 3, processingEnd: 18}`。

---

## 代码覆盖率

### POST /api/browser/coverage/start
开始追踪 JS 和 CSS 代码覆盖率。
```json
{"port": 9222, "tabId": "ABC"}
```

### GET /api/browser/coverage/report?port=9222&id=ABC
返回每个文件的使用统计。
```json
{"files": [
  {"url": "vendor-xxx.js", "type": "js", "used": 15200, "total": 380000, "pct": "4.0%"},
  {"url": "styles.css", "type": "css", "used": 8000, "total": 12000, "pct": "66.7%"}
]}
```

---

## 下载拦截

### POST /api/browser/download-intercept
```json
{"port": 9222, "tabId": "ABC"}
```

### GET /api/browser/downloads?port=9222&id=ABC
```json
{"downloads": [{"guid": "...", "url": "...", "filename": "report.pdf", "state": "completed", "timestamp": 1710000000}]}
```

---

## Profile 快照

保存/恢复整个浏览器状态（profile 目录 + 扩展 + IndexedDB）。

### POST /api/browser/profile/save
```json
{"port": 9222, "name": "my-profile"}
```

### POST /api/browser/profile/restore
```json
{"port": 9222, "name": "my-profile"}
```
停止实例，替换 profile，准备重启。

### GET /api/browser/profile/list
返回 `{snapshots: ["my-profile", "clean-state"]}`。

---

## 扩展管理

### POST /api/browser/install-extension
CRX URL：`{"port": 9222, "url": "https://...ext.crx", "name": "phantom"}`
本地路径：`{"port": 9222, "path": "/path/to/unpacked", "name": "phantom"}`
安装后自动重启浏览器以加载扩展。

### GET /api/browser/extensions?port=9222
### POST /api/browser/uninstall-extension
```json
{"port": 9222, "name": "phantom"}
```

---

## 通用 CDP

### POST /api/browser/cdp
```json
{"port": 9222, "tabId": "ABC", "method": "Network.getCookies", "params": {}}
```
直接传递任意 CDP 命令。参见 [Chrome DevTools Protocol 文档](https://chromedevtools.github.io/devtools-protocol/)。

---

## WebSocket

连接 `ws://localhost:1024/ws` 获取实时状态推送。

```json
{"type": "status", "instances": [{"port": 9222, "pid": 12345, "running": true, "proxy": null}]}
```

支持 WS API 调用：发送 `{id, method, path, body?}`，返回 `{id, result}`。

触发推送的操作：start、stop、stop-all、restart、open、close-tab、navigate、install/uninstall extension。
