# Polybot Intraday

An independent Polymarket crypto bot variant focused on `intraday take-profit first, settlement fallback`.

## What Is Different

Compared with the base lead-lag version, this build:

- opens positions from the same lead-lag signal engine
- computes a per-trade `takeProfitPrice`
- checks open positions every second by default
- exits intraday if the held side's `bestBid` reaches target
- can also take a late profit exit close to expiry
- only holds to settlement if no intraday exit is available

## Modes

- `dry-run`: signal logging only
- `paper`: simulated entry, intraday exit, and settlement fallback
- `live`: real market buy / market sell on the international CLOB

## Commands

```bash
npm install
npm run build
npm run dry-run
npm run paper -- --budget=5 --paper-balance=100
npm run live -- --budget=1 --coins=BTC,ETH --durations=5m
```

## State Directory

This version uses its own state directory by default:

```text
.intraday-state/
```

That keeps it separate from the original lead-lag bot.

## Intraday Exit Config

Optional overrides:

```bash
INTRADAY_CHECK_MS=1000
TAKE_PROFIT_MIN_PRICE_DELTA=0.03
TAKE_PROFIT_EDGE_FACTOR=0.45
TAKE_PROFIT_LAG_FACTOR=0.35
MIN_HOLD_SEC=8
FORCE_EXIT_SEC=18
FORCE_EXIT_MIN_ROI=0.01
```

These control:

- how often open positions are checked
- the default take-profit target above entry
- how much `edge` and `lag` influence the target
- minimum hold time before intraday exit is allowed
- late-profit exit behavior close to expiry

## Notes

- `paper` and `live` still share the same signal engine as the base strategy.
- `live` still targets the international CLOB and remains subject to region restrictions.
- For Safe/funder accounts, keep `POLYMARKET_SIGNATURE_TYPE` and `POLYMARKET_FUNDER_ADDRESS` aligned with the account that holds balance.
