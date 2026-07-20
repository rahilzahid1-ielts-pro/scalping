import { createCompareBot } from "../src/strategyCompare/botFactory";

  const bot = createCompareBot({
  strategy: "fractal",
  tagPrefix: "[TTrades Fractal]",
  modeLabel: "fractal",
  tickMs: Number(process.env.FRACTAL_TICK_MS) || 15_000,
  envFlag: "ENABLE_FRACTAL_WORKER",
});

export function startFractalWorker(): void {
  bot.start();
}
export function shouldAutoStartFractalWorker(): boolean {
  return bot.shouldAutoStart();
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("fractalBot.ts");
if (isDirect) startFractalWorker();
