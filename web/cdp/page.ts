import { cdpCommand, cdpSession } from "./shared.ts";

// Injected into the page via Runtime.evaluate to extract content as markdown
// Pierces Shadow DOM to handle Web Components (chrome:// pages, extensions, etc.)
export const CONTENT_EXTRACT_SCRIPT = `(() => {
  const REMOVE_TAGS = new Set(['script','style','noscript','svg','iframe','link','meta','template']);
  const SKIP_ROLES = new Set(['navigation','banner','contentinfo']);

  function shouldRemove(node) {
    if (REMOVE_TAGS.has(node.tagName?.toLowerCase())) return true;
    const role = node.getAttribute?.('role');
    if (role && SKIP_ROLES.has(role)) return true;
    if (node.getAttribute?.('aria-hidden') === 'true') return true;
    return false;
  }

  // Get child nodes, piercing into Shadow DOM
  function children(node) {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    // <slot> — get assigned nodes (slotted content)
    if (node.tagName === 'SLOT' && node.assignedNodes) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  }

  function text(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (shouldRemove(node)) return '';
    const tag = node.tagName.toLowerCase();
    const kids = () => children(node).map(text).join('');

    if (tag === 'br') return '\\n';
    if (tag === 'hr') return '\\n---\\n';
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]);
      const t = kids().trim();
      return t ? '\\n' + '#'.repeat(level) + ' ' + t + '\\n\\n' : '';
    }
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main') {
      const t = kids().trim();
      return t ? '\\n' + t + '\\n' : '';
    }
    if (tag === 'blockquote') {
      const t = kids().trim();
      return t ? '\\n' + t.split('\\n').map(l => '> ' + l).join('\\n') + '\\n' : '';
    }
    if (tag === 'pre') {
      const code = node.querySelector('code');
      const lang = code?.className?.match(/language-(\\w+)/)?.[1] || '';
      const t = (code || node).textContent.trim();
      return '\\n\\\`\\\`\\\`' + lang + '\\n' + t + '\\n\\\`\\\`\\\`\\n';
    }
    if (tag === 'code' && node.parentElement?.tagName !== 'PRE') {
      const t = node.textContent;
      return t ? '\\\`' + t + '\\\`' : '';
    }
    if (tag === 'a') {
      const t = kids().trim();
      const href = node.getAttribute('href') || '';
      if (!t) return '';
      if (!href || href.startsWith('javascript:') || href === '#') return t;
      return '[' + t.replace(/[\\[\\]]/g, '') + '](' + href.replace(/\\)/g, '%29') + ')';
    }
    if (tag === 'img') {
      const alt = (node.getAttribute('alt') || '').replace(/[\\[\\]]/g, '');
      const src = (node.getAttribute('src') || '').replace(/\\)/g, '%29');
      return src ? '![' + alt + '](' + src + ')' : '';
    }
    if (tag === 'strong' || tag === 'b') {
      const t = kids().trim();
      return t ? '**' + t + '**' : '';
    }
    if (tag === 'em' || tag === 'i') {
      const t = kids().trim();
      return t ? '*' + t + '*' : '';
    }
    if (tag === 'del' || tag === 's') {
      const t = kids().trim();
      return t ? '~~' + t + '~~' : '';
    }
    if (tag === 'details') {
      // Only show summary unless details is open
      const summary = children(node).find(c => c.nodeType === 1 && c.tagName === 'SUMMARY');
      if (node.open) return kids();
      return summary ? text(summary) : '';
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = children(node).filter(c => c.nodeType === 1 && c.tagName === 'LI');
      const lines = items.map((li, i) => {
        const prefix = tag === 'ol' ? (i + 1) + '. ' : '- ';
        return prefix + text(li).trim().replace(/\\n/g, '\\n  ');
      });
      return '\\n' + lines.join('\\n') + '\\n';
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (!rows.length) return '';
      const matrix = rows.map(r =>
        Array.from(r.querySelectorAll('th,td')).map(c => text(c).trim().replace(/\\|/g, '\\\\|').replace(/\\n/g, ' '))
      ).filter(r => r.length > 0);
      if (!matrix.length) return '';
      const colCount = Math.max(...matrix.map(r => r.length));
      const padded = matrix.map(r => { while (r.length < colCount) r.push(''); return r; });
      let md = '\\n| ' + padded[0].join(' | ') + ' |\\n';
      md += '| ' + padded[0].map(() => '---').join(' | ') + ' |\\n';
      for (let i = 1; i < padded.length; i++) {
        md += '| ' + padded[i].join(' | ') + ' |\\n';
      }
      return md;
    }
    if (tag === 'li') return kids();
    return kids();
  }

  let md = text(document.body || document.documentElement).trim();
  md = md.replace(/\\n{3,}/g, '\\n\\n');

  // Structured page state for AI decision-making
  const body = document.body || document.documentElement;
  const state = {
    hasFileInput: !!body.querySelector('input[type=file]'),
    hasModal: !!(body.querySelector('[role=dialog]') || body.querySelector('.modal') || body.querySelector('[aria-modal=true]')),
    hasAlert: !!(body.querySelector('[role=alert]') || body.querySelector('[role=alertdialog]')),
    hasForm: !!body.querySelector('form'),
    hasVideo: !!body.querySelector('video'),
    hasPassword: !!body.querySelector('input[type=password]'),
    scrollHeight: document.documentElement.scrollHeight,
    scrollTop: document.documentElement.scrollTop,
    viewportHeight: window.innerHeight,
  };
  return JSON.stringify({ title: document.title, url: location.href, content: md, state });
})()`;

export async function getContent(
  port: number,
  tabId: string,
): Promise<{ title: string; url: string; content: string } | null> {
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: CONTENT_EXTRACT_SCRIPT,
    returnByValue: true,
  });
  try {
    const val = (res.result as any)?.result?.value;
    if (!val) return null;
    return JSON.parse(val);
  } catch {
    return null;
  }
}

// --- Snapshot: interactive element tree with [ref=N] indices ---
export const SNAPSHOT_SCRIPT = `(() => {
  const INTERACTIVE = new Set(['a','button','input','select','textarea','details','summary']);
  const INTERACTIVE_ROLES = new Set(['button','link','checkbox','radio','tab','switch','menuitem','menuitemcheckbox','menuitemradio','option','combobox','textbox','searchbox','slider','spinbutton','treeitem','gridcell']);
  const SKIP = new Set(['script','style','noscript','link','meta','svg','template']);
  let nextRef = 1;

  // Clear stale refs from previous snapshot (pierce shadow DOM)
  function clearRefs(root) {
    root.querySelectorAll('[data-cdpx-ref]').forEach(el => {
      delete el.dataset.cdpxRef;
      if (el.shadowRoot) clearRefs(el.shadowRoot);
    });
  }
  clearRefs(document);

  function children(node) {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (node.tagName === 'SLOT' && node.assignedNodes) {
      const a = node.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    return Array.from(node.childNodes);
  }

  function isInteractive(el) {
    const tag = el.tagName?.toLowerCase();
    if (INTERACTIVE.has(tag)) return true;
    const role = el.getAttribute?.('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.getAttribute?.('contenteditable') === 'true') return true;
    return false;
  }

  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    try {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch { return true; }
  }

  function walk(node, indent, skipText) {
    if (node.nodeType === 3) {
      if (skipText) return ''; // Parent interactive element already printed this text
      const t = node.textContent.trim();
      return t ? indent + t + '\\n' : '';
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return '';

    let out = '';
    const interactive = isInteractive(node) && isVisible(node);

    if (interactive) {
      const ref = nextRef++;
      node.dataset.cdpxRef = String(ref);
      const role = node.getAttribute('role') || tag;
      let label = '';
      if (tag === 'input' || tag === 'textarea') {
        const tp = node.type || 'text';
        label = tp !== 'text' ? 'type=' + tp + ' ' : '';
        if (tp === 'file' && node.files) label += 'files=' + node.files.length + ' ';
        if (node.placeholder) label += 'placeholder="' + node.placeholder.replace(/"/g, '\\\\"') + '" ';
        if (node.value && tp !== 'file') label += 'value="' + node.value.slice(0,40).replace(/"/g, '\\\\"') + '" ';
      } else if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        if (href && href !== '#') label = 'href="' + href.replace(/"/g, '\\\\"') + '" ';
      } else if (tag === 'select') {
        label = 'value="' + (node.value || '').replace(/"/g, '\\\\"') + '" ';
      }
      const ariaLabel = node.getAttribute('aria-label');
      if (ariaLabel) label += 'aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '" ';
      if (node.disabled) label += 'disabled ';
      const rawText = node.textContent?.trim().replace(/\\s+/g, ' ') || '';
      const text = rawText.length > 80 ? rawText.slice(0, 77) + '...' : rawText;
      out += indent + '[' + ref + '] <' + role + (label ? ' ' + label.trim() : '') + '>' + (text ? ' ' + text : '') + '\\n';
    }

    // Skip child text of interactive elements (already included in the ref line)
    const childSkipText = interactive;
    const nextIndent = interactive ? indent + '  ' : indent;
    for (const child of children(node)) {
      out += walk(child, nextIndent, childSkipText);
    }
    return out;
  }

  const snapshot = walk(document.body || document.documentElement, '', false);
  return JSON.stringify({ url: location.href, title: document.title, snapshot: snapshot.trim(), refCount: nextRef - 1 });
})()`;

export async function getSnapshot(
  port: number,
  tabId: string,
): Promise<{ url: string; title: string; snapshot: string; refCount: number } | null> {
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: SNAPSHOT_SCRIPT,
    returnByValue: true,
  });
  try {
    return JSON.parse((res.result as any)?.result?.value);
  } catch {
    return null;
  }
}

export async function getScreenshot(
  port: number,
  tabId: string,
): Promise<string | null> {
  const res = await cdpCommand(port, tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 50,
  });
  return (res.result as any)?.data ?? null;
}

export async function getPdf(
  port: number,
  tabId: string,
  opts?: { landscape?: boolean; scale?: number },
): Promise<string | null> {
  const res = await cdpCommand(port, tabId, "Page.printToPDF", {
    landscape: opts?.landscape ?? false,
    printBackground: true,
    scale: opts?.scale ?? 1,
    paperWidth: 8.27, // A4
    paperHeight: 11.69,
    marginTop: 0.4,
    marginBottom: 0.4,
    marginLeft: 0.4,
    marginRight: 0.4,
  });
  return (res.result as any)?.data ?? null;
}

export async function getFormState(
  port: number,
  tabId: string,
): Promise<{ fields?: any[]; error?: string }> {
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `(() => {
      const fields = [];
      document.querySelectorAll('input, textarea, select').forEach(el => {
        const f = {
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || el.id || el.placeholder || '',
          ref: el.dataset?.cdpxRef ? Number(el.dataset.cdpxRef) : undefined,
        };
        if (el.type === 'file') {
          f.files = Array.from(el.files || []).map(fi => ({ name: fi.name, size: fi.size, type: fi.type }));
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          f.checked = el.checked;
        } else {
          f.value = el.value || '';
        }
        if (el.tagName === 'SELECT') {
          f.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
        }
        fields.push(f);
      });
      return JSON.stringify(fields);
    })()`,
    returnByValue: true,
  });
  try {
    const val = (res.result as any)?.result?.value;
    return { fields: JSON.parse(val) };
  } catch {
    return { error: res.error ? String(res.error) : "form state extraction failed" };
  }
}

export async function getPerfMetrics(
  port: number,
  tabId: string,
): Promise<Record<string, unknown>> {
  const res = await cdpSession(port, tabId, async ({ send }) => {
    await send("Performance.enable");
    const { metrics } = await send("Performance.getMetrics");
    const m: Record<string, number> = {};
    for (const { name, value } of metrics as { name: string; value: number }[]) {
      m[name] = value;
    }
    // Also get DOM node count and JS heap
    const { result } = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ domNodes: document.querySelectorAll('*').length, url: location.href })`,
      returnByValue: true,
    });
    let extra: any = {};
    try { extra = JSON.parse(result?.value || "{}"); } catch {}
    return {
      loadTime: Math.round((m.NavigationStart > 0 && m.DomContentLoaded > 0) ? (m.DomContentLoaded - m.NavigationStart) * 1000 : 0),
      domNodes: extra.domNodes || 0,
      jsHeapUsedSize: Math.round((m.JSHeapUsedSize || 0) / 1024 / 1024 * 10) / 10,
      jsHeapTotalSize: Math.round((m.JSHeapTotalSize || 0) / 1024 / 1024 * 10) / 10,
      documents: m.Documents || 0,
      frames: m.Frames || 0,
      layoutCount: m.LayoutCount || 0,
    };
  });
  if (res.error) return { error: res.error };
  return res.result;
}

export async function getHtml(
  port: number,
  tabId: string,
  selector?: string,
): Promise<{ html?: string; error?: string }> {
  const expression = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || null`
    : `document.documentElement.outerHTML`;
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  const html = (res.result as any)?.result?.value;
  if (!html) return { error: selector ? "selector not found" : "html extraction failed" };
  return { html };
}
