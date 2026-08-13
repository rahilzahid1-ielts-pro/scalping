#property copyright "Scalping desk"
#property strict
#property version   "2.04"
#property description "DeskAutoEAGold: QS Pro+Pro+Cipher B+Intra30+Fractal. Portal SL/TP1. API self-test."

#include <Trade/Trade.mqh>

//--- desk / trade -----------------------------------------------------------
input string ApiBaseUrl            = "https://scalping-production.up.railway.app";
input string TradeSymbol           = "";          // empty = chart symbol
input double FixedLots             = 0.01;
input int    PollSeconds           = 1;           // fastest practical timer
input int    HttpTimeoutMs         = 8000;
input double MarketEntryTolerance  = 0.15;
input double FixedTpSlDistance     = 3.00;        // FALLBACK only if portal SL/TP missing
input bool   UsePortalStops        = true;        // ALWAYS portal sl+tp1 when present
input double MaxLateEntryDistance  = 3.00;
input double MaxContinuationChase  = 10.00;       // gold moves fast — join if still in band
input int    MaxDeviationPoints    = 100;
input bool   RequireHedgingAccount = true;

//--- live safety ------------------------------------------------------------
input double MaxSpreadUsd          = 1.50;
input int    MaxSignalAgeMinutes   = 180;
input bool   RequireAlgoTradingOn  = true;
input bool   ForceChartM5          = false;
input int    TickPollMs            = 800;         // poll on ticks for timely fill
input bool   JoinIfInsidePortalBand = true;       // if live still between portal SL..TP → market

//--- modules (VERY FINAL pack) ----------------------------------------------
input bool   EnableQsPro           = true;
input bool   EnablePro             = true;
input bool   EnableCipherB         = true;
input bool   EnableIntra30         = true;
input bool   EnableFractal         = true;

input ulong  MagicQsPro            = 26072202;
input ulong  MagicPro              = 26072203;
input ulong  MagicCipherB          = 26072204;
input ulong  MagicIntra30          = 26072206;
input ulong  MagicFractal          = 26072205;

CTrade trade;
string g_sym;
int    g_digits;
double g_point;
datetime g_lastHttpErrAt = 0;
ulong  g_lastPollMs = 0;

//--- JSON -------------------------------------------------------------------
bool ExtractObject(const string json, const string key, string &object)
{
   int keyPos = StringFind(json, "\"" + key + "\"");
   if(keyPos < 0) return false;
   int colon = StringFind(json, ":", keyPos);
   if(colon < 0) return false;
   int start = StringFind(json, "{", colon);
   int nullPos = StringFind(json, "null", colon);
   if(nullPos >= 0 && (start < 0 || nullPos < start)) return false;
   if(start < 0) return false;

   int depth = 0;
   bool inString = false;
   bool escaped = false;
   int length = StringLen(json);
   for(int i = start; i < length; i++)
   {
      ushort ch = (ushort)StringGetCharacter(json, i);
      if(inString)
      {
         if(escaped) escaped = false;
         else if(ch == '\\') escaped = true;
         else if(ch == '"') inString = false;
         continue;
      }
      if(ch == '"') inString = true;
      else if(ch == '{') depth++;
      else if(ch == '}')
      {
         depth--;
         if(depth == 0)
         {
            object = StringSubstr(json, start, i - start + 1);
            return true;
         }
      }
   }
   return false;
}

bool JsonString(const string json, const string key, string &value)
{
   int p = StringFind(json, "\"" + key + "\"");
   if(p < 0) return false;
   p = StringFind(json, ":", p);
   if(p < 0) return false;
   int q1 = StringFind(json, "\"", p + 1);
   if(q1 < 0) return false;
   int q2 = q1 + 1;
   while(q2 < StringLen(json))
   {
      if(StringGetCharacter(json, q2) == '"' &&
         StringGetCharacter(json, q2 - 1) != '\\') break;
      q2++;
   }
   if(q2 >= StringLen(json)) return false;
   value = StringSubstr(json, q1 + 1, q2 - q1 - 1);
   return true;
}

bool JsonNumber(const string json, const string key, double &value)
{
   int p = StringFind(json, "\"" + key + "\"");
   if(p < 0) return false;
   p = StringFind(json, ":", p);
   if(p < 0) return false;
   p++;
   while(p < StringLen(json) && StringGetCharacter(json, p) <= ' ') p++;
   int end = p;
   string allowed = "-+.0123456789eE";
   while(end < StringLen(json))
   {
      string c = StringSubstr(json, end, 1);
      if(StringFind(allowed, c) < 0) break;
      end++;
   }
   if(end == p) return false;
   value = StringToDouble(StringSubstr(json, p, end - p));
   return true;
}

bool JsonLong(const string json, const string key, long &value)
{
   double parsed = 0.0;
   if(!JsonNumber(json, key, parsed)) return false;
   value = (long)parsed;
   return true;
}

bool JsonValueIsNull(const string json, const string key)
{
   int p = StringFind(json, "\"" + key + "\"");
   if(p < 0) return true;
   p = StringFind(json, ":", p);
   if(p < 0) return true;
   p++;
   while(p < StringLen(json) && StringGetCharacter(json, p) <= ' ') p++;
   return StringSubstr(json, p, 4) == "null";
}

bool HttpGet(const string path, string &body)
{
   char request[];
   char response[];
   string headers;
   ArrayResize(request, 0);
   ResetLastError();
   int code = WebRequest("GET", ApiBaseUrl + path, "", "", HttpTimeoutMs,
                         request, 0, response, headers);
   if(code == -1)
   {
      if(TimeCurrent() - g_lastHttpErrAt >= 60)
      {
         g_lastHttpErrAt = TimeCurrent();
         int err = GetLastError();
         Print("WebRequest FAILED err=", err,
               " — Tools→Options→Expert Advisors→Allow WebRequest: ", ApiBaseUrl);
         if(err == 4014)
            Print("HINT: URL not allowed (4014). Add exact base URL, then re-Migrate VPS.");
      }
      return false;
   }
   if(code != 200)
   {
      if(TimeCurrent() - g_lastHttpErrAt >= 60)
      {
         g_lastHttpErrAt = TimeCurrent();
         Print("API HTTP ", code, " path=", path,
               " — portal unreachable; EA cannot see locks (no trades).");
         if(code == 1003 || code == 502 || code == 503)
            Print("HINT: VPS/network/SSL or Railway blip. Confirm URL allow-list + Migrate; watch until HTTP 200.");
      }
      return false;
   }
   body = CharArrayToString(response, 0, -1, CP_UTF8);
   return true;
}

//--- symbol / stops ---------------------------------------------------------
void RefreshSymbolMeta()
{
   g_digits = (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS);
   g_point  = SymbolInfoDouble(g_sym, SYMBOL_POINT);
   if(g_point <= 0.0) g_point = 0.01;
}

double NormalizeLots(const double requested)
{
   double minLot = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MAX);
   double step   = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = 0.01;
   double lots = MathMax(minLot, MathMin(maxLot, requested));
   lots = MathFloor(lots / step + 1e-8) * step;
   int lotDigits = 2;
   if(step < 0.01) lotDigits = 3;
   if(step < 0.001) lotDigits = 4;
   return NormalizeDouble(lots, lotDigits);
}

double MinStopDistance()
{
   long stops = SymbolInfoInteger(g_sym, SYMBOL_TRADE_STOPS_LEVEL);
   long freeze = SymbolInfoInteger(g_sym, SYMBOL_TRADE_FREEZE_LEVEL);
   double dist = (double)MathMax(stops, freeze) * g_point;
   // gold brokers often need a small buffer beyond published stops level
   if(dist < 0.20) dist = 0.20;
   return dist;
}

bool ApplyFixedStops(const string side, const double anchor, double &sl, double &tp)
{
   double need = MathMax(FixedTpSlDistance, MinStopDistance());
   if(side == "BUY")
   {
      sl = anchor - need;
      tp = anchor + need;
   }
   else if(side == "SELL")
   {
      sl = anchor + need;
      tp = anchor - need;
   }
   else return false;
   sl = NormalizeDouble(sl, g_digits);
   tp = NormalizeDouble(tp, g_digits);
   return true;
}

/** Prefer portal/desk SL + TP1 vs lock entry; enforce broker min vs order anchor. */
bool ResolveStops(const string side,
                  const double entryForGeom,
                  const double orderAnchor,
                  const double portalSl, const double portalTp,
                  double &sl, double &tp)
{
   bool usePortal = UsePortalStops &&
                    portalSl > 0.0 && portalTp > 0.0 &&
                    ((side == "BUY" && portalSl < entryForGeom && portalTp > entryForGeom) ||
                     (side == "SELL" && portalSl > entryForGeom && portalTp < entryForGeom));

   if(usePortal)
   {
      sl = portalSl;
      tp = portalTp;
      double minD = MinStopDistance();
      if(side == "BUY")
      {
         if(orderAnchor - sl < minD) sl = orderAnchor - minD;
         if(tp - orderAnchor < minD) tp = orderAnchor + minD;
      }
      else
      {
         if(sl - orderAnchor < minD) sl = orderAnchor + minD;
         if(orderAnchor - tp < minD) tp = orderAnchor - minD;
      }
      sl = NormalizeDouble(sl, g_digits);
      tp = NormalizeDouble(tp, g_digits);
      return true;
   }
   return ApplyFixedStops(side, orderAnchor, sl, tp);
}

bool FreshTick(MqlTick &tick)
{
   if(!SymbolInfoTick(g_sym, tick))
      return false;
   if(!(tick.ask > 0.0 && tick.bid > 0.0))
      return false;
   // VPS sometimes keeps a stale SYMBOL_ASK/BID (~hours old). Refuse if tick age > 10s.
   long ageSec = (long)TimeCurrent() - (long)tick.time;
   if(ageSec < 0) ageSec = -ageSec;
   if(ageSec > 10)
   {
      Print("Stale tick age=", ageSec, "s bid=", tick.bid, " ask=", tick.ask,
            " — waiting for fresh quote");
      return false;
   }
   return true;
}

double CurrentSpreadUsd()
{
   MqlTick tick;
   if(!FreshTick(tick)) return 999.0;
   return tick.ask - tick.bid;
}

bool SpreadOk()
{
   double sp = CurrentSpreadUsd();
   if(sp > MaxSpreadUsd)
   {
      Print("Skip — spread $", DoubleToString(sp, 2),
            " > MaxSpreadUsd $", DoubleToString(MaxSpreadUsd, 2));
      return false;
   }
   return true;
}

bool TradeAllowedNow()
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   {
      Print("Terminal trade disabled.");
      return false;
   }
   if(RequireAlgoTradingOn && !MQLInfoInteger(MQL_TRADE_ALLOWED))
   {
      Print("Algo Trading OFF — enable toolbar AutoTrading.");
      return false;
   }
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
   {
      Print("Account experts disabled.");
      return false;
   }
   return true;
}

void SetFillingMode()
{
   long modes = SymbolInfoInteger(g_sym, SYMBOL_FILLING_MODE);
   if((modes & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
      trade.SetTypeFilling(ORDER_FILLING_IOC);
   else if((modes & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
      trade.SetTypeFilling(ORDER_FILLING_FOK);
   else
      trade.SetTypeFilling(ORDER_FILLING_RETURN);
}

//--- exposure ---------------------------------------------------------------
bool HasOpenPosition(const ulong magic)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionSelectByTicket(ticket) &&
         PositionGetString(POSITION_SYMBOL) == g_sym &&
         (ulong)PositionGetInteger(POSITION_MAGIC) == magic) return true;
   }
   return false;
}

bool HasPendingOrder(const ulong magic)
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0 && OrderSelect(ticket) &&
         OrderGetString(ORDER_SYMBOL) == g_sym &&
         (ulong)OrderGetInteger(ORDER_MAGIC) == magic) return true;
   }
   return false;
}

bool HasExposure(const ulong magic)
{
   return HasOpenPosition(magic) || HasPendingOrder(magic);
}

void DeletePendingOrders(const ulong magic)
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0 && OrderSelect(ticket) &&
         OrderGetString(ORDER_SYMBOL) == g_sym &&
         (ulong)OrderGetInteger(ORDER_MAGIC) == magic)
      {
         trade.SetExpertMagicNumber(magic);
         trade.OrderDelete(ticket);
      }
   }
}

double LivePx(const string side)
{
   MqlTick tick;
   if(!FreshTick(tick)) return 0.0;
   return (side == "BUY") ? tick.ask : tick.bid;
}

bool IsAdversed(const string side, const double entry, const double px)
{
   if(side == "BUY") return (px < entry - MarketEntryTolerance);
   if(side == "SELL") return (px > entry + MarketEntryTolerance);
   return true;
}

bool CanLateMarket(const string side, const double entry)
{
   double px = LivePx(side);
   if(IsAdversed(side, entry, px)) return false;
   return (MathAbs(px - entry) <= MaxLateEntryDistance);
}

/** Portal trade still alive: live price between SL and TP1 → safe to join now. */
bool InsidePortalBand(const string side, const double portalSl, const double portalTp,
                      const double px)
{
   if(!(portalSl > 0.0 && portalTp > 0.0 && px > 0.0)) return false;
   double pad = 0.10;
   if(side == "BUY")
      return (px > portalSl + pad && px < portalTp - pad);
   if(side == "SELL")
      return (px < portalSl - pad && px > portalTp + pad);
   return false;
}

bool OrderOk(const bool submitted)
{
   if(!submitted) return false;
   uint retcode = trade.ResultRetcode();
   return (retcode == TRADE_RETCODE_DONE ||
           retcode == TRADE_RETCODE_DONE_PARTIAL ||
           retcode == TRADE_RETCODE_PLACED);
}

string BuildComment(const string tag, const long timestamp)
{
   string c = tag + ":" + IntegerToString(timestamp);
   if(StringLen(c) > 31) c = StringSubstr(c, 0, 31);
   return c;
}

string SeenKey(const string tag)
{
   return "ScalpingEA.DeskAutoEAGold.v202." + tag + "." +
          IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN));
}

bool AlreadyHandled(const string tag, const long timestamp)
{
   string key = SeenKey(tag);
   if(!GlobalVariableCheck(key)) return false;
   return ((long)GlobalVariableGet(key) == timestamp);
}

void MarkHandled(const string tag, const long timestamp)
{
   GlobalVariableSet(SeenKey(tag), (double)timestamp);
}

bool IsStaleLock(const long stampMs)
{
   if(stampMs <= 0) return true;
   long nowMs = (long)TimeGMT() * 1000;
   long age = nowMs - stampMs;
   if(age < 0) age = -age; // clock skew
   long maxAge = (long)MaxSignalAgeMinutes * 60 * 1000;
   return (age > maxAge);
}

bool SubmitMarketLive(const string side, const ulong magic,
                      const string tag, const long timestamp,
                      const double lockEntry,
                      const double portalSl, const double portalTp)
{
   if(!TradeAllowedNow() || !SpreadOk()) return false;

   trade.SetExpertMagicNumber(magic);
   SetFillingMode();
   double px = LivePx(side);
   if(!(px > 0.0))
   {
      Print(tag, " market wait — no fresh tick");
      return false;
   }
   double sl = 0.0, tp = 0.0;
   double geomEntry = (lockEntry > 0.0) ? lockEntry : px;
   if(!ResolveStops(side, geomEntry, px, portalSl, portalTp, sl, tp)) return false;
   if(side == "BUY" && px >= tp)
   {
      Print(tag, " skip market — live >= TP ", tp);
      return false;
   }
   if(side == "SELL" && px <= tp)
   {
      Print(tag, " skip market — live <= TP ", tp);
      return false;
   }
   if(side == "BUY" && !(sl < px))
   {
      Print(tag, " skip market — SL not below live");
      return false;
   }
   if(side == "SELL" && !(sl > px))
   {
      Print(tag, " skip market — SL not above live");
      return false;
   }

   double lots = NormalizeLots(FixedLots);
   if(!(lots > 0.0))
   {
      Print(tag, " invalid lots");
      return false;
   }
   string comment = BuildComment(tag, timestamp);
   bool ok = (side == "BUY")
             ? trade.Buy(lots, g_sym, 0.0, sl, tp, comment)
             : trade.Sell(lots, g_sym, 0.0, sl, tp, comment);
   ok = OrderOk(ok);
   if(!ok)
      Print(tag, " market failed: ", trade.ResultRetcode(), " ",
            trade.ResultRetcodeDescription());
   else
      Print(tag, " MARKET ", side, " lots=", lots, " @~", px,
            " SL=", sl, " TP=", tp,
            UsePortalStops ? " (portal)" : " (fixed)",
            " magic=", magic, " id=", timestamp);
   return ok;
}

bool SubmitAtLockedEntry(const string side, double entry, const ulong magic,
                         const string tag, const long timestamp,
                         const double portalSl, const double portalTp)
{
   if(!TradeAllowedNow() || !SpreadOk()) return false;

   trade.SetExpertMagicNumber(magic);
   SetFillingMode();
   double sl = 0.0, tp = 0.0;
   if(!ResolveStops(side, entry, entry, portalSl, portalTp, sl, tp)) return false;

   entry = NormalizeDouble(entry, g_digits);
   double lots = NormalizeLots(FixedLots);
   if(!(lots > 0.0)) return false;

   double ask = 0.0, bid = 0.0;
   MqlTick tick;
   if(!FreshTick(tick))
   {
      Print(tag, " pending wait — no fresh tick");
      return false;
   }
   ask = tick.ask;
   bid = tick.bid;
   bool ok = false;
   string comment = BuildComment(tag, timestamp);

   if(side == "BUY")
   {
      if(MathAbs(ask - entry) <= MarketEntryTolerance)
         return SubmitMarketLive(side, magic, tag, timestamp, entry, portalSl, portalTp);
      if(ask > entry)
      {
         if(ask <= entry + MaxContinuationChase)
            return SubmitMarketLive(side, magic, tag, timestamp, entry, portalSl, portalTp);
         Print(tag, " skip — BUY chased past ", MaxContinuationChase,
               " from ", entry, " (ask=", ask, ")");
         return false;
      }
      ok = trade.BuyStop(lots, entry, g_sym, sl, tp, ORDER_TIME_GTC, 0, comment);
   }
   else if(side == "SELL")
   {
      if(MathAbs(bid - entry) <= MarketEntryTolerance)
         return SubmitMarketLive(side, magic, tag, timestamp, entry, portalSl, portalTp);
      if(bid < entry)
      {
         if(bid >= entry - MaxContinuationChase)
            return SubmitMarketLive(side, magic, tag, timestamp, entry, portalSl, portalTp);
         Print(tag, " skip — SELL chased past ", MaxContinuationChase,
               " from ", entry, " (bid=", bid, ")");
         return false;
      }
      ok = trade.SellStop(lots, entry, g_sym, sl, tp, ORDER_TIME_GTC, 0, comment);
   }
   else return false;

   ok = OrderOk(ok);
   if(!ok)
      Print(tag, " pending failed: ", trade.ResultRetcode(), " ",
            trade.ResultRetcodeDescription());
   else
      Print(tag, " PENDING ", side, " @ ", entry, " SL=", sl, " TP=", tp,
            UsePortalStops ? " (portal)" : " (fixed)",
            " magic=", magic, " id=", timestamp);
   return ok;
}

//--- module poll (same desk rules as prior single EAs) ----------------------
void PollModule(const string path, const string tag, const ulong magic,
                const string timeField)
{
   string json;
   if(!HttpGet(path, json)) return;

   string latest;
   if(!ExtractObject(json, "latest", latest))
   {
      DeletePendingOrders(magic);
      return;
   }

   string outcome, side;
   long stamp = 0;
   if(!JsonString(latest, "outcome", outcome)) return;
   if(!JsonString(latest, "direction", side)) return;
   if(side != "BUY" && side != "SELL") return;

   if(!JsonLong(latest, timeField, stamp))
   {
      if(!JsonLong(latest, "timestamp", stamp) &&
         !JsonLong(latest, "time", stamp))
         return;
   }

   if(outcome != "OPEN")
   {
      DeletePendingOrders(magic);
      return;
   }

   double entry = 0.0;
   if(!JsonNumber(latest, "entry", entry) || !(entry > 0.0)) return;

   double portalSl = 0.0, portalTp = 0.0;
   JsonNumber(latest, "sl", portalSl);
   if(!JsonNumber(latest, "tp1", portalTp))
      JsonNumber(latest, "tp", portalTp);

   if(IsStaleLock(stamp))
   {
      if(!AlreadyHandled(tag, stamp))
      {
         MarkHandled(tag, stamp);
         Print(tag, " stale OPEN skipped id=", stamp,
               " (> ", MaxSignalAgeMinutes, "m)");
      }
      DeletePendingOrders(magic);
      return;
   }

   // Only real zone-touch stamp counts as filled. Do NOT map historyOpen→executed
   // (that flag is just "History has an OPEN row" — it caused Cipher pending misses).
   bool executed = !JsonValueIsNull(latest, "executedAt");

   if(AlreadyHandled(tag, stamp) || HasExposure(magic)) return;

   double pxNow = LivePx(side);
   if(!(pxNow > 0.0))
   {
      // Do not MarkHandled — retry next poll when tick is fresh.
      Print(tag, " wait — no fresh tick yet for ", side, " entry=", entry);
      return;
   }

   // TIMELY JOIN: portal lock still OPEN and price still between portal SL..TP1
   // → market now (fixes Cipher miss when poll lagged but trade not done yet).
   if(JoinIfInsidePortalBand &&
      InsidePortalBand(side, portalSl, portalTp, pxNow))
   {
      DeletePendingOrders(magic);
      if(SubmitMarketLive(side, magic, tag, stamp, entry, portalSl, portalTp))
      {
         MarkHandled(tag, stamp);
         Print(tag, " JOIN portal-band MARKET @~", pxNow,
               " entry=", entry, " SL=", portalSl, " TP=", portalTp);
      }
      return;
   }

   if(!executed)
   {
      DeletePendingOrders(magic);
      if(SubmitAtLockedEntry(side, entry, magic, tag, stamp, portalSl, portalTp))
         MarkHandled(tag, stamp);
      return;
   }

   if(!CanLateMarket(side, entry) &&
      !(JoinIfInsidePortalBand && InsidePortalBand(side, portalSl, portalTp, pxNow)))
   {
      // Only burn the lock if quote is clearly real and far. Huge portal↔broker
      // gap often meant a stale tick on VPS — keep retrying briefly.
      double gap = MathAbs(pxNow - entry);
      if(gap > 20.0)
      {
         Print(tag, " price gap $", DoubleToString(gap, 2),
               " entry=", entry, " live=", pxNow,
               " — not marking handled (possible stale/feed mismatch)");
         return;
      }
      MarkHandled(tag, stamp);
      Print(tag, " late skip — adversed/far and outside portal band. entry=",
            entry, " live=", pxNow, " SL=", portalSl, " TP=", portalTp);
      return;
   }
   DeletePendingOrders(magic);
   if(SubmitMarketLive(side, magic, tag, stamp, entry, portalSl, portalTp))
      MarkHandled(tag, stamp);
}

void PollAll()
{
   RefreshSymbolMeta();
   if(EnableQsPro)
      PollModule("/api/pulse/latest", "QSP", MagicQsPro, "timestamp");
   if(EnablePro)
      PollModule("/api/pro/latest", "PRO", MagicPro, "timestamp");
   if(EnableCipherB)
      PollModule("/api/cipherbclone/latest", "CIB", MagicCipherB, "time");
   if(EnableIntra30)
      PollModule("/api/intra30/latest", "I30", MagicIntra30, "timestamp");
   if(EnableFractal)
      PollModule("/api/fractal/latest", "FRA", MagicFractal, "time");
}

bool MagicsUnique()
{
   ulong m[5];
   m[0] = MagicQsPro; m[1] = MagicPro; m[2] = MagicCipherB;
   m[3] = MagicIntra30; m[4] = MagicFractal;
   for(int i = 0; i < 5; i++)
      for(int j = i + 1; j < 5; j++)
         if(m[i] == m[j]) return false;
   return true;
}

int OnInit()
{
   if(FixedLots <= 0.0 || FixedTpSlDistance <= 0.0 ||
      MaxLateEntryDistance < 0.0 || MaxContinuationChase < 0.0 ||
      MaxSpreadUsd <= 0.0 || MaxSignalAgeMinutes < 1)
   {
      Print("Invalid inputs.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(!MagicsUnique())
   {
      Print("Magic numbers must be unique per module.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(RequireHedgingAccount &&
      AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
   {
      Print("Hedging account required for multi-module EA on one symbol.");
      return INIT_FAILED;
   }

   g_sym = TradeSymbol;
   StringTrimLeft(g_sym);
   StringTrimRight(g_sym);
   if(g_sym == "") g_sym = _Symbol;

   if(!SymbolSelect(g_sym, true))
   {
      Print("SymbolSelect failed: ", g_sym);
      return INIT_FAILED;
   }
   RefreshSymbolMeta();

   if(ForceChartM5 && (_Period != PERIOD_M5 || _Symbol != g_sym))
   {
      if(!ChartSetSymbolPeriod(0, g_sym, PERIOD_M5))
         Print("Warn: could not switch chart to ", g_sym, " M5");
   }
   else if(_Period != PERIOD_M5)
      Print("Note: attach on M5 recommended. Chart TF=",
            EnumToString((ENUM_TIMEFRAMES)_Period));

   trade.SetDeviationInPoints(MaxDeviationPoints);
   SetFillingMode();
   g_lastPollMs = 0;

   Print("DeskAutoEAGold v2.04 | symbol=", g_sym,
         " lots=", FixedLots,
         UsePortalStops ? " stops=PORTAL" : " stops=FIXED",
         " poll=", PollSeconds, "s tickMs=", TickPollMs,
         JoinIfInsidePortalBand ? " join=BAND" : "",
         " freshTick=ON");

   string onMods = "";
   if(EnableQsPro) onMods += " QSPro";
   if(EnablePro) onMods += " Pro";
   if(EnableCipherB) onMods += " CipherB";
   if(EnableIntra30) onMods += " Intra30";
   if(EnableFractal) onMods += " Fractal";
   if(onMods == "") onMods = " (none!)";
   Print("ON:", onMods);
   Print("OFF: Scalp / Quick Scalp / Intraday / Probeb",
         EnableFractal ? "" : " + Fractal(input=false)");
   Print("Magics QSP=", MagicQsPro, " PRO=", MagicPro,
         " CIB=", MagicCipherB, " I30=", MagicIntra30, " FRA=", MagicFractal);
   Print("Comments QSP:/PRO:/CIB:/I30:/FRA: + lock id");
   Print("IMPORTANT: remove other desk EAs from chart before attaching this one.");

   // Startup self-test — if this fails, every trade will be missed.
   {
      string probe;
      if(HttpGet("/api/pulse/latest", probe))
         Print("API SELF-TEST OK — portal reachable (HTTP 200).");
      else
         Print("API SELF-TEST FAIL — fix WebRequest URL allow-list + VPS Migrate BEFORE expecting fills.");
   }

   EventSetTimer((int)MathMax(1, PollSeconds));
   PollAll();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   g_lastPollMs = GetTickCount();
   PollAll();
}

void OnTick()
{
   if(TickPollMs <= 0) return;
   ulong now = GetTickCount();
   if(g_lastPollMs != 0 && (now - g_lastPollMs) < (ulong)TickPollMs) return;
   g_lastPollMs = now;
   PollAll();
}
