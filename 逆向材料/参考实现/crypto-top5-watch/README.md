# Crypto Top 5 Watch

This playbook monitors the current top five non-stablecoin crypto assets by live market-cap ranking and separates real relative moves from broad crypto beta. It answers: which major crypto assets moved unusually over the last 10 calendar days, which moves were idiosyncratic versus BTC-driven, and whether any new major event should trigger a push alert.

## Data Sources & Freshness

- Universe: Arrays crypto screener `MARKET_CAP`, latest daily snapshot. The universe is rebuilt on every run and excludes stablecoins such as USDT, USDC, DAI, BUSD, FDUSD, USDE, USDS, PYUSD, and similar USD-pegged assets because they are not volatility-style investment watch assets.
- Spot price and volume: Arrays Binance spot USDT kline, daily bars for the 10-day history and 1-hour bars for current anomaly detection.
- Benchmark: BTC. BTC is scored against its own volatility baseline; every other asset is regressed against BTC and scored on residual moves.
- Derivatives context: Arrays Binance funding rate and open interest when available.
- Exchange-flow context: Arrays Binance exchange-flow data for BTC and ETH only. Other assets are labeled as not covered rather than filled with proxies.
- Catalyst context: Arrays market news with `BLOCKCHAIN` topic. News confirms or contextualizes a move; it is not used as a standalone price fact or as a single-source push trigger.
- Automation cadence: hourly, suitable for 24/7 crypto monitoring. Daily history uses completed UTC daily bars; current alerts can use recent 1-hour bars.

Fresh means the latest successful run has completed within two hourly cycles and the latest completed daily bar is shown in the Watch tab.

## Filter Rules

- Include the top five Binance USDT crypto pairs by latest Arrays `MARKET_CAP` snapshot after stablecoin exclusion.
- Use equal 20% weights because this is a watchlist, not a connected portfolio.
- Historical backfill is visible only. Existing P0/P1 candidates on the first run are marked as seen and the notification sidecar writes `<|SKIP_NOTIFICATION|>`.
- Future push alerts require a new current P0/P1 event, not an old historical event.

## Scoring Formula

For each asset:

```text
r_i,t = ln(close_i,t / close_i,t-1)
sigma_ewma = sqrt(EWMA(lambda=0.94, r_i,t^2))
sigma_mad  = 1.4826 * median(|r_i - median(r_i)|)
```

For non-BTC assets:

```text
r_i = alpha + beta * r_BTC + epsilon
z_idio = epsilon_t / sigma_epsilon
```

For BTC:

```text
z_idio = r_BTC,t / sigma_BTC
```

Crypto uses a stricter gate:

```text
k_surface = 2.0 * 1.25
k_push    = 2.5 * 1.25
k_force   = 3.5 * 1.25
```

Score:

```text
score = floor(100 * clip(
  0.30 * S +
  0.25 * I +
  0.15 * C +
  0.10 * novelty +
  0.20 * confluence -
  0.40 * noise_penalty,
  0, 1
))

S = 1 - exp(-abs(z_idio) / 1.5)
I = min(abs(return) * equal_weight / 1%, 1)
```

## Score Bands

- P0: hard event, score at least 80, or force-level confirmed move.
- P1: score 60-79 with confirmation.
- P2: score 40-59 or visible near-threshold move; interface only.
- P3: archived noise; not shown in the incident queue.

## Flag Definitions

- Residual move: asset return after removing BTC beta.
- RVOL: current notional volume versus recent average notional volume.
- Confirmation: abnormal volume, multiple timely catalyst items, or derivatives context.
- Noise penalty: applied when BTC explains most of the move, news is stale or weak, or crypto confirmation is missing.
- Alert state: first run and historical backfill are silent; future P0/P1 events use a cooldown by asset and signal type.

## Worked Example

The Watch tab recomputes the current top-ranked visible incident from the latest feed batch. The visible score is the factor-weighted score above, not a subjective label. A typical visible P2 may show:

```text
SOL daily residual move:
severity from |z_idio| around 2σ
impact from equal 20% watchlist weight
confidence from volume and source availability
confluence from confirmation fields
minus noise penalty
= score in the P2 band, interface only
```

## Blind Spots

- Market-cap ranking comes from the latest Arrays screener snapshot and can lag fast intraday ranking changes.
- Binance USDT spot pairs are the canonical price source; assets with fragmented venue liquidity may look different on other exchanges.
- Exchange-flow coverage is BTC/ETH only in this build.
- News is used conservatively and can miss venue-specific, governance, or exploit details not indexed in the market-news endpoint.
- This is monitoring and explanation, not investment advice or trade execution.
