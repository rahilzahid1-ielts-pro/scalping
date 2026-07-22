#property strict
#property version   "1.02"
#property description "QS Pro auto-trader. Consumes authoritative production Pulse locks."

#include <Trade/Trade.mqh>

input string ApiBaseUrl = "https://scalping-production.up.railway.app";
input string TradeSymbol = "XAUUSD";
input double FixedLots = 0.20;
input int PollSeconds = 5;
input int HttpTimeoutMs = 10000;
input double MarketEntryTolerance = 0.05;
input double FixedTpSlDistance = 3.00;
// Late History-EXECUTED catch-up: only if price still this close to locked entry
// and NOT already moving against the side (prevents buying into a dump).
input double MaxLateEntryDistance = 0.50;
// While WAITING: if price already ran past entry in the signal direction by up
// to this amount, take market (catch fast continuation) instead of Limit wait.
input double MaxContinuationChase = 1.50;
input ulong MagicNumber = 26072202;
input int MaxDeviationPoints = 50;
input bool RequireHedgingAccount = true;

CTrade trade;
string globalSeenKey;

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
      Print("WebRequest failed: ", GetLastError(),
            ". Add ", ApiBaseUrl, " to MT5 Tools > Options > Expert Advisors.");
      return false;
   }
   if(code != 200)
   {
      Print("API HTTP ", code);
      return false;
   }
   body = CharArrayToString(response, 0, -1, CP_UTF8);
   return true;
}

double NormalizeLots(const double requested)
{
   double minLot = SymbolInfoDouble(TradeSymbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(TradeSymbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(TradeSymbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = 0.01;
   double lots = MathMax(minLot, MathMin(maxLot, requested));
   lots = MathFloor(lots / step + 0.5) * step;
   return NormalizeDouble(lots, 2);
}

bool HasOpenPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionSelectByTicket(ticket) &&
         PositionGetString(POSITION_SYMBOL) == TradeSymbol &&
         (ulong)PositionGetInteger(POSITION_MAGIC) == MagicNumber) return true;
   }
   return false;
}

bool HasPendingOrder()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0 && OrderSelect(ticket) &&
         OrderGetString(ORDER_SYMBOL) == TradeSymbol &&
         (ulong)OrderGetInteger(ORDER_MAGIC) == MagicNumber) return true;
   }
   return false;
}

bool HasExposure()
{
   return HasOpenPosition() || HasPendingOrder();
}

void DeletePendingOrders()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0 && OrderSelect(ticket) &&
         OrderGetString(ORDER_SYMBOL) == TradeSymbol &&
         (ulong)OrderGetInteger(ORDER_MAGIC) == MagicNumber)
      {
         trade.OrderDelete(ticket);
      }
   }
}

double LivePx(const string side)
{
   return (side == "BUY")
          ? SymbolInfoDouble(TradeSymbol, SYMBOL_ASK)
          : SymbolInfoDouble(TradeSymbol, SYMBOL_BID);
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

bool SubmitMarketLive(const string side, const string signalKey)
{
   double px = LivePx(side);
   double sl = 0.0;
   double tp = 0.0;
   if(side == "BUY")
   {
      sl = px - FixedTpSlDistance;
      tp = px + FixedTpSlDistance;
   }
   else if(side == "SELL")
   {
      sl = px + FixedTpSlDistance;
      tp = px - FixedTpSlDistance;
   }
   else return false;

   int digits = (int)SymbolInfoInteger(TradeSymbol, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   double lots = NormalizeLots(FixedLots);
   string comment = "QSPro:" + signalKey;
   bool ok = (side == "BUY")
             ? trade.Buy(lots, TradeSymbol, 0.0, sl, tp, comment)
             : trade.Sell(lots, TradeSymbol, 0.0, sl, tp, comment);
   ok = OrderOk(ok);
   if(!ok)
      Print("Market order failed: ", trade.ResultRetcode(), " ",
            trade.ResultRetcodeDescription());
   return ok;
}

bool SubmitAtLockedEntry(const string side, double entry, const string signalKey)
{
   double sl = 0.0;
   double tp = 0.0;
   if(side == "BUY")
   {
      sl = entry - FixedTpSlDistance;
      tp = entry + FixedTpSlDistance;
   }
   else if(side == "SELL")
   {
      sl = entry + FixedTpSlDistance;
      tp = entry - FixedTpSlDistance;
   }
   else return false;

   int digits = (int)SymbolInfoInteger(TradeSymbol, SYMBOL_DIGITS);
   entry = NormalizeDouble(entry, digits);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   double lots = NormalizeLots(FixedLots);
   double ask = SymbolInfoDouble(TradeSymbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(TradeSymbol, SYMBOL_BID);
   bool ok = false;
   string comment = "QSPro:" + signalKey;

   if(side == "BUY")
   {
      if(MathAbs(ask - entry) <= MarketEntryTolerance)
         return SubmitMarketLive(side, signalKey);
      if(ask > entry)
      {
         if(ask <= entry + MaxContinuationChase)
            return SubmitMarketLive(side, signalKey);
         Print("QS Pro skip — BUY already chased past ",
               MaxContinuationChase, " from ", entry, " (ask=", ask, ")");
         return false;
      }
      ok = trade.BuyStop(lots, entry, TradeSymbol, sl, tp,
                         ORDER_TIME_GTC, 0, comment);
   }
   else if(side == "SELL")
   {
      if(MathAbs(bid - entry) <= MarketEntryTolerance)
         return SubmitMarketLive(side, signalKey);
      if(bid < entry)
      {
         if(bid >= entry - MaxContinuationChase)
            return SubmitMarketLive(side, signalKey);
         Print("QS Pro skip — SELL already chased past ",
               MaxContinuationChase, " from ", entry, " (bid=", bid, ")");
         return false;
      }
      ok = trade.SellStop(lots, entry, TradeSymbol, sl, tp,
                          ORDER_TIME_GTC, 0, comment);
   }

   ok = OrderOk(ok);
   if(!ok)
      Print("Order failed: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   return ok;
}

bool AlreadyHandled(const long timestamp)
{
   if(!GlobalVariableCheck(globalSeenKey)) return false;
   return ((long)GlobalVariableGet(globalSeenKey) == timestamp);
}

void MarkHandled(const long timestamp)
{
   GlobalVariableSet(globalSeenKey, (double)timestamp);
}

void PollSignal()
{
   string json;
   if(!HttpGet("/api/pulse/latest", json)) return;

   string latest;
   if(!ExtractObject(json, "latest", latest))
   {
      DeletePendingOrders();
      return;
   }

   string outcome, side;
   long timestamp = 0;
   if(!JsonString(latest, "outcome", outcome) ||
      !JsonString(latest, "direction", side) ||
      !JsonLong(latest, "timestamp", timestamp)) return;

   if(outcome != "OPEN")
   {
      DeletePendingOrders();
      return;
   }

   double entry = 0.0;
   if(!JsonNumber(latest, "entry", entry)) return;

   bool executed = !JsonValueIsNull(latest, "executedAt");

   if(AlreadyHandled(timestamp) || HasExposure()) return;

   if(!executed)
   {
      DeletePendingOrders();
      if(SubmitAtLockedEntry(side, entry, IntegerToString(timestamp)))
      {
         MarkHandled(timestamp);
         Print("QS Pro WAITING armed: ", side, " @ ", entry,
               " fixed TP/SL ", FixedTpSlDistance);
      }
      else
      {
         double px = LivePx(side);
         if((side == "BUY" && px > entry + MaxContinuationChase) ||
            (side == "SELL" && px < entry - MaxContinuationChase))
            MarkHandled(timestamp);
      }
      return;
   }

   if(!CanLateMarket(side, entry))
   {
      MarkHandled(timestamp);
      Print("QS Pro late entry skipped — adversed or farther than ",
            MaxLateEntryDistance, " from ", entry, " (live=", LivePx(side), ")");
      return;
   }
   DeletePendingOrders();
   if(SubmitMarketLive(side, IntegerToString(timestamp)))
   {
      MarkHandled(timestamp);
      Print("QS Pro late MARKET fill near entry ", entry,
            " live=", LivePx(side));
   }
}

int OnInit()
{
   if(FixedTpSlDistance <= 0.0 || MaxLateEntryDistance < 0.0 ||
      MaxContinuationChase < 0.0)
   {
      Print("Invalid distance inputs.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(RequireHedgingAccount &&
      AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
   {
      Print("This EA requires a HEDGING account when running both EAs on XAUUSD.");
      return INIT_FAILED;
   }
   if(!SymbolSelect(TradeSymbol, true)) return INIT_FAILED;
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(MaxDeviationPoints);
   trade.SetTypeFillingBySymbol(TradeSymbol);
   globalSeenKey = "ScalpingEA.QSPro." + (string)AccountInfoInteger(ACCOUNT_LOGIN);
   EventSetTimer((int)MathMax(1, PollSeconds));
   PollSignal();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   PollSignal();
}
