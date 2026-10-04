import { customAlphabet } from "nanoid";
import { db, getSetting, setSetting } from "./db.js";
import { config } from "./config.js";
import type { Inbound, Protocol, Transport } from "./types.js";

interface SeedDef {
  tag: string;
  protocol: Protocol;
  transport: Transport;
}

const SEED_INBOUNDS: SeedDef[] = [
  { tag: "VLESS-WS", protocol: "vless", transport: "ws" },
  { tag: "VLESS-XHTTP", protocol: "vless", transport: "xhttp" },
  { tag: "VMess-WS", protocol: "vmess", transport: "ws" },
  { tag: "Trojan-WS", protocol: "trojan", transport: "ws" },
  { tag: "VLESS-HTTPUpgrade", protocol: "vless", transport: "httpupgrade" },
];

const PATH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const pathPart = customAlphabet(PATH_ALPHABET, 4);
const PATH_BASE_KEY = "path_base";

/** Short random base shared by every inbound of this panel, e.g. `k7Xq`. */
function panelPathBase(): string {
  const existing = getSetting(PATH_BASE_KEY);
  if (existing) return existing;
  const base = pathPart();
  setSetting(PATH_BASE_KEY, base);
  return base;
}

/**
 * Short random path for one inbound: `/api/<panel base>-<4 random>`, e.g. `/api/k7Xq-9mA3`.
 * `api` replaces the old branded `/SideRail/<transport>-...` prefix, and the random
 * suffix keeps every inbound unique — the tunnel routes traffic by matching this path.
 */
function nextInboundPath(): string {
  const base = panelPathBase();
  const taken = db.prepare("SELECT 1 FROM inbounds WHERE path = ?");
  let path = `/api/${base}-${pathPart()}`;
  for (let i = 0; i < 10 && taken.get(path); i++) {
    path = `/api/${base}-${pathPart()}`;
  }
  return path;
}

export function seedInbounds(): void {
  const count = (db.prepare("SELECT COUNT(*) AS c FROM inbounds").get() as { c: number }).c;
  if (count > 0) return;
  let offset = 0;
  const insert = db.prepare(
    `INSERT INTO inbounds (tag, protocol, transport, port, path, host, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  for (const s of SEED_INBOUNDS) {
    const port = config.inboundBasePort + offset;
    insert.run(s.tag, s.protocol, s.transport, port, nextInboundPath(), "", Date.now());
    offset += 1;
  }
}

/**
 * Rewrites legacy `/SideRail/<transport>-<id>` paths to the short `/api/` format.
 * Only the style changes: every inbound keeps its own unique path.
 */
export function migrateInboundPaths(): void {
  const rows = db.prepare("SELECT id, path FROM inbounds").all() as {
    id: number;
    path: string;
  }[];
  const update = db.prepare("UPDATE inbounds SET path = ? WHERE id = ?");
  for (const row of rows) {
    if (!row.path.startsWith("/SideRail/")) continue;
    update.run(nextInboundPath(), row.id);
  }
}

export function listInbounds(): Inbound[] {
  return db.prepare("SELECT * FROM inbounds ORDER BY id ASC").all() as unknown as Inbound[];
}

export function listEnabledInbounds(): Inbound[] {
  return db
    .prepare("SELECT * FROM inbounds WHERE enabled = 1 ORDER BY id ASC")
    .all() as unknown as Inbound[];
}

export function getInbound(id: number): Inbound | undefined {
  return db.prepare("SELECT * FROM inbounds WHERE id = ?").get(id) as unknown as
    | Inbound
    | undefined;
}

export function setInboundEnabled(id: number, enabled: boolean): void {
  db.prepare("UPDATE inbounds SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
