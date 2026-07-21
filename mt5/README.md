# MT5 auto-trading EAs

These are two independent Expert Advisors:

- `MainIntradayAutoEA.mq5`
- `QSProAutoEA.mq5`

They do **not** reimplement or change the strategy formulas. Both poll the
production signal desk and trade its authoritative frozen entry, SL, and TP1:

- Main Intraday: `/api/plan/current?assetId=XAUUSD&mode=intraday`
- QS Pro: `/api/pulse/latest`

## Important account requirement

Use an MT5 **hedging account** when both EAs run on XAUUSD. A netting account
merges both strategies into one symbol position, so the EAs cannot manage their
trades independently. Both EAs refuse to start on a non-hedging account by
default.

## Install

1. In MT5, select **File → Open Data Folder**.
2. Open `MQL5/Experts`.
3. Copy both `.mq5` files there.
4. Open each file in MetaEditor and press **F7** to compile.
5. In MT5, open **Tools → Options → Expert Advisors**.
6. Enable algorithmic trading and add this allowed WebRequest URL:

   `https://scalping-production.up.railway.app`

7. Attach each EA to a separate XAUUSD chart.
8. Turn on **Algo Trading**.

## Default trade settings

- Fixed lot: `0.20`
- Fixed TP/SL distance: `$3.00` from entry (`FixedTpSlDistance = 3.00`)
  - BUY 4080 → TP 4083, SL 4077
  - SELL 4080 → TP 4077, SL 4083
- Main Intraday magic: `26072201`
- QS Pro magic: `26072202`
- Poll interval: 5 seconds
- TP/SL: fixed symmetric `$3.00`; module direction and locked entry stay unchanged
- Entry: exact locked entry using Limit/Stop pending order, or market only when
  price is within `MarketEntryTolerance` (default 0.05).

If your broker uses a suffix such as `XAUUSD.a`, change `TradeSymbol` in the EA
inputs.

## Safety behavior

- One active order/position per EA magic number.
- Persistent signal deduplication across MT5 restarts.
- Pending order is removed if the server lock disappears or is invalidated.
- Existing positions are not closed when the API lock disappears; broker-side
  SL/TP remain responsible for the exit.
- Waiting locks: place Limit/Stop at the locked entry (or market if already there).
- Already-executed History locks (`IN_TRADE_HINT` / `executedAt` set): take a
  **market** fill only while live price is still inside the fixed ±$3.00 band
  around the locked entry. Outside that band the lock is marked handled and
  skipped — no deep chase.

## If History shows EXECUTED but MT5 is flat

1. Re-copy these `.mq5` files into `MQL5/Experts` and recompile (**F7**).
2. Confirm WebRequest URL allow-list includes
   `https://scalping-production.up.railway.app`.
3. Confirm Algo Trading is ON and the chart symbol matches `TradeSymbol`
   (use your broker suffix if needed, e.g. `XAUUSD.a`).
4. Check Experts log for `late MARKET fill` or `late entry skipped`.
5. If price already moved more than ±$3.00 from the locked entry, the EA will
   correctly refuse the late fill.

Test both EAs on a demo account first. Broker symbol digits, minimum stop
distance, allowed lot step, and execution mode can differ.
