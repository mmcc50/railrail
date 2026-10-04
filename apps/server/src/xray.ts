/**
 * SideRail - Xray-core VPN management panel
 * Copyright (c) 2025 icubaby. All rights reserved.
 * Official repository: https://github.com/icubaby/SideRail
 *
 * Licensed under the SideRail Proprietary License (see LICENSE).
 * Unauthorized selling, white-labeling, or removal of attribution,
 * branding, or the embedded authorship identifiers is prohibited.
 * Watermark: sr-icubaby-2025-9f4c1a7e
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { config } from "./config.js";
import { buildXrayConfig } from "./xray-config.js";
import { db } from "./db.js";
import { realIpForPort } from "./tunnel.js";

let proc: ChildProcess | null = null;
let running = false;

function binName(): string {
  return config.platform === "win32" ? "xray.exe" : "xray";
}

function binPath(): string {
  return path.join(config.xrayDir, binName());
}

function assetName(): string {
  const arch = config.arch;
  if (config.platform === "linux") {
    if (arch === "arm64") return "Xray-linux-arm64-v8a.zip";
    return "Xray-linux-64.zip";
  }
  if (config.platform === "darwin") {
    return arch === "arm64" ? "Xray-macos-arm64-v8a.zip" : "Xray-macos-64.zip";
  }
  return "Xray-windows-64.zip";
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "SideRail" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`download failed ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", reject);
  });
}

function unzip(zip: string, dir: string): void {
  if (config.platform === "win32") {
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`],
      { stdio: "ignore" },
    );
  } else {
    spawnSync("unzip", ["-o", zip, "-d", dir], { stdio: "ignore" });
  }
}

export async function ensureBinary(): Promise<boolean> {
  if (fs.existsSync(binPath())) return true;
  try {
    const version = config.xrayVersion;
    const url = `https://github.com/XTLS/Xray-core/releases/download/${version}/${assetName()}`;
    const tmpZip = path.join(os.tmpdir(), `xray-${Date.now()}.zip`);
    await download(url, tmpZip);
    unzip(tmpZip, config.xrayDir);
    fs.rmSync(tmpZip, { force: true });
    if (config.platform !== "win32" && fs.existsSync(binPath())) {
      fs.chmodSync(binPath(), 0o755);
    }
    return fs.existsSync(binPath());
  } catch {
    return false;
  }
}

function writeConfig(): string {
  const cfg = buildXrayConfig();
  const file = path.join(config.xrayDir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

let xrayStartedAt = 0;

export function xrayUptime(): number {
  return running && xrayStartedAt ? Math.floor((Date.now() - xrayStartedAt) / 1000) : 0;
}

export async function startXray(): Promise<void> {
  const ok = await ensureBinary();
  if (!ok) {
    running = false;
    return;
  }
  const cfgFile = writeConfig();
  stopXray();
  const child = spawn(binPath(), ["run", "-config", cfgFile], {
    cwd: config.xrayDir,
    stdio: "ignore",
  });
  proc = child;
  running = true;
  xrayStartedAt = Date.now();
  child.on("exit", (code, signal) => {
    if (proc === child) {
      proc = null;
      running = false;
      console.warn(
        `[xray] exited unexpectedly (code=${code}, signal=${signal}) - traffic accounting is paused until Xray is started again`,
      );
    }
  });
}

export function stopXray(): void {
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* noop */
    }
    proc = null;
  }
  running = false;
}

let restartTimer: NodeJS.Timeout | null = null;

export function restartXray(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    // flush pending traffic counters before the process (and its in-memory
    // counters) are replaced
    collectTraffic()
      .catch(() => {
        /* noop - already reported by warnStats */
      })
      .then(() => startXray())
      .catch(() => {
        /* noop */
      });
  }, 800);
}

export function isRunning(): boolean {
  return running && proc != null && proc.exitCode == null && !proc.killed;
}

export function xrayVersion(): string {
  return config.xrayVersion;
}

interface StatStub {
  name: string;
  /** Absent whenever the counter is 0 (Go's `json:",omitempty"`). */
  value?: number;
}

let statsWarnAt = 0;

/** Throttled warning so traffic problems show up in the logs without spamming. */
function warnStats(message: string): void {
  const now = Date.now();
  if (now - statsWarnAt < 60_000) return;
  statsWarnAt = now;
  console.warn(`[traffic] ${message}`);
}

function queryStats(): Promise<StatStub[]> {
  if (!fs.existsSync(binPath()) || !running) return Promise.resolve([]);
  return new Promise((resolve) => {
    // NOTE: no `-reset`. Counters are cumulative and read-only here, so a slow
    // or failed query can never destroy traffic: the next successful read
    // simply reports a bigger number and the delta is taken from that.
    execFile(
      binPath(),
      ["api", "statsquery", `--server=127.0.0.1:${config.xrayApiPort}`],
      { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err || !stdout) {
          warnStats(
            `statsquery failed (${err?.message || String(stderr || "").slice(0, 200) || "no output"})`,
          );
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { stat?: StatStub[] };
          resolve(parsed.stat || []);
        } catch (e) {
          warnStats(`statsquery returned unparseable output: ${(e as Error).message}`);
          resolve([]);
        }
      },
    );
  });
}

/**
 * Last observed value per stats counter. Because the query no longer resets
 * Xray, every read yields a cumulative number and the difference to the
 * previous read is what actually gets persisted.
 *
 * Two Xray quirks handled here:
 *  - a counter of 0 is omitted from the JSON entirely, so a name that is
 *    missing from a snapshot is treated as 0;
 *  - a counter that goes backwards means Xray restarted with fresh counters,
 *    so the baseline is replaced instead of emitting a bogus (negative) delta.
 */
const statsBaseline = new Map<string, number>();

/**
 * Turns one statsquery snapshot into per-user/per-inbound deltas and persists
 * them.
 *
 * `s.value` may be `undefined` (Go's `json:",omitempty"` drops zeros).
 * `undefined <= 0` is `false` in JS, so a plain `<= 0` guard does not skip
 * those entries and node:sqlite throws when binding `undefined`, which used to
 * abort the whole snapshot. Always coerce and validate the number.
 */
function applyStats(stats: StatStub[], now: number): { serverUp: number; serverDown: number } {
  let serverUp = 0;
  let serverDown = 0;
  const updateUp = db.prepare("UPDATE users SET up = up + ?, online_at = ? WHERE email = ?");
  const updateDown = db.prepare("UPDATE users SET down = down + ?, online_at = ? WHERE email = ?");
  const inbUp = db.prepare(
    "INSERT INTO inbound_traffic (inbound_tag, up, down) VALUES (?, ?, 0) ON CONFLICT(inbound_tag) DO UPDATE SET up = up + excluded.up",
  );
  const inbDown = db.prepare(
    "INSERT INTO inbound_traffic (inbound_tag, up, down) VALUES (?, 0, ?) ON CONFLICT(inbound_tag) DO UPDATE SET down = down + excluded.down",
  );
  const seen = new Set<string>();
  for (const s of stats) {
    const value = Number(s.value);
    if (!Number.isFinite(value) || value < 0) continue;
    seen.add(s.name);
    const prev = statsBaseline.get(s.name);
    const delta = prev === undefined ? value : value >= prev ? value - prev : 0;
    statsBaseline.set(s.name, value);
    if (delta <= 0) continue;
    const um = s.name.match(/^user>>>(.+)>>>traffic>>>(uplink|downlink)$/);
    if (um) {
      const email = um[1];
      if (um[2] === "uplink") updateUp.run(delta, now, email);
      else updateDown.run(delta, now, email);
      continue;
    }
    const im = s.name.match(/^inbound>>>(.+)>>>traffic>>>(uplink|downlink)$/);
    if (im) {
      const tag = im[1];
      if (tag === "api") continue;
      if (im[2] === "uplink") {
        inbUp.run(tag, delta);
        serverUp += delta;
      } else {
        inbDown.run(tag, delta);
        serverDown += delta;
      }
    }
  }
  // Counters that are 0 are omitted from the snapshot: treat them as 0 so the
  // next non-zero reading produces a correct delta instead of a baseline jump.
  for (const name of statsBaseline.keys()) {
    if (!seen.has(name)) statsBaseline.set(name, 0);
  }
  return { serverUp, serverDown };
}

let collectInFlight: Promise<void> | null = null;

export function collectTraffic(): Promise<void> {
  if (collectInFlight) return collectInFlight;
  collectInFlight = (async () => {
    const stats = await queryStats();
    const now = Date.now();
    let serverUp = 0;
    let serverDown = 0;
    if (stats.length > 0) {
      try {
        ({ serverUp, serverDown } = applyStats(stats, now));
      } catch (e) {
        warnStats(`could not persist a stats snapshot: ${(e as Error).message}`);
      }
    }
    // Always record the sample so history/gauges stay continuous even when the
    // snapshot above failed.
    recordServerTraffic(now, serverUp, serverDown);
    recordUsageHistory(now);
  })().finally(() => {
    collectInFlight = null;
  });
  return collectInFlight;
}

function recordServerTraffic(now: number, up: number, down: number): void {
  db.prepare("INSERT OR REPLACE INTO server_traffic (ts, up, down) VALUES (?, ?, ?)").run(
    now,
    up,
    down,
  );
  db.prepare("DELETE FROM server_traffic WHERE ts < ?").run(now - 3_600_000);
}

function recordUsageHistory(now: number): void {
  const users = db.prepare("SELECT id, up, down FROM users").all() as {
    id: number;
    up: number;
    down: number;
  }[];
  const insert = db.prepare("INSERT INTO usage_history (user_id, ts, total) VALUES (?, ?, ?)");
  for (const u of users) insert.run(u.id, now, u.up + u.down);
  db.prepare("DELETE FROM usage_history WHERE ts < ?").run(now - 24 * 3_600_000);
}

let logOffset = 0;

export function collectClientIps(): void {
  const logFile = config.xrayAccessLog;
  if (!fs.existsSync(logFile)) return;
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return;
  }
  if (size < logOffset) logOffset = 0;
  if (size === logOffset) return;
  let chunk = "";
  try {
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(size - logOffset);
    fs.readSync(fd, buf, 0, buf.length, logOffset);
    fs.closeSync(fd);
    chunk = buf.toString("utf8");
    logOffset = size;
  } catch {
    return;
  }
  const now = Date.now();
  const emailToId = new Map<string, number>();
  const rows = db.prepare("SELECT id, email FROM users").all() as { id: number; email: string }[];
  for (const r of rows) emailToId.set(r.email, r.id);
  const upsert = db.prepare(
    "INSERT INTO client_ips (user_id, ip, last_seen) VALUES (?, ?, ?) ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen",
  );
  const markOnline = db.prepare("UPDATE users SET online_at = ? WHERE id = ?");
  for (const line of chunk.split("\n")) {
    const ipMatch = line.match(/from (?:tcp:|udp:)?\[?([0-9a-fA-F:.]+)\]?:(\d+)/);
    const emailMatch = line.match(/email:\s*(\S+)/);
    if (!emailMatch) continue;
    const uid = emailToId.get(emailMatch[1]);
    if (!uid) continue;
    markOnline.run(now, uid);
    if (!ipMatch) continue;
    let ip = ipMatch[1];
    if (ip === "127.0.0.1" || ip === "::1") {
      const port = Number(ipMatch[2]);
      const real = realIpForPort(port);
      if (real) ip = real;
      else continue;
    }
    upsert.run(uid, ip, now);
  }
  db.prepare("DELETE FROM client_ips WHERE last_seen < ?").run(now - 5 * 60_000);
  if (size > 5_000_000) {
    try {
      fs.writeFileSync(logFile, "");
      logOffset = 0;
    } catch {
      /* noop */
    }
  }
}

export function getClientIps(userId: number): { ip: string; last_seen: number }[] {
  return db
    .prepare("SELECT ip, last_seen FROM client_ips WHERE user_id = ? ORDER BY last_seen DESC")
    .all(userId) as { ip: string; last_seen: number }[];
}

export function enforceIpLimits(): void {
  const now = Date.now();
  const users = db
    .prepare("SELECT id, ip_limit FROM users WHERE ip_limit > 0 AND enabled = 1")
    .all() as { id: number; ip_limit: number }[];
  for (const u of users) {
    const ips = db
      .prepare(
        "SELECT ip, last_seen FROM client_ips WHERE user_id = ? AND last_seen > ? ORDER BY last_seen DESC",
      )
      .all(u.id, now - 120_000) as { ip: string; last_seen: number }[];
    if (ips.length > u.ip_limit) {
      const excess = ips.slice(u.ip_limit);
      const del = db.prepare("DELETE FROM client_ips WHERE user_id = ? AND ip = ?");
      for (const e of excess) del.run(u.id, e.ip);
    }
  }
}

export function getServerTraffic(): { ts: number; up: number; down: number }[] {
  return db
    .prepare("SELECT ts, up, down FROM server_traffic ORDER BY ts ASC")
    .all() as { ts: number; up: number; down: number }[];
}

export function getInboundTraffic(): { inbound_tag: string; up: number; down: number }[] {
  return db
    .prepare("SELECT inbound_tag, up, down FROM inbound_traffic ORDER BY (up + down) DESC")
    .all() as { inbound_tag: string; up: number; down: number }[];
}
