#property copyright "Scalping desk"
#property strict
#property version   "1.10"
#property description "LIVE final: QS Pro + Pro + Cipher B + Fractal. Same desk API rules. Unique magic/comment per module."

#include <Trade/Trade.mqh>

//--- desk / trade -----------------------------------------------------------
input string ApiBaseUrl            = "https://scalping-production.up.railway.app";
input string TradeSymbol           = "";          // empty = chart symbol (use broker suffix if needed)
input double FixedLots             = 0.01;
input int    PollSeconds           = 5;
input int    HttpTimeoutMs         = 10000;
input double MarketEntryTolerance  = 0.05;
input double FixedTpSlDistance     = 3.00;        // same as prior EAs (±$3)
input double MaxLateEntryDistance  = 0.50;
input double MaxContinuationChase  = 1.50;
input int    MaxDeviationPoints    = 50;
input bool   RequireHedgingAccount = true;

//--- live safety ------------------------------------------------------------
input double MaxSpreadUsd          = 0.80;        // skip if bid/ask spread wider
input int    MaxSignalAgeMinutes   = 90;          // ignore stale OPEN locks after restart
input bool   RequireAlgoTradingOn  = true;
input bool   ForceChartM5          = false;       // live: leave false (avoids re-init loop)

//--- modules ----------------------------------------------------------------
input bool   EnableQsPro           = true;
input bool   EnablePro             = true;
input bool   EnableCipherB         = true;
input bool   EnableFractal         = true;

input ulong  MagicQsPro            = 26072202;
input ulong  MagicPro              = 26072203;
input ulong  MagicCipherB          = 26072204;
input ulong  MagicFractal          = 26072205;

CTrade trade;
string g_sym;
int    g_digits;
double g_point;
datetime g_lastHttpErrAt = 0;

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

bool JsonBoolTrue(const string json, const string key)
{
   int p = StringFind(json, "\"" + key + "\"");
   if(p < 0) return false;
   p = StringFind(json, ":", p);
   if(p < 0) return false;
   p++;
   while(p < StringLen(json) && StringGetCharacter(json, p) <= ' ') p++;
   return StringSubstr(json, p, 4) == "true";
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
         Print("WebRequest failed err=", GetLastError(),
               " — allow URL: ", ApiBaseUrl);
      }
      return false;
   }
   if(code != 200)
   {
      if(TimeCurrent() - g_lastHttpErrAt >= 60)
      {
         g_lastHttpErrAt = TimeCurrent();
         Print("API HTTP ", code, " path=", path);
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

bool ApplyStopDistance(const string side, const double anchor, double &sl, double &tp)
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

double CurrentSpreadUsd()
{
   double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
   if(!(ask > 0.0 && bid > 0.0)) return 999.0;
   return ask - bid;
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
   return (side == "BUY")
          ? SymbolInfoDouble(g_sym, SYMBOL_ASK)
          : SymbolInfoDouble(g_sym, SYMBOL_BID);
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
   return "ScalpingEA.Desk4.v110." + tag + "." +
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
                      const string tag, const long timestamp)
{
   if(!TradeAllowedNow() || !SpreadOk()) return false;

   trade.SetExpertMagicNumber(magic);
   SetFillingMode();
   double px = LivePx(side);
   double sl = 0.0, tp = 0.0;
   if(!ApplyStopDistance(side, px, sl, tp)) return false;

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
            " SL=", sl, " TP=", tp, " magic=", magic, " id=", timestamp);
   return ok;
}

bool SubmitAtLockedEntry(const string side, double entry, const ulong magic,
                         const string tag, const long timestamp)
{
   if(!TradeAllowedNow() || !SpreadOk()) return false;

   trade.SetExpertMagicNumber(magic);
   SetFillingMode();
   double sl = 0.0, tp = 0.0;
   if(!ApplyStopDistance(side, entry, sl, tp)) return false;

   entry = NormalizeDouble(entry, g_digits);
   double lots = NormalizeLots(FixedLots);
   if(!(lots > 0.0)) return false;

   double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
   bool ok = false;
   string comment = BuildComment(tag, timestamp);

   if(side == "BUY")
   {
      if(MathAbs(ask - entry) <= MarketEntryTolerance)
         return SubmitMarketLive(side, magic, tag, timestamp);
      if(ask > entry)
      {
         if(ask <= entry + MaxContinuationChase)
            return SubmitMarketLive(side, magic, tag, timestamp);
         Print(tag, " skip — BUY chased past ", MaxContinuationChase,
               " from ", entry, " (ask=", ask, ")");
         return false;
      }
      ok = trade.BuyStop(lots, entry, g_sym, sl, tp, ORDER_TIME_GTC, 0, comment);
   }
   else if(side == "SELL")
   {
      if(MathAbs(bid - entry) <= MarketEntryTolerance)
         return SubmitMarketLive(side, magic, tag, timestamp);
      if(bid < entry)
      {
         if(bid >= entry - MaxContinuationChase)
            return SubmitMarketLive(side, magic, tag, timestamp);
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
            " magic=", magic, " id=", timestamp);
   return ok;
}

//--- module poll (same desk rules as prior single EAs) ----------------------
void PollModule(const string path, const string tag, const ulong magic,
                const string timeField, const bool hasExecutedAt)
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

   bool executed = false;
   if(hasExecutedAt)
      executed = !JsonValueIsNull(latest, "executedAt");
   else if(!JsonValueIsNull(latest, "executedAt"))
      executed = true; // if API ever adds it

   if(AlreadyHandled(tag, stamp) || HasExposure(magic)) return;

   if(!executed)
   {
      DeletePendingOrders(magic);
      if(SubmitAtLockedEntry(side, entry, magic, tag, stamp))
         MarkHandled(tag, stamp);
      else
      {
         double px = LivePx(side);
         if((side == "BUY" && px > entry + MaxContinuationChase) ||
            (side == "SELL" && px < entry - MaxContinuationChase))
            MarkHandled(tag, stamp);
      }
      return;
   }

   if(!CanLateMarket(side, entry))
   {
      MarkHandled(tag, stamp);
      Print(tag, " late skip — adversed or >", MaxLateEntryDistance,
            " from ", entry, " live=", LivePx(side));
      return;
   }
   DeletePendingOrders(magic);
   if(SubmitMarketLive(side, magic, tag, stamp))
      MarkHandled(tag, stamp);
}

void PollAll()
{
   RefreshSymbolMeta();
   if(EnableQsPro)
      PollModule("/api/pulse/latest", "QSP", MagicQsPro, "timestamp", true);
   if(EnablePro)
      PollModule("/api/pro/latest", "PRO", MagicPro, "timestamp", true);
   if(EnableCipherB)
      PollModule("/api/cipherbclone/latest", "CIB", MagicCipherB, "time", false);
   if(EnableFractal)
      PollModule("/api/fractal/latest", "FRA", MagicFractal, "time", false);
}

bool MagicsUnique()
{
   ulong m[4];
   m[0] = MagicQsPro; m[1] = MagicPro; m[2] = MagicCipherB; m[3] = MagicFractal;
   for(int i = 0; i < 4; i++)
      for(int j = i + 1; j < 4; j++)
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
      Print("Hedging account required for 4 modules on one symbol.");
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
      Print("Note: attach on M5 recommended (signals still from API). Chart TF=",
            EnumToString((ENUM_TIMEFRAMES)_Period));

   trade.SetDeviationInPoints(MaxDeviationPoints);
   SetFillingMode();

   Print("DeskFourAutoEA v1.10 LIVE · symbol=", g_sym,
         " lots=", FixedLots, " TP/SL ±", FixedTpSlDistance,
         " spreadMax $", MaxSpreadUsd);
   Print("Magics QSP=", MagicQsPro, " PRO=", MagicPro,
         " CIB=", MagicCipherB, " FRA=", MagicFractal);
   Print("Comments QSP:/PRO:/CIB:/FRA: + lock id · desk rules unchanged");
   Print("IMPORTANT: remove old QSPro/MainIntraday EAs from chart (same magics).");

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
   PollAll();
}
