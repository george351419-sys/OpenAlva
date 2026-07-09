# Altra 策略定义完整示例（源自 Alva 内部 references/altra-trading.md，2026-07-09）

MACD 金叉/死叉策略，官方推荐的多文件组织方式。要点：

- 工程组织：`constants.js` / `features.js` / `strategy.js` / `main.js` 分文件，`main.js` 组装。
- `TIME` 常量从 `FeedAltraModule` 导出（如 `TIME.DAY`）。
- `simOptions.simTick` 可比策略周期更细（示例：1d 策略用 `simTick: "1min"` 模拟成交）。
- 策略返回值可带 `logs` 字段（如 warmup 期）：`{ target: null, state, logs: "warmup" }`。
- feature 数据按名字挂在 `ctx.data.features["macd"]`，OHLCV 挂在 `ctx.data.ohlcvs[SYMBOL][interval]`。
- symbol 命名两套体系：美股/美元现货 `US_SPOT_BTC_USD`（exchange=US, fee_rate=0），Binance 现货 `BINANCE_SPOT_BNB_USDT`（fee_rate=0.001）——见 playbook.json 的 `metadata.trading_pairs`。

```js
// constants.js
const { FeedAltraModule } = require("@alva/feed");
const { TIME } = FeedAltraModule;

const SYMBOL = "BINANCE_SPOT_BTC_USDT";
const STRATEGY_INTERVAL = "1d";
const TICK = TIME.DAY;

module.exports = { SYMBOL, STRATEGY_INTERVAL, TICK, TIME };
```

```js
// strategy.js
const { SYMBOL, STRATEGY_INTERVAL } = require("./constants.js");

const initialState = { lastSignal: null };

function strategyFn(ctx) {
  const { tick, data, portfolio, state } = ctx;

  const bars = data.ohlcvs[SYMBOL]?.[STRATEGY_INTERVAL] || [];
  if (!bars) throw new Error("OHLCV not found for " + SYMBOL);

  const macdData = data.features["macd"];
  if (!macdData) throw new Error('Feature "macd" not found');

  if (bars.length === 0 || macdData.length < 2) {
    return { target: null, state, logs: "warmup" };
  }

  const currMACD = macdData[macdData.length - 1];
  const prevMACD = macdData[macdData.length - 2];

  const pos = portfolio.positions.find((p) => p.symbol === SYMBOL);
  const hasPosition = pos && pos.qty > 0;

  const bullishCross =
    prevMACD.macd_line <= prevMACD.signal_line &&
    currMACD.macd_line > currMACD.signal_line;
  const bearishCross =
    prevMACD.macd_line >= prevMACD.signal_line &&
    currMACD.macd_line < currMACD.signal_line;

  if (bullishCross && !hasPosition) {
    return {
      target: {
        date: tick,
        instruction: { type: "allocate", weights: [{ symbol: SYMBOL, weight: 1.0 }] },
        meta: { reason: "MACD bullish crossover" },
      },
      state: { ...state, lastSignal: "buy" },
    };
  }

  if (bearishCross && hasPosition) {
    return {
      target: {
        date: tick,
        instruction: { type: "allocate", weights: [{ symbol: SYMBOL, weight: 0.0 }] },
        meta: { reason: "MACD bearish crossover" },
      },
      state: { ...state, lastSignal: "sell" },
    };
  }

  return { target: null, state };
}

module.exports = { strategyFn, initialState };
```

```js
// main.js
const { FeedAltraModule, createArraysOhlcvProvider } = require("@alva/feed");
const { FeedAltra, e } = FeedAltraModule;
const secret = require("secret-manager");

const { SYMBOL, STRATEGY_INTERVAL } = require("./constants.js");
const { createMACDFeature } = require("./features.js");
const { strategyFn, initialState } = require("./strategy.js");

const START_DATE = Date.parse("2025-01-01T00:00:00.000Z");
const END_DATE = Date.now();

const ARRAYS_JWT = secret.loadPlaintext("ARRAYS_JWT");
const ohlcvProvider = createArraysOhlcvProvider({ jwt: ARRAYS_JWT });

const altra = new FeedAltra(
  {
    path: "~/feeds/macd-strategy/v1",
    startDate: START_DATE,
    portfolioOptions: { initialCash: 1_000_000, currency: "USDT" },
    simOptions: { simTick: "1min", feeRate: 0.001 },
    perfOptions: { timezone: "UTC", marketType: "crypto" },
  },
  ohlcvProvider,
);

const dataGraph = altra.getDataGraph();
dataGraph.registerOhlcv(SYMBOL, STRATEGY_INTERVAL);
dataGraph.registerFeature(createMACDFeature());

altra.setStrategy(strategyFn, {
  trigger: { type: "events", expr: e.ohlcv(SYMBOL, STRATEGY_INTERVAL) },
  inputConfig: {
    ohlcvs: [{ id: { pair: SYMBOL, interval: STRATEGY_INTERVAL } }],
    features: [{ id: "macd", lookback: { count: 1 } }],
  },
  initialState,
});

(async () => {
  const result = await altra.run(END_DATE);
})();
```

## 前端 viewer token 注入（index.html 真实代码）

```js
function createAlvaClientConfig() {
  const params = new URLSearchParams(window.location.search);
  const pbsvToken = window.alva?.udf?.getViewerToken?.();   // playbook-scoped viewer token
  const apiOrigin = params.get("api_origin");               // API 地址可由宿主页注入
  return {
    ...(pbsvToken ? { pbsvToken } : {}),
    ...(apiOrigin ? { baseUrl: apiOrigin.replace(/\/$/, "") } : {}),
  };
}
```

另注：Alva 会话侧的内部文档路径是 `.claude/skills/alva/references/altra-trading.md`——Alva 的 agent 层用的就是 Claude Code 同款 skill 目录结构。
