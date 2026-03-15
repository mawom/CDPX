import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDirs, EXTENSIONS_DIR, loadMeta, saveMeta, sanitizeExtName } from "./shared.ts";

export interface ExtensionInfo {
  name: string;
  extName?: string;
  version?: string;
}

export async function downloadCrx(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("download returned HTML (expected CRX/ZIP)");
  return Buffer.from(await res.arrayBuffer());
}

export function extractCrx(crxBuf: Buffer, destDir: string): void {
  // CRX3: "Cr24" + version(4) + header_length(4) + header + ZIP
  // Find ZIP start by locating PK\x03\x04 signature
  let zipStart = -1;
  for (let i = 0; i < Math.min(crxBuf.length, 100000); i++) {
    if (crxBuf[i] === 0x50 && crxBuf[i + 1] === 0x4b &&
        crxBuf[i + 2] === 0x03 && crxBuf[i + 3] === 0x04) {
      zipStart = i;
      break;
    }
  }
  if (zipStart === -1) throw new Error("invalid CRX: ZIP signature not found");

  const zipBuf = crxBuf.subarray(zipStart);
  const tmpZip = path.join(os.tmpdir(), `cdpx-ext-${Date.now()}.zip`);
  try {
    fs.writeFileSync(tmpZip, zipBuf);
    fs.mkdirSync(destDir, { recursive: true });
    // Use spawnSync (no shell) to avoid command injection
    // -o: overwrite, -q: quiet, -x: exclude dangerous paths
    const { status } = spawnSync("unzip", ["-o", "-q", tmpZip, "-d", destDir, "-x", "../*", "*/../*"], {
      stdio: "ignore",
    });
    if (status !== 0) throw new Error("unzip failed");
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
}

export function getExtensionInfo(name: string): ExtensionInfo | null {
  const extDir = path.join(EXTENSIONS_DIR, name);
  if (!extDir.startsWith(EXTENSIONS_DIR + path.sep)) return null;
  const manifestPath = path.join(extDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return { name, extName: manifest.name, version: manifest.version };
  } catch {
    return { name };
  }
}

export function getProfileExtensions(port: number): string[] {
  const meta = loadMeta(port);
  return Array.isArray(meta.extensions) ? meta.extensions as string[] : [];
}

export function getExtensionLoadArg(port: number): string | null {
  const names = getProfileExtensions(port);
  const paths: string[] = [];
  for (const name of names) {
    const extPath = path.join(EXTENSIONS_DIR, name);
    if (!extPath.startsWith(EXTENSIONS_DIR + path.sep)) continue;
    if (fs.existsSync(path.join(extPath, "manifest.json"))) {
      paths.push(extPath);
    }
  }
  return paths.length > 0 ? paths.join(",") : null;
}

export async function installExtension(
  port: number,
  opts: { url?: string; path?: string; name?: string },
  startInstanceFn: (port: number, opts?: any) => any,
  stopInstanceFn: (port: number) => boolean,
): Promise<ExtensionInfo> {
  ensureDirs();

  let extName: string;
  if (opts.path) {
    // Local unpacked extension — copy to extensions dir
    const src = opts.path;
    if (!fs.existsSync(path.join(src, "manifest.json"))) {
      throw new Error("path does not contain manifest.json");
    }
    extName = sanitizeExtName(opts.name || path.basename(src));
    const dest = path.join(EXTENSIONS_DIR, extName);
    if (!dest.startsWith(EXTENSIONS_DIR + path.sep)) throw new Error("invalid extension name");
    if (path.resolve(dest) !== path.resolve(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  } else if (opts.url) {
    // Download CRX
    const buf = await downloadCrx(opts.url);
    extName = sanitizeExtName(opts.name || `ext-${Date.now()}`);
    const dest = path.join(EXTENSIONS_DIR, extName);
    if (!dest.startsWith(EXTENSIONS_DIR + path.sep)) throw new Error("invalid extension name");
    extractCrx(buf, dest);
  } else {
    throw new Error("url or path required");
  }

  // Add to profile meta
  const meta = loadMeta(port);
  const extensions = Array.isArray(meta.extensions) ? meta.extensions as string[] : [];
  if (!extensions.includes(extName)) {
    extensions.push(extName);
    saveMeta(port, { ...meta, extensions });
  }

  // Restart browser to load extension
  const currentMeta = loadMeta(port);
  stopInstanceFn(port);
  await new Promise((r) => setTimeout(r, 500));
  startInstanceFn(port, {
    proxy: currentMeta.proxy as string | undefined,
    headless: currentMeta.headless as boolean | undefined,
    stealth: currentMeta.stealth as boolean | undefined,
    fingerprint: currentMeta.fingerprint as "random" | "default" | undefined,
  });

  return getExtensionInfo(extName) || { name: extName };
}

export function uninstallExtension(port: number, name: string): boolean {
  const meta = loadMeta(port);
  const extensions = Array.isArray(meta.extensions) ? meta.extensions as string[] : [];
  const idx = extensions.indexOf(name);
  if (idx === -1) return false;
  extensions.splice(idx, 1);
  saveMeta(port, { ...meta, extensions });
  // Remove extension files from disk
  const extDir = path.join(EXTENSIONS_DIR, sanitizeExtName(name));
  if (extDir.startsWith(EXTENSIONS_DIR + path.sep) && fs.existsSync(extDir)) {
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch {}
  }
  return true;
}

export function listExtensions(port: number): ExtensionInfo[] {
  const names = getProfileExtensions(port);
  return names.map((n) => getExtensionInfo(n)).filter(Boolean) as ExtensionInfo[];
}
