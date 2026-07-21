#property strict
#property version   "1.01"
#property description "Main Intraday auto-trader. Consumes authoritative production session locks."

#include <Trade/Trade.mqh>

input string ApiBaseUrl = "https://scalping-production.up.railway.app";
input string TradeSymbol = "XAUUSD";
input double FixedLots = 0.20;
input int PollSeconds = 5;
input int HttpTimeoutMs = 10000;
input double MarketEntryTolerance = 0.05;
input double FixedTpSlDistance = 3.00;
input ulong MagicNumber = 26072201;
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

bool PriceStillInsideFixedBand(const string side, const double entry)
{
   double ask = SymbolInfoDouble(TradeSymbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(TradeSymbol, SYMBOL_BID);
   double px = (side == "BUY") ? ask : bid;
   return (px >= entry - FixedTpSlDistance && px <= entry + FixedTpSlDistance);
}

bool SubmitMarket(const string side, double entry, const string signalKey)
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
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   double lots = NormalizeLots(FixedLots);
   string comment = "MainIntraday:" + signalKey;
   bool ok = false;

   if(side == "BUY")
      ok = trade.Buy(lots, TradeSymbol, 0.0, sl, tp, comment);
   else
      ok = trade.Sell(lots, TradeSymbol, 0.0, sl, tp, comment);

   if(ok)
   {
      uint retcode = trade.ResultRetcode();
      ok = (retcode == TRADE_RETCODE_DONE ||
            retcode == TRADE_RETCODE_DONE_PARTIAL ||
            retcode == TRADE_RETCODE_PLACED);
   }
   if(!ok)
      Print("Market order failed: ", trade.ResultRetcode(), " ",
            trade.ResultRetcodeDescription());
   return ok;
}

bool SubmitAtLockedEntry(const string side, double entry, const string signalKey)
{
   double sl = 0.0;
   double tp = 0.0;
   // User execution profile: fixed 30-pip ($3.00) symmetric exit from entry.
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
   string comment = "MainIntraday:" + signalKey;

   if(side == "BUY")
   {
      if(MathAbs(ask - entry) <= MarketEntryTolerance)
         ok = trade.Buy(lots, TradeSymbol, 0.0, sl, tp, comment);
      else if(entry < ask)
         ok = trade.BuyLimit(lots, entry, TradeSymbol, sl, tp,
                             ORDER_TIME_GTC, 0, comment);
      else
         ok = trade.BuyStop(lots, entry, TradeSymbol, sl, tp,
                            ORDER_TIME_GTC, 0, comment);
   }
   else if(side == "SELL")
   {
      if(MathAbs(bid - entry) <= MarketEntryTolerance)
         ok = trade.Sell(lots, TradeSymbol, 0.0, sl, tp, comment);
      else if(entry > bid)
         ok = trade.SellLimit(lots, entry, TradeSymbol, sl, tp,
                              ORDER_TIME_GTC, 0, comment);
      else
         ok = trade.SellStop(lots, entry, TradeSymbol, sl, tp,
                             ORDER_TIME_GTC, 0, comment);
   }

   if(ok)
   {
      uint retcode = trade.ResultRetcode();
      ok = (retcode == TRADE_RETCODE_DONE ||
            retcode == TRADE_RETCODE_DONE_PARTIAL ||
            retcode == TRADE_RETCODE_PLACED);
   }
   if(!ok)
      Print("Order failed: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   return ok;
}

bool AlreadyHandled(const long lockedAt)
{
   if(!GlobalVariableCheck(globalSeenKey)) return false;
   return ((long)GlobalVariableGet(globalSeenKey) == lockedAt);
}

void MarkHandled(const long lockedAt)
{
   GlobalVariableSet(globalSeenKey, (double)lockedAt);
}

void PollSignal()
{
   string json;
   if(!HttpGet("/api/plan/current?assetId=XAUUSD&mode=intraday", json)) return;

   string plan;
   if(!ExtractObject(json, "plan", plan))
   {
      // No active lock: cancel orphans, keep open positions with broker SL/TP.
      DeletePendingOrders();
      return;
   }

   string status, side, levels;
   long lockedAt = 0;
   if(!JsonString(plan, "status", status) ||
      !JsonString(plan, "side", side) ||
      !JsonLong(plan, "lockedAt", lockedAt) ||
      !ExtractObject(plan, "levels", levels)) return;

   if(status == "INVALIDATED")
   {
      DeletePendingOrders();
      return;
   }

   double entry = 0.0;
   if(!JsonNumber(levels, "entry", entry)) return;

   // Already traded / armed this lock, or already have exposure.
   if(AlreadyHandled(lockedAt) || HasExposure()) return;

   // Waiting: arm limit/stop at the locked entry (or market if already there).
   if(status == "WAITING_ENTRY")
   {
      DeletePendingOrders();
      if(SubmitAtLockedEntry(side, entry, IntegerToString(lockedAt)))
      {
         MarkHandled(lockedAt);
         Print("Main Intraday WAITING armed: ", side, " @ ", entry,
               " fixed TP/SL ", FixedTpSlDistance);
      }
      return;
   }

   // History EXECUTED / UI active trade: server already marked entry hit.
   // Previous EA versions skipped this and left MT5 flat. Catch up with a
   // market order only while price is still inside the fixed ±$3.00 band.
   if(status == "IN_TRADE_HINT")
   {
      if(!PriceStillInsideFixedBand(side, entry))
      {
         MarkHandled(lockedAt);
         Print("Main Intraday late entry skipped — price already outside ±",
               FixedTpSlDistance, " of ", entry);
         return;
      }
      DeletePendingOrders();
      if(SubmitMarket(side, entry, IntegerToString(lockedAt)))
      {
         MarkHandled(lockedAt);
         Print("Main Intraday late MARKET fill: ", side, " locked entry ", entry,
               " fixed TP/SL ", FixedTpSlDistance);
      }
   }
}

int OnInit()
{
   if(FixedTpSlDistance <= 0.0)
   {
      Print("FixedTpSlDistance must be greater than zero.");
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
   globalSeenKey = "ScalpingEA.MainIntraday." + (string)AccountInfoInteger(ACCOUNT_LOGIN);
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
