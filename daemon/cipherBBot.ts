import { createCompareBot } from "../src/strategyCompare/botFactory";

const bot = createCompareBot({
  strategy: "cipher_b_clone",
  tagPrefix: "[Cipher B]",
  modeLabel: "cipher_b_clone",
  tickMs: Number(process.env.CIPHER_B_TICK_MS) || 15_000,
  envFlag: "ENABLE_CIPHER_B_WORKER",
});

export function startCipherBWorker(): void {
  bot.start();
}
export function shouldAutoStartCipherBWorker(): boolean {
  return bot.shouldAutoStart();
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("cipherBBot.ts");
if (isDirect) startCipherBWorker();
