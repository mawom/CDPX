import fs from "node:fs";
import path from "node:path";
import { PROFILES_DIR, SNAPSHOTS_DIR, sanitizeExtName, loadMeta, saveMeta } from "./shared.ts";
import { stopInstance } from "./instance.ts";

export function saveProfileSnapshot(port: number, name: string): { ok: boolean; error?: string } {
  const safeName = sanitizeExtName(name);
  const profileDir = path.join(PROFILES_DIR, String(port));
  const snapDir = path.join(SNAPSHOTS_DIR, safeName);
  if (!snapDir.startsWith(SNAPSHOTS_DIR + path.sep)) return { ok: false, error: "invalid snapshot name" };
  if (!fs.existsSync(profileDir)) return { ok: false, error: "profile not found" };
  fs.cpSync(profileDir, snapDir, { recursive: true });
  // Also save meta
  const meta = loadMeta(port);
  fs.writeFileSync(path.join(snapDir, "__cdpx_meta.json"), JSON.stringify(meta));
  return { ok: true };
}

export function restoreProfileSnapshot(port: number, name: string): { ok: boolean; error?: string } {
  const safeName = sanitizeExtName(name);
  const profileDir = path.join(PROFILES_DIR, String(port));
  const snapDir = path.join(SNAPSHOTS_DIR, safeName);
  if (!snapDir.startsWith(SNAPSHOTS_DIR + path.sep)) return { ok: false, error: "invalid snapshot name" };
  if (!fs.existsSync(snapDir)) return { ok: false, error: "snapshot not found" };
  // Must stop instance first
  stopInstance(port);
  // Replace profile with snapshot
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.cpSync(snapDir, profileDir, { recursive: true });
  // Restore meta
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(profileDir, "__cdpx_meta.json"), "utf-8"));
    saveMeta(port, meta);
    fs.unlinkSync(path.join(profileDir, "__cdpx_meta.json"));
  } catch {}
  return { ok: true };
}

export function listSnapshots(): string[] {
  try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}
  return fs.readdirSync(SNAPSHOTS_DIR).filter((f) => {
    try { return fs.statSync(path.join(SNAPSHOTS_DIR, f)).isDirectory(); }
    catch { return false; }
  });
}
