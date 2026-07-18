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
    const { resolveOpenSignalsForSymbol, invalidateLoggedPlanRegimeFlip } = await import(
      "../src/calibration/resolveOutcomes"
    );
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
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  if (ext === ".html") {
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
          ? "Telegram ON — phone pe Gold/Silver/Bitcoin alerts aayenge (web band bhi)."
          : "Railway Variables mein TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set karo.",
      });
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
});
