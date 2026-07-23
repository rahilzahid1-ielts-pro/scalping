/**
 * Mirror EXECUTED live module trades into the demo account (when autoFollow ON).
 * Allowlist: intraday, intra30, cipher_b, qs_pro, quick_scalp, fractal.
 * Never mirrors Main Scalp.
 */
import { buildHistoryPayload, karachiYmd } from "../history/apiHistory";
import {
  ensureDemoAccount,
  findDemoBySourceId,
  isDemoAutoFollowModule,
  listOpenDemoPositions,
} from "./store";
import { closeFromSourceOutcome, takeDemoTrade } from "./engine";

export async function syncDemoFromHistory(opts?: {
  date?: string;
  /** Force take even if autoFollow is off (manual sync button). */
  force?: boolean;
}): Promise<{
  opened: number;
  closed: number;
  skipped: number;
  errors: string[];
}> {
  const acct = ensureDemoAccount();
  const date = opts?.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : karachiYmd();
  const hist = await buildHistoryPayload({ date, module: "all" });

  let opened = 0;
  let closed = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Close linked opens first (any module that was taken into demo)
  for (const pos of listOpenDemoPositions()) {
    if (!pos.sourceId) continue;
    const trade = hist.trades.find((t) => t.id === pos.sourceId);
    if (!trade) continue;
    if (trade.outcome === "OPEN") continue;
    const res = closeFromSourceOutcome(pos.sourceId, trade.outcome, trade.realizedR);
    if (res?.ok) closed += 1;
  }

  const follow = opts?.force === true || acct.autoFollow;
  if (!follow) {
    return { opened, closed, skipped, errors };
  }

  for (const t of hist.trades) {
    if (!isDemoAutoFollowModule(t.module)) {
      skipped += 1;
      continue;
    }
    if (!t.executed) {
      skipped += 1;
      continue;
    }
    if (findDemoBySourceId(t.id)) {
      skipped += 1;
      continue;
    }
    // Only take still-OPEN executed, or freshly resolved today
    if (t.outcome !== "OPEN") {
      const take = takeDemoTrade({
        side: t.side,
        entry: t.entry,
        sl: t.sl,
        tp1: t.tp1,
        tp2: t.tp2,
        module: t.module,
        sourceId: t.id,
        note: `Auto ${t.moduleLabel} EXECUTED`,
      });
      if (!take.ok) {
        if (!/pehle se|Duplicate/i.test(take.error)) errors.push(take.error);
        skipped += 1;
        continue;
      }
      opened += 1;
      const res = closeFromSourceOutcome(t.id, t.outcome, t.realizedR);
      if (res?.ok) closed += 1;
      continue;
    }

    const take = takeDemoTrade({
      side: t.side,
      entry: t.entry,
      sl: t.sl,
      tp1: t.tp1,
      tp2: t.tp2,
      module: t.module,
      sourceId: t.id,
      note: `Auto ${t.moduleLabel} EXECUTED (OPEN)`,
    });
    if (!take.ok) {
      if (!/pehle se|Duplicate/i.test(take.error)) errors.push(take.error);
      skipped += 1;
      continue;
    }
    opened += 1;
  }

  return { opened, closed, skipped, errors };
}
