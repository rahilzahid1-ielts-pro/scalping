import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Dev-server API so the browser can persist signals to data/signals.db */
function calibrationApiPlugin(): Plugin {
  return {
    name: "calibration-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith("/api/alerts/status")) {
          try {
            const { alertChannelsStatus, isTelegramConfigured } = await import(
              "./src/services/notify"
            );
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: true,
                ...alertChannelsStatus(),
                telegramConfigured: isTelegramConfigured(),
                workerWillAutoStart: false,
                hint: isTelegramConfigured()
                  ? "Telegram configured. Production (Railway npm start) pe worker auto-start hoga."
                  : "Local: npm run alerts. Railway: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set karo.",
              }),
            );
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: e instanceof Error ? e.message : "alerts status error",
              }),
            );
          }
          return;
        }

        if (req.url?.startsWith("/api/push/")) {
          try {
            const url = req.url.split("?")[0];
            if (url === "/api/push/public-key" && req.method === "GET") {
              const { getVapidPublicKey } = await import("./src/services/webPush");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, publicKey: getVapidPublicKey() }));
              return;
            }
            if (url === "/api/push/subscribe" && req.method === "POST") {
              const sub = JSON.parse((await readBody(req)) || "{}");
              const { savePushSubscription } = await import("./src/push/subscriptionsDb");
              savePushSubscription({
                endpoint: sub.endpoint,
                keys: sub.keys,
                expirationTime: sub.expirationTime ?? null,
                userAgent: (req.headers["user-agent"] as string) ?? null,
              });
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            if (url === "/api/push/unsubscribe" && req.method === "POST") {
              const { endpoint } = JSON.parse((await readBody(req)) || "{}");
              const { removePushSubscription } = await import("./src/push/subscriptionsDb");
              removePushSubscription(endpoint);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "unknown push route" }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "push error" }),
            );
          }
          return;
        }

        if (!req.url?.startsWith("/api/calibration/")) return next();

        try {
          const { logEmittedSignal } = await import("./src/calibration/logSignal");
          const {
            resolveOpenSignalsForSymbol,
            invalidateLoggedPlanRegimeFlip,
            markLiquiditySweep,
            markTrendConfirmed,
          } = await import("./src/calibration/resolveOutcomes");
          const { listAllSignals, SIGNAL_DB_PATH, makePlanKey } = await import(
            "./src/calibration/db"
          );

          if (req.method === "POST" && req.url === "/api/calibration/regime-flip") {
            const b = JSON.parse(await readBody(req)) as {
              symbol: string;
              mode: string;
              side: string;
              entry: number;
              sl: number;
              tp1: number;
            };
            const planKey = makePlanKey(b.symbol, b.mode, b.side, b.entry, b.sl, b.tp1);
            invalidateLoggedPlanRegimeFlip(planKey);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (req.method === "POST" && req.url === "/api/calibration/liquidity-sweep") {
            const b = JSON.parse(await readBody(req)) as {
              symbol: string;
              mode: string;
              side: string;
              entry: number;
              sl: number;
              tp1: number;
            };
            const planKey = makePlanKey(b.symbol, b.mode, b.side, b.entry, b.sl, b.tp1);
            markLiquiditySweep(planKey, Date.now());
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (
            req.method === "POST" &&
            req.url === "/api/calibration/trend-confirmed"
          ) {
            const b = JSON.parse(await readBody(req)) as {
              symbol: string;
              mode: string;
              side: string;
              entry: number;
              sl: number;
              tp1: number;
              at?: number;
            };
            const planKey = makePlanKey(b.symbol, b.mode, b.side, b.entry, b.sl, b.tp1);
            markTrendConfirmed(planKey, b.at ?? Date.now());
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (req.method === "POST" && req.url === "/api/calibration/log") {
            const body = JSON.parse(await readBody(req));
            const row = logEmittedSignal(body);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, row }));
            return;
          }

          if (req.method === "POST" && req.url === "/api/calibration/resolve") {
            const body = JSON.parse(await readBody(req)) as {
              symbol: string;
              price: number;
              open?: number;
              high?: number;
              low?: number;
            };
            const updated = resolveOpenSignalsForSymbol(body.symbol, {
              price: body.price,
              open: body.open,
              high: body.high,
              low: body.low,
            });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, updated: updated.length }));
            return;
          }

          if (req.method === "GET" && req.url.startsWith("/api/calibration/stats")) {
            const signals = listAllSignals();
            const open = signals.filter((s) => s.outcome === "OPEN").length;
            const resolved = signals.filter(
              (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
            ).length;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: true,
                total: signals.length,
                open,
                resolved,
                path: SIGNAL_DB_PATH,
              }),
            );
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "not found" }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : "calibration api error",
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), calibrationApiPlugin()],
  optimizeDeps: {
    exclude: ["better-sqlite3", "web-push"],
  },
  ssr: {
    external: ["better-sqlite3", "web-push"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api/yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ""),
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
      },
      "/api/binance": {
        target: "https://api.binance.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/binance/, ""),
      },
      // Public data mirror — often works when api.binance.com returns 451
      "/api/binance-data": {
        target: "https://data-api.binance.vision",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/binance-data/, ""),
      },
      "/api/tv": {
        target: "https://scanner.tradingview.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tv/, ""),
        headers: {
          Origin: "https://www.tradingview.com",
          Referer: "https://www.tradingview.com/",
        },
      },
    },
  },
});
