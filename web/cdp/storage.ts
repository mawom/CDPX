import { cdpCommand } from "./shared.ts";

// --- Cookies ---
export async function getCookies(
  port: number,
  tabId: string,
): Promise<{ cookies?: any[]; error?: string }> {
  const res = await cdpCommand(port, tabId, "Network.getCookies");
  if (res.error) return { error: String(res.error) };
  return { cookies: (res.result as any)?.cookies || [] };
}

export async function setCookie(
  port: number,
  tabId: string,
  cookie: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await cdpCommand(port, tabId, "Network.setCookie", cookie);
  if (res.error) return { ok: false, error: String(res.error) };
  return { ok: (res.result as any)?.success ?? true };
}

export async function clearCookies(
  port: number,
  tabId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await cdpCommand(port, tabId, "Network.clearBrowserCookies");
  if (res.error) return { ok: false, error: String(res.error) };
  return { ok: true };
}

// --- localStorage / sessionStorage read/write ---
export async function getStorage(
  port: number,
  tabId: string,
  type: "local" | "session",
  key?: string,
): Promise<{ data?: Record<string, string> | string; error?: string }> {
  const storageObj = type === "local" ? "localStorage" : "sessionStorage";
  const expression = key
    ? `(() => { try { return ${storageObj}.getItem(${JSON.stringify(key)}); } catch { return null; } })()`
    : `(() => { try { return JSON.stringify(Object.fromEntries(Object.entries(${storageObj}))); } catch { return '{}'; } })()`;
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (res.error) return { error: String(res.error) };
  const val = (res.result as any)?.result?.value;
  if (key) return { data: val };
  try { return { data: JSON.parse(val) }; } catch { return { data: val }; }
}

export async function setStorage(
  port: number,
  tabId: string,
  type: "local" | "session",
  key: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  const storageObj = type === "local" ? "localStorage" : "sessionStorage";
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `(() => { try { ${storageObj}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; } catch(e) { return e.message; } })()`,
    returnByValue: true,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  const val = (res.result as any)?.result?.value;
  if (typeof val === "string") return { ok: false, error: val };
  return { ok: true };
}

export async function removeStorage(
  port: number,
  tabId: string,
  type: "local" | "session",
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const storageObj = type === "local" ? "localStorage" : "sessionStorage";
  const res = await cdpCommand(port, tabId, "Runtime.evaluate", {
    expression: `(() => { try { ${storageObj}.removeItem(${JSON.stringify(key)}); return true; } catch(e) { return e.message; } })()`,
    returnByValue: true,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  const rval = (res.result as any)?.result?.value;
  if (typeof rval === "string") return { ok: false, error: rval };
  return { ok: true };
}

// --- Session export/import ---
export async function exportSession(
  port: number,
  tabId: string,
): Promise<{ cookies?: any[]; localStorage?: Record<string, string>; error?: string }> {
  const [cookieRes, storageRes] = await Promise.all([
    getCookies(port, tabId),
    getStorage(port, tabId, "local"),
  ]);
  return {
    cookies: cookieRes.cookies || [],
    localStorage: (storageRes.data as Record<string, string>) || {},
  };
}

export async function importSession(
  port: number,
  tabId: string,
  data: { cookies?: any[]; localStorage?: Record<string, string> },
): Promise<{ ok: boolean; error?: string }> {
  const errors: string[] = [];
  // Import cookies
  if (data.cookies) {
    for (const cookie of data.cookies) {
      const { name, value, domain, path: cPath, secure, httpOnly, sameSite, expires } = cookie;
      const res = await cdpCommand(port, tabId, "Network.setCookie", {
        name, value, domain, path: cPath, secure, httpOnly, sameSite,
        expires: expires ?? -1,
      });
      if (res.error) errors.push(`cookie ${name}: ${String(res.error)}`);
    }
  }
  // Import localStorage
  if (data.localStorage) {
    for (const [k, v] of Object.entries(data.localStorage)) {
      const res = await setStorage(port, tabId, "local", k, v as string);
      if (res.error) errors.push(`storage ${k}: ${res.error}`);
    }
  }
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
}
