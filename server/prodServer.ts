/**
 * Production HTTP server for Railway / Node hosts.
 * Serves Vite `dist/`, proxies Yahoo/TV/Binance, and hosts calibration API.
 * Listens on process.env.PORT (Railway).
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PORT) || 4173;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

type ProxyTarget = {
  prefix: string;
  origin: string;
  rewrite: (path: string) => string;
  extraHeaders?: Record<string, string>;
};

const PROXIES: ProxyTarget[] = [
  {
    prefix: "/api/yahoo",
    origin: "https://query1.finance.yahoo.com",
    rewrite: (p) => p.replace(/^\/api\/yahoo/, ""),
    extraHeaders: { "User-Agent": "Mozilla/5.0" },
  },
  {
    prefix: "/api/binance-data",
    origin: "https://data-api.binance.vision",
    rewrite: (p) => p.replace(/^\/api\/binance-data/, ""),
  },
  {
    prefix: "/api/binance",
    origin: "https://api.binance.com",
    rewrite: (p) => p.replace(/^\/api\/binance/, ""),
  },
  {
    prefix: "/api/tv",
    origin: "https://scanner.tradingview.com",
    rewrite: (p) => p.replace(/^\/api\/tv/, ""),
    extraHeaders: {
      Origin: "https://www.tradingview.com",
      Referer: "https://www.tradingview.com/",
    },
  },
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function handleCalibration(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<void> {
  try {
    const { logEmittedSignal } = await import("../src/calibration/logSignal");
    const {
      resolveOpenSignalsForSymbol,
      invalidateLoggedPlanRegimeFlip,
      markLiquiditySweep,
      markTrendConfirmed,
    } = await import("../src/calibration/resolveOutcomes");
    const { listAllSignals, SIGNAL_DB_PATH, makePlanKey } = await import(
      "../src/calibration/db"
    );

    if (req.method === "POST" && urlPath === "/api/calibration/regime-flip") {
      const raw = (await readBody(req)).toString("utf8");
      const b = JSON.parse(raw || "{}") as {
        symbol: string;
        mode: string;
        side: string;
        entry: number;
        sl: number;
        tp1: number;
      };
      const planKey = makePlanKey(b.symbol, b.mode, b.side, b.entry, b.sl, b.tp1);
      invalidateLoggedPlanRegimeFlip(planKey);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/calibration/liquidity-sweep") {
      const raw = (await readBody(req)).toString("utf8");
      const b = JSON.parse(raw || "{}") as {
        symbol: string;
        mode: string;
        side: string;
        entry: number;
        sl: number;
        tp1: number;
      };
      const planKey = makePlanKey(b.symbol, b.mode, b.side, b.entry, b.sl, b.tp1);
      markLiquiditySweep(planKey, Date.now());
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/calibration/trend-confirmed") {
      const raw = (await readBody(req)).toString("utf8");
      const b = JSON.parse(raw || "{}") as {
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
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/calibration/log") {
      const raw = (await readBody(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      const row = logEmittedSignal(body);
      sendJson(res, 200, { ok: true, row });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/calibration/resolve") {
      const raw = (await readBody(req)).toString("utf8");
      const body = JSON.parse(raw || "{}") as {
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
      sendJson(res, 200, { ok: true, updated: updated.length });
      return;
    }

    if (req.method === "GET" && urlPath.startsWith("/api/calibration/stats")) {
      const signals = listAllSignals();
      const open = signals.filter((s) => s.outcome === "OPEN").length;
      const resolved = signals.filter(
        (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
      ).length;
      sendJson(res, 200, {
        ok: true,
        total: signals.length,
        open,
        resolved,
        path: SIGNAL_DB_PATH,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, {
      ok: false,
      error: e instanceof Error ? e.message : "calibration api error",
    });
  }
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  urlPath: string,
  search: string,
): Promise<void> {
  const upstreamPath = target.rewrite(urlPath) + search;
  const upstreamUrl = new URL(upstreamPath, target.origin);

  const headers: Record<string, string> = {
    Accept: req.headers.accept ?? "*/*",
    ...(target.extraHeaders ?? {}),
  };
  if (req.headers["content-type"]) {
    headers["Content-Type"] = String(req.headers["content-type"]);
  }

  const method = req.method ?? "GET";
  const body =
    method !== "GET" && method !== "HEAD" ? await readBody(req) : undefined;

  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });

  res.statusCode = upstream.status;
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

function safeDistFile(urlPath: string): string | null {
  const cleaned = decodeURIComponent(urlPath.split("?")[0] || "/");
  const rel = cleaned === "/" ? "index.html" : cleaned.replace(/^\//, "");
  const full = resolve(DIST, rel);
  if (!full.startsWith(resolve(DIST) + sep) && full !== resolve(DIST)) {
    return null;
  }
  return full;
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<void> {
  let filePath = safeDistFile(urlPath);
  if (!filePath) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = join(DIST, "index.html");
  }

  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.end("Not found — run npm run build first");
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const baseName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  // Service worker + manifest must never be cached long-term or the PWA can't update.
  if (baseName === "sw.js" || baseName === "manifest.json") {
    res.setHeader("Cache-Control", "no-cache");
  } else if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else if (ext === ".js" || ext === ".css") {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }

  await pipeline(createReadStream(filePath), res);
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;

    if (path.startsWith("/api/calibration/")) {
      await handleCalibration(req, res, path);
      return;
    }

    if (path === "/api/alerts/status" && req.method === "GET") {
      const { alertChannelsStatus, isTelegramConfigured } = await import(
        "../src/services/notify"
      );
      const { shouldAutoStartAlertWorker } = await import("../daemon/alertBot");
      sendJson(res, 200, {
        ok: true,
        ...alertChannelsStatus(),
        telegramConfigured: isTelegramConfigured(),
        workerWillAutoStart: shouldAutoStartAlertWorker(),
        hint: isTelegramConfigured()
          ? "Telegram ON — phone pe Gold alerts aayenge (web band bhi)."
          : "Railway Variables mein TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set karo.",
      });
      return;
    }

    if (path === "/api/plan/current" && req.method === "GET") {
      const { handleGetCurrentPlan } = await import("../daemon/planHttp");
      const result = await handleGetCurrentPlan(url.searchParams);
      sendJson(res, result.status, result.body);
      return;
    }

    if (path === "/api/plan/clear" && req.method === "POST") {
      const { handleClearCurrentPlan } = await import("../daemon/planHttp");
      const result = await handleClearCurrentPlan(url.searchParams);
      sendJson(res, result.status, result.body);
      return;
    }

    if (path === "/api/quickscalp/latest" && req.method === "GET") {
      const { buildQuickScalpLatestPayload } = await import("../src/quickScalp/apiLatest");
      sendJson(res, 200, await buildQuickScalpLatestPayload());
      return;
    }

    if (path === "/api/pro/latest" && req.method === "GET") {
      const { buildProLatestPayload } = await import("../src/pro/apiLatest");
      sendJson(res, 200, await buildProLatestPayload());
      return;
    }

    if (path === "/api/intra30/latest" && req.method === "GET") {
      const { buildIntra30LatestPayload } = await import("../src/intra30/apiLatest");
      sendJson(res, 200, await buildIntra30LatestPayload());
      return;
    }

    if (path === "/api/pulse/latest" && req.method === "GET") {
      const { buildPulseLatestPayload } = await import("../src/pulse/apiLatest");
      sendJson(res, 200, await buildPulseLatestPayload());
      return;
    }

    if (path === "/api/history" && req.method === "GET") {
      const { buildHistoryPayload } = await import("../src/history/apiHistory");
      const u = new URL(req.url || "/api/history", "http://localhost");
      sendJson(
        res,
        200,
        await buildHistoryPayload({
          date: u.searchParams.get("date"),
          from: u.searchParams.get("from"),
          to: u.searchParams.get("to"),
          module: u.searchParams.get("module"),
        }),
      );
      return;
    }

    if (path.startsWith("/api/demo/")) {
      try {
        const demo = await import("../src/demoAccount/api");
        if (path === "/api/demo/account" && req.method === "GET") {
          sendJson(res, 200, await demo.buildDemoAccountPayload());
          return;
        }
        if (path === "/api/demo/take" && req.method === "POST") {
          const raw = (await readBody(req)).toString("utf8");
          const body = JSON.parse(raw || "{}");
          const out = await demo.handleDemoTake(body);
          sendJson(res, out.ok ? 200 : 400, out);
          return;
        }
        if (path === "/api/demo/close" && req.method === "POST") {
          const raw = (await readBody(req)).toString("utf8");
          const body = JSON.parse(raw || "{}");
          const out = await demo.handleDemoClose(body);
          sendJson(res, out.ok ? 200 : 400, out);
          return;
        }
        if (path === "/api/demo/reset" && req.method === "POST") {
          sendJson(res, 200, await demo.handleDemoReset());
          return;
        }
        if (path === "/api/demo/settings" && req.method === "POST") {
          const raw = (await readBody(req)).toString("utf8");
          const body = JSON.parse(raw || "{}");
          sendJson(res, 200, await demo.handleDemoSettings(body));
          return;
        }
        sendJson(res, 404, { ok: false, error: "unknown demo route" });
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: e instanceof Error ? e.message : "demo api error",
        });
      }
      return;
    }

    if (path === "/api/cipherbclone/latest" && req.method === "GET") {
      const { buildLatestPayload } = await import("../src/strategyCompare/apiLatest");
      sendJson(res, 200, await buildLatestPayload("cipher_b_clone"));
      return;
    }

    if (path === "/api/fractal/latest" && req.method === "GET") {
      const { buildLatestPayload } = await import("../src/strategyCompare/apiLatest");
      sendJson(res, 200, await buildLatestPayload("fractal"));
      return;
    }

    if (path === "/api/ict/latest") {
      sendJson(res, 410, {
        ok: false,
        retired: true,
        error: "ICT strategy remains retired (n too small / 0% on backtest)",
      });
      return;
    }

    if (path === "/api/push/public-key" && req.method === "GET") {
      const { getVapidPublicKey } = await import("../src/services/webPush");
      sendJson(res, 200, { ok: true, publicKey: getVapidPublicKey() });
      return;
    }

    if (path === "/api/push/subscribe" && req.method === "POST") {
      try {
        const raw = (await readBody(req)).toString("utf8");
        const sub = JSON.parse(raw || "{}");
        const { savePushSubscription } = await import("../src/push/subscriptionsDb");
        savePushSubscription({
          endpoint: sub.endpoint,
          keys: sub.keys,
          expirationTime: sub.expirationTime ?? null,
          userAgent: (req.headers["user-agent"] as string) ?? null,
        });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : "bad subscription" });
      }
      return;
    }

    if (path === "/api/push/unsubscribe" && req.method === "POST") {
      try {
        const raw = (await readBody(req)).toString("utf8");
        const { endpoint } = JSON.parse(raw || "{}");
        const { removePushSubscription } = await import("../src/push/subscriptionsDb");
        removePushSubscription(endpoint);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : "bad request" });
      }
      return;
    }

    if (path === "/api/push/test" && req.method === "POST") {
      try {
        const { isWebPushConfigured, sendWebPushToAll, webPushStatus } = await import(
          "../src/services/webPush"
        );
        const status = webPushStatus();
        if (!isWebPushConfigured()) {
          sendJson(res, 503, {
            ok: false,
            vapidConfigured: false,
            subscriptions: status.webPushSubscriptions,
            delivered: 0,
            error: "VAPID keys missing — set WEB_PUSH_VAPID_PUBLIC_KEY + PRIVATE_KEY",
          });
          return;
        }
        if (status.webPushSubscriptions <= 0) {
          sendJson(res, 400, {
            ok: false,
            vapidConfigured: true,
            subscriptions: 0,
            delivered: 0,
            error: "No push subscriptions — pehle Enable Push dabao",
          });
          return;
        }
        const delivered = await sendWebPushToAll({
          kind: "PLAN_LOCK",
          assetId: "XAUUSD",
          mode: "test",
          side: "BUY",
          title: "TEST PUSH — Trade Alert",
          body: "Agar ye dikha to closed-app / home-screen push KAAM kar raha hai ✅",
          tagPrefix: "[Test]",
        });
        sendJson(res, 200, {
          ok: true,
          vapidConfigured: true,
          subscriptions: status.webPushSubscriptions,
          delivered,
        });
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: e instanceof Error ? e.message : "test push failed",
        });
      }
      return;
    }

    const proxy = PROXIES.find((p) => path.startsWith(p.prefix));
    if (proxy) {
      await proxyRequest(req, res, proxy, path, url.search);
      return;
    }

    if (path.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: `unknown api route: ${path}` });
      return;
    }

    await serveStatic(req, res, path);
  } catch (e) {
    console.error("[prodServer]", e);
    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: e instanceof Error ? e.message : "server error",
      });
    } else {
      res.end();
    }
  }
});

if (!existsSync(DIST)) {
  console.warn(
    `[prodServer] dist/ missing at ${DIST} — run npm run build before start`,
  );
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[prodServer] listening on 0.0.0.0:${PORT}`);
  console.log(`[prodServer] serving ${DIST}`);

  // Live alert worker on Railway — Telegram phone alerts even when web is closed
  void import("../daemon/alertBot").then(({ startAlertWorker, shouldAutoStartAlertWorker }) => {
    if (shouldAutoStartAlertWorker()) {
      startAlertWorker();
    } else {
      console.log(
        "[prodServer] Alert worker OFF — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (or ENABLE_ALERT_WORKER=1)",
      );
    }
  }).catch((e) => {
    console.error("[prodServer] Failed to start alert worker:", e);
  });

  void import("../daemon/quickScalpBot").then(
    ({ startQuickScalpWorker, shouldAutoStartQuickScalpWorker }) => {
      if (shouldAutoStartQuickScalpWorker()) {
        startQuickScalpWorker();
      } else {
        console.log(
          "[prodServer] Quick Scalp worker OFF — set ENABLE_QUICK_SCALP_WORKER=1 to enable",
        );
      }
    },
  ).catch((e) => {
    console.error("[prodServer] Failed to start Quick Scalp worker:", e);
  });

  void import("../daemon/proBot").then(
    ({ startProWorker, shouldAutoStartProWorker }) => {
      if (shouldAutoStartProWorker()) {
        startProWorker();
      } else {
        console.log(
          "[prodServer] Pro worker OFF — set ENABLE_PRO_WORKER=1 to enable",
        );
      }
    },
  ).catch((e) => {
    console.error("[prodServer] Failed to start Pro worker:", e);
  });

  void import("../daemon/intra30Bot").then(
    ({ startIntra30Worker, shouldAutoStartIntra30Worker }) => {
      if (shouldAutoStartIntra30Worker()) {
        startIntra30Worker();
      } else {
        console.log(
          "[prodServer] Intra30 worker OFF — set ENABLE_INTRA30_WORKER=1 (or unset =0)",
        );
      }
    },
  ).catch((e) => {
    console.error("[prodServer] Failed to start Intra30 worker:", e);
  });

  void import("../daemon/pulseBot").then(
    ({ startPulseWorker, shouldAutoStartPulseWorker }) => {
      if (shouldAutoStartPulseWorker()) {
        startPulseWorker();
      } else {
        console.log(
          "[prodServer] Pulse worker OFF — set ENABLE_PULSE_WORKER=1 to enable",
        );
      }
    },
  ).catch((e) => {
    console.error("[prodServer] Failed to start Pulse worker:", e);
  });

  void import("../daemon/cipherBBot").then(
    ({ startCipherBWorker, shouldAutoStartCipherBWorker }) => {
      if (shouldAutoStartCipherBWorker()) {
        startCipherBWorker();
      } else {
        console.log(
          "[prodServer] Cipher B worker OFF — set ENABLE_CIPHER_B_WORKER=1 to enable",
        );
      }
    },
  ).catch((e) => {
    console.error("[prodServer] Failed to start Cipher B worker:", e);
  });

  void import("../daemon/fractalBot").then(
    ({ startFractalWorker, shouldAutoStartFractalWorker }) => {
      if (shouldAutoStartFractalWorker()) {
        startFractalWorker();
      } else {
        console.log(
          "[prodServer] Fractal worker OFF — set ENABLE_FRACTAL_WORKER=1 to enable",
        );
      }
    },
  ).catch((e) => {
    console.error("[prodServer] Failed to start Fractal worker:", e);
  });
});
