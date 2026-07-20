import { createCompareBot } from "../src/strategyCompare/botFactory";

const bot = createCompareBot({
  strategy: "ict",
  tagPrefix: "[ICT]",
  modeLabel: "ict",
  tickMs: Number(process.env.ICT_TICK_MS) || 15_000,
  envFlag: "ENABLE_ICT_WORKER",
});

export function startIctWorker(): void {
  bot.start();
}
export function shouldAutoStartIctWorker(): boolean {
  // Retired from production — never auto-start (see src/strategies/archived/README.md).
  return false;
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("ictBot.ts");
if (isDirect) startIctWorker();
