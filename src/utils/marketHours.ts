/**
 * FX / XAU session guard — no new locks into Friday close or weekend.
 *
 * Default (Asia/Karachi = UTC+5):
 *   Block from Friday 20:00 PKT → Monday 03:00 PKT
 *   (typical gold close ~Sat 02:00 PKT; open ~Mon 03:00 PKT)
 *
 * Env:
 *   FRIDAY_NO_NEW_LOCK_PKT_HOUR=20
 *   MARKET_OPEN_MON_PKT_HOUR=3
 */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

export function karachiWeekdayHour(ms: number): {
  /** 0=Sun … 5=Fri 6=Sat */
  weekday: number;
  hour: number;
  minute: number;
} {
  const d = new Date(ms + KARACHI_OFFSET_MS);
  return {
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

export function fridayNoNewLockPktHour(): number {
  const n = Number(process.env.FRIDAY_NO_NEW_LOCK_PKT_HOUR ?? 20);
  return Number.isFinite(n) ? Math.min(23, Math.max(12, Math.floor(n))) : 20;
}

export function marketOpenMonPktHour(): number {
  const n = Number(process.env.MARKET_OPEN_MON_PKT_HOUR ?? 3);
  return Number.isFinite(n) ? Math.min(12, Math.max(0, Math.floor(n))) : 3;
}

/**
 * True when new entries should be blocked (Friday close window + weekend).
 * Existing OPEN locks may still resolve; this only gates new prints.
 */
export function isFridayCloseOrWeekend(now = Date.now()): {
  blocked: boolean;
  reason: string;
} {
  const { weekday, hour } = karachiWeekdayHour(now);
  const friCut = fridayNoNewLockPktHour();
  const monOpen = marketOpenMonPktHour();

  // Friday from cutoff hour → end of Friday
  if (weekday === 5 && hour >= friCut) {
    return {
      blocked: true,
      reason: `Friday close — no new locks after ${friCut}:00 PKT (settle before weekend)`,
    };
  }
  // Saturday (market closed)
  if (weekday === 6) {
    return {
      blocked: true,
      reason: "Weekend — market closed (Saturday)",
    };
  }
  // Sunday (still closed in PKT; opens early Monday)
  if (weekday === 0) {
    return {
      blocked: true,
      reason: `Weekend — market closed (Sunday; opens ~Mon ${monOpen}:00 PKT)`,
    };
  }
  // Monday before open
  if (weekday === 1 && hour < monOpen) {
    return {
      blocked: true,
      reason: `Pre-open — no new locks before Mon ${monOpen}:00 PKT`,
    };
  }

  return { blocked: false, reason: "" };
}
