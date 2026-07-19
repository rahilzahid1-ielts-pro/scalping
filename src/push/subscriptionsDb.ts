/**
 * Web Push subscriptions store — SQLite, fully separate from signals.db.
 * Path: data/push-subscriptions.db
 *
 * This module NEVER opens data/signals.db (calibration/live outcomes) and is
 * unrelated to the backtest store. It only holds browser PushManager
 * subscription objects so the alert worker can fan out notifications.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR, SIGNAL_DB_PATH } from "../calibration/db";

export const PUSH_DB_PATH = join(DATA_DIR, "push-subscriptions.db");

/** Shape stored per browser subscription (matches the W3C PushSubscription JSON). */
export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  userAgent?: string | null;
  createdAt?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint        TEXT PRIMARY KEY,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  expiration_time INTEGER,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL
);
`;

let dbInstance: Database.Database | null = null;

function assertNotLive(path: string): void {
  if (resolve(path) === resolve(SIGNAL_DB_PATH)) {
    throw new Error("[pushDb] refusing to open live signals.db from the push store");
  }
}

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  assertNotLive(PUSH_DB_PATH);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(PUSH_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("application_id = 0x50555348"); // 'PUSH'
  db.exec(SCHEMA);
  dbInstance = db;
  return db;
}

/** Upsert a subscription (dedup by endpoint). */
export function savePushSubscription(sub: StoredPushSubscription): void {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error("invalid subscription: endpoint/keys missing");
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO push_subscriptions
       (endpoint, p256dh, auth, expiration_time, user_agent, created_at)
     VALUES (@endpoint, @p256dh, @auth, @expiration_time, @user_agent, @created_at)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       expiration_time = excluded.expiration_time,
       user_agent = excluded.user_agent`,
  ).run({
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    expiration_time: sub.expirationTime ?? null,
    user_agent: sub.userAgent ?? null,
    created_at: sub.createdAt ?? Date.now(),
  });
}

/** All stored subscriptions, mapped back to web-push's expected shape. */
export function getAllPushSubscriptions(): StoredPushSubscription[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT endpoint, p256dh, auth, expiration_time, user_agent, created_at
         FROM push_subscriptions`,
    )
    .all() as Array<{
    endpoint: string;
    p256dh: string;
    auth: string;
    expiration_time: number | null;
    user_agent: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
    expirationTime: r.expiration_time,
    userAgent: r.user_agent,
    createdAt: r.created_at,
  }));
}

/** Remove a subscription (e.g. after a 404/410 Gone from the push service). */
export function removePushSubscription(endpoint: string): void {
  if (!endpoint) return;
  const db = getDb();
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function countPushSubscriptions(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as {
    n: number;
  };
  return row?.n ?? 0;
}
