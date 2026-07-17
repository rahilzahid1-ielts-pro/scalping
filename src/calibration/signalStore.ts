/**
 * Compatibility facade — LIVE storage is SQLite (`db.ts`).
 * Prefer importing from `./db` in new Node-only code.
 * Do not point this at backtest DBs; see BACKTEST_SIGNAL_DB_PATH.
 */
export {
  DATA_DIR,
  SIGNAL_DB_PATH,
  BACKTEST_SIGNAL_DB_PATH,
  SIGNAL_LOG_PATH,
  SIGNAL_LOG_JSON_PATH,
  makePlanKey,
  loadSignalStore,
  saveSignalStore,
  listAllSignals,
  getDb,
  ensureDbMigrated,
} from "./db";
