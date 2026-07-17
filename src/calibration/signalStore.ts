/**
 * Compatibility facade — storage is SQLite (`db.ts`).
 * Prefer importing from `./db` in new Node-only code.
 */
export {
  DATA_DIR,
  SIGNAL_DB_PATH,
  SIGNAL_LOG_PATH,
  SIGNAL_LOG_JSON_PATH,
  makePlanKey,
  loadSignalStore,
  saveSignalStore,
  listAllSignals,
  getDb,
  ensureDbMigrated,
} from "./db";
