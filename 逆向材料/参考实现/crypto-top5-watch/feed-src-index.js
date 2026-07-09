"use strict";

const {
  Feed,
  feedPath,
  makeDoc,
  str,
  num,
} = require("@alva/feed");

const http = require("net/http");
const secret = require("secret-manager");

const USERNAME = "george351419";
const PLAYBOOK = "crypto-top5-watch";
const FEED = "crypto-top5-watch";
const BASE_URL = "https://data-tools.prd.space.id";
const STABLES = {
  USDT: true,
  USDC: true,
  FDUSD: true,
  TUSD: true,
  DAI: true,
  BUSD: true,
  USDE: true,
  USDS: true,
  PYUSD: true,
  USD1: true,
  EUR: true,
};

const feed = new Feed({
  path: feedPath(FEED),
  name: "Crypto Top 5 Watch",
  description:
    "Monitors the current top five non-stablecoin crypto assets by market cap for relative volatility, residual moves, volume, funding, open interest, exchange-flow context, and quiet push alerts.",
});

feed.def("watch", {
  overview: makeDoc("Overview", "Latest monitor snapshot and aggregate counts", [
    str("as_of"),
    str("snapshot_date"),
    str("inclusion_policy"),
    str("universe_json"),
    str("counts_json"),
    str("benchmark_json"),
    str("freshness_json"),
    str("source_notes_json"),
  ]),
  assets: makeDoc("Assets", "Per-asset baselines, returns, and microstructure context", [
    str("symbol"),
    str("pair"),
    str("name"),
    num("rank"),
    num("market_cap"),
    num("last_close"),
    num("daily_return"),
    num("ten_day_return"),
    num("sigma_ewma"),
    num("sigma_mad"),
    num("sigma_eps"),
    num("beta_btc"),
    num("rvol_latest"),
    num("funding_latest"),
    num("open_interest_latest"),
    num("open_interest_change_24h"),
    num("exchange_netflow_latest"),
    str("capability_notes"),
    str("status"),
  ]),
  incidents: makeDoc("Incidents", "Ranked daily and intraday anomaly signals", [
    str("signal_id"),
    str("episode_key"),
    str("symbol"),
    str("tier"),
    str("timeframe"),
    str("event_time"),
    str("headline"),
    str("what_happened"),
    str("why_it_matters"),
    str("evidence"),
    str("noise_filters_checked"),
    str("ui_deep_link"),
    num("score"),
    num("asset_return"),
    num("btc_return"),
    num("residual_return"),
    num("z_idio"),
    num("rvol"),
    num("confidence"),
    num("portfolio_impact"),
  ]),
  timeline: makeDoc("Timeline", "Ten-calendar-day warning timeline", [
    str("day"),
    str("symbol"),
    str("tier"),
    str("headline"),
    num("asset_return"),
    num("btc_return"),
    num("z_idio"),
    num("rvol"),
    num("score"),
  ]),
});

feed.def("notify", {
  message: makeDoc("Notification", "Quiet ranked push alert sidecar", [
    str("title"),
    str("body"),
  ]),
});

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
}

function dayKey(msOrDate) {
  return new Date(msOrDate).toISOString().slice(0, 10);
}

function pct(x) {
  if (x === null || x === undefined || !isFinite(x)) return "n/a";
  return (x * 100).toFixed(2) + "%";
}

function median(values) {
  const xs = values.filter((x) => isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mean(values) {
  const xs = values.filter((x) => isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(values) {
  const xs = values.filter((x) => isFinite(x));
  if (!xs.length) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + Math.pow(x - m, 2), 0) / xs.length);
}

function ewmaSigma(values) {
  const xs = values.filter((x) => isFinite(x));
  if (!xs.length) return 0;
  const lambda = 0.94;
  let variance = xs[0] * xs[0];
  for (let i = 1; i < xs.length; i += 1) {
    variance = lambda * variance + (1 - lambda) * xs[i] * xs[i];
  }
  return Math.sqrt(variance);
}

function robustSigma(values) {
  const xs = values.filter((x) => isFinite(x));
  if (!xs.length) return 0;
  const med = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - med)));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function rankTier(score, zAbs, confirmed, hardEvent) {
  if (hardEvent || score >= 80 || (zAbs >= 4.375 && confirmed)) return "P0";
  if (score >= 60 && confirmed) return "P1";
  if (score >= 40 || zAbs >= 2.5) return "P2";
  return "P3";
}

function stripPair(pair) {
  return pair.endsWith("USDT") ? pair.slice(0, -4) : pair;
}

async function fetchJson(path, params, required) {
  const jwt = secret.loadPlaintext("ARRAYS_JWT");
  if (!jwt) throw new Error("ARRAYS_JWT missing");
  const url = BASE_URL + path + "?" + qs(params);
  const resp = await http.fetch(url, {
    headers: { Authorization: "Bearer " + jwt },
  });
  const body = await resp.json();
  if (required && (!resp.ok || body.success === false || !Array.isArray(body.data))) {
    throw new Error("Required source failed: " + path + " status=" + resp.status);
  }
  if (!resp.ok || body.success === false || !Array.isArray(body.data)) return [];
  return body.data;
}

async function optionalJson(path, params) {
  const data = await fetchJson(path, params, false);
  return Array.isArray(data) ? data : [];
}

async function getUniverse(nowSec) {
  const rows = await fetchJson(
    "/api/v1/crypto/screener/metrics",
    {
      snapshot: nowSec,
      metric_type: "MARKET_CAP",
      order_by: "DESC",
    },
    true,
  );
  const picked = [];
  for (const row of rows) {
    const base = stripPair(row.symbol || "");
    if (!base || STABLES[base]) continue;
    picked.push({
      symbol: base,
      pair: row.symbol,
      market_cap: Number(row.value),
      market_cap_date: row.date,
      snapshot_time: row.snapshot_time,
    });
    if (picked.length === 5) break;
  }
  if (picked.length < 5) {
    throw new Error("Unable to resolve top 5 non-stablecoin crypto universe");
  }
  return picked;
}

async function getDetails(symbol) {
  const rows = await optionalJson("/api/v1/crypto/detail", { symbol });
  return rows[0] || {};
}

async function getKlines(symbol, startSec, endSec, interval, limit) {
  const rows = await fetchJson(
    "/api/v1/crypto/binance/spot/usdt/kline",
    { symbol, start_time: startSec, end_time: endSec, interval, limit },
    true,
  );
  return rows
    .slice()
    .sort((a, b) => Date.parse(a.time_open) - Date.parse(b.time_open))
    .map((r) => ({
      time_open: r.time_open,
      time_close: r.time_close,
      open: Number(r.price_open),
      high: Number(r.price_high),
      low: Number(r.price_low),
      close: Number(r.price_close),
      volume: Number(r.volume),
    }))
    .filter((r) => isFinite(r.close) && r.close > 0);
}

async function getFunding(pair, startSec, endSec) {
  const rows = await optionalJson("/api/v1/crypto/funding-rate", {
    symbol: pair,
    start_time: startSec,
    end_time: endSec,
    limit: 100,
    exchange: "binance",
  });
  return rows.slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

async function getOpenInterest(pair, startSec, endSec) {
  const rows = await optionalJson("/api/v1/crypto/open-interest", {
    symbol: pair,
    start_time: startSec,
    end_time: endSec,
    interval: "1d",
    limit: 60,
    exchange: "binance",
  });
  return rows.slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

async function getExchangeFlows(symbol, startSec, endSec) {
  if (symbol !== "BTC" && symbol !== "ETH") return [];
  const rows = await optionalJson("/api/v1/crypto/exchange-flows", {
    symbol,
    start_time: startSec,
    end_time: endSec,
    window: "day",
    limit: 60,
  });
  return rows.slice().sort((a, b) => Number(a.datetime) - Number(b.datetime));
}

async function getNews(startSec, endSec) {
  return optionalJson("/api/v1/stocks/market-news", {
    start_time: startSec,
    end_time: endSec,
    topic: "BLOCKCHAIN",
    sort_by_type: "PUBLISHED_TIME",
    sort_by: "DESC",
    limit: 100,
  });
}

function returnsFromBars(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    out.push({
      day: dayKey(Date.parse(bars[i].time_open)),
      time: bars[i].time_open,
      date: Date.parse(bars[i].time_open),
      ret: Math.log(bars[i].close / bars[i - 1].close),
      simpleRet: bars[i].close / bars[i - 1].close - 1,
      close: bars[i].close,
      volume: bars[i].volume,
      volumeUsd: bars[i].volume * bars[i].close,
    });
  }
  return out;
}

function regress(assetReturns, btcByDay) {
  const pairs = assetReturns
    .map((r) => ({ x: btcByDay[r.day], y: r.ret }))
    .filter((p) => isFinite(p.x) && isFinite(p.y));
  if (pairs.length < 10) return { beta: 1, residuals: [] };
  const mx = mean(pairs.map((p) => p.x));
  const my = mean(pairs.map((p) => p.y));
  const vx = pairs.reduce((acc, p) => acc + Math.pow(p.x - mx, 2), 0);
  const cov = pairs.reduce((acc, p) => acc + (p.x - mx) * (p.y - my), 0);
  const beta = vx > 0 ? cov / vx : 1;
  const alpha = my - beta * mx;
  return {
    beta,
    residuals: assetReturns
      .map((r) => ({
        day: r.day,
        residual: isFinite(btcByDay[r.day]) ? r.ret - alpha - beta * btcByDay[r.day] : r.ret,
      }))
      .filter((r) => isFinite(r.residual)),
  };
}

function relevantNewsFor(symbol, name, newsRows, sinceSec) {
  const symNeedle = "CRYPTO:" + symbol;
  const nameNeedle = String(name || "").toLowerCase();
  return newsRows
    .filter((n) => Number(n.publish_time || 0) >= sinceSec)
    .filter((n) => {
      const tickerHit = (n.tickers || []).some((t) => String(t.ticker).toUpperCase() === symNeedle);
      const text = String((n.title || "") + " " + (n.summary || "")).toLowerCase();
      return tickerHit || text.indexOf(symbol.toLowerCase()) >= 0 || (nameNeedle && text.indexOf(nameNeedle) >= 0);
    })
    .slice(0, 3);
}

function scoreSignal(opts) {
  const zAbs = Math.abs(opts.zIdio || 0);
  const severity = 1 - Math.exp(-zAbs / 1.5);
  const impact = clamp(Math.abs(opts.ret || 0) * 0.2 / 0.01, 0, 1);
  const confidence = clamp((opts.dataConfidence || 0.75) * 0.5 * (1 + Math.min((opts.rvol || 0) / 3, 1)), 0, 1);
  const novelty = opts.novel ? 1 : 0.5;
  const confluence = 1 - (1 - (opts.confirmed ? 0.55 : 0)) * (1 - (opts.newsCount ? 0.25 : 0)) * (1 - (opts.oiConfirm ? 0.2 : 0));
  const noisePenalty = opts.noisePenalty || 0;
  return Math.floor(100 * clamp(0.3 * severity + 0.25 * impact + 0.15 * confidence + 0.1 * novelty + 0.2 * confluence - 0.4 * (noisePenalty / 5), 0, 1));
}

function buildDailyIncidents(asset, btcByDay, newsRows) {
  const incidents = [];
  const timeline = [];
  const lookback = asset.returns.slice(-10);
  for (const r of lookback) {
    const btcRet = asset.symbol === "BTC" ? r.ret : btcByDay[r.day] || 0;
    const residual = asset.symbol === "BTC" ? r.ret : r.ret - asset.beta * btcRet;
    const z = asset.sigma_eps > 0 ? residual / asset.sigma_eps : 0;
    const priorVols = asset.returns.filter((x) => x.day < r.day).slice(-20).map((x) => x.volumeUsd);
    const rvol = mean(priorVols) > 0 ? r.volumeUsd / mean(priorVols) : 1;
    const dayNews = relevantNewsFor(asset.symbol, asset.name, newsRows, Math.floor(r.date / 1000) - 6 * 3600)
      .filter((n) => Number(n.publish_time) <= Math.floor(r.date / 1000) + 30 * 3600);
    const confirmed = rvol >= 2 || dayNews.length >= 2;
    let noisePenalty = 0;
    const explained = r.ret !== 0 ? Math.abs((asset.beta * btcRet) / r.ret) : 0;
    if (asset.symbol !== "BTC" && Math.abs(z) < 2 && explained > 0.5) noisePenalty += 3;
    if (!confirmed && Math.abs(z) < 3.125) noisePenalty += 1;
    const score = scoreSignal({
      zIdio: z,
      ret: r.simpleRet,
      rvol,
      confirmed,
      newsCount: dayNews.length,
      oiConfirm: false,
      noisePenalty,
      dataConfidence: 0.8,
      novel: true,
    });
    const tier = rankTier(score, Math.abs(z), confirmed, false);
    const surfaceWorthy = Math.abs(z) >= 1.5 || (confirmed && score >= 55);
    if (tier !== "P3" && surfaceWorthy) {
      const signalId = `${asset.symbol}-${r.day}-daily-${tier}`.toLowerCase();
      const headline =
        `${asset.symbol} ${r.simpleRet >= 0 ? "上涨" : "下跌"} ${pct(r.simpleRet)}，残差 ${z.toFixed(1)}σ`;
      const evidence = [
        `日收益 ${pct(r.simpleRet)}；BTC 同日 ${pct(btcRet)}`,
        `残差 ${pct(residual)}，相对自身残差波动 ${z.toFixed(2)}σ`,
        `成交额 RVOL ${rvol.toFixed(2)}x${dayNews.length ? `；相关新闻 ${dayNews.length} 条` : ""}`,
      ].join("\n");
      incidents.push({
        signal_id: signalId,
        episode_key: `${asset.symbol}:daily-move`,
        symbol: asset.symbol,
        tier,
        timeframe: "1d",
        event_time: r.day,
        headline,
        what_happened: `${asset.name} 日线出现 ${Math.abs(z).toFixed(1)}σ 的相对异动。`,
        why_it_matters:
          asset.symbol === "BTC"
            ? "BTC 是本监控的基准资产，它的异常会影响整个 crypto beta。"
            : "该信号已扣除 BTC beta，优先捕捉单资产而非全市场噪音。",
        evidence,
        noise_filters_checked:
          "已检查 BTC 共振解释、成交量确认、新闻陈旧性和 crypto 1.25x 更高阈值。",
        ui_deep_link: `https://alva.ai/u/${USERNAME}/playbooks/${PLAYBOOK}#sig-${signalId}`,
        score,
        asset_return: r.simpleRet,
        btc_return: btcRet,
        residual_return: residual,
        z_idio: z,
        rvol,
        confidence: clamp(0.5 + Math.min(rvol, 3) / 6 + (dayNews.length ? 0.1 : 0), 0, 1),
        portfolio_impact: Math.abs(r.simpleRet) * 0.2,
      });
    }
    timeline.push({
      day: r.day,
      symbol: asset.symbol,
      tier,
      headline: tier === "P3" ? `${asset.symbol} 正常波动` : `${asset.symbol} ${tier} ${pct(r.simpleRet)}`,
      asset_return: r.simpleRet,
      btc_return: btcRet,
      z_idio: z,
      rvol,
      score,
    });
  }
  return { incidents, timeline };
}

function buildIntradayIncident(asset, hourlyBars, newsRows, nowSec) {
  if (!hourlyBars || hourlyBars.length < 30 || !asset.sigma_eps) return null;
  const latest = hourlyBars[hourlyBars.length - 1];
  const prior = hourlyBars[hourlyBars.length - 5];
  if (!latest || !prior || prior.close <= 0) return null;
  const ret4h = latest.close / prior.close - 1;
  const avgVol = mean(hourlyBars.slice(-29, -5).map((b) => b.volume * b.close));
  const vol4h = hourlyBars.slice(-4).reduce((acc, b) => acc + b.volume * b.close, 0);
  const rvol = avgVol > 0 ? vol4h / (4 * avgVol) : 1;
  const sigma4h = asset.sigma_eps * Math.sqrt(4 / 24);
  const z = sigma4h > 0 ? ret4h / sigma4h : 0;
  const recentNews = relevantNewsFor(asset.symbol, asset.name, newsRows, nowSec - 6 * 3600);
  const confirmed = rvol >= 2 || recentNews.length >= 2;
  if (Math.abs(z) < 3.125 || !confirmed) return null;
  const score = scoreSignal({
    zIdio: z,
    ret: ret4h,
    rvol,
    confirmed,
    newsCount: recentNews.length,
    oiConfirm: false,
    noisePenalty: 0,
    dataConfidence: 0.75,
    novel: true,
  });
  const tier = rankTier(score, Math.abs(z), confirmed, false);
  if (tier !== "P0" && tier !== "P1") return null;
  const hour = latest.time_open.slice(0, 13).replace("T", "-");
  const signalId = `${asset.symbol}-${hour}-4h-${tier}`.toLowerCase();
  return {
    signal_id: signalId,
    episode_key: `${asset.symbol}:intraday-move`,
    symbol: asset.symbol,
    tier,
    timeframe: "4h",
    event_time: latest.time_open,
    headline: `${asset.symbol} 4小时${ret4h >= 0 ? "上涨" : "下跌"} ${pct(ret4h)}，成交确认`,
    what_happened: `${asset.name} 4小时波动达到 ${z.toFixed(1)}σ，且成交额 RVOL ${rvol.toFixed(2)}x。`,
    why_it_matters: "这属于当前盘中异动候选；只有 P0/P1 且通过成交或催化剂确认才会推送。",
    evidence: [
      `4小时收益 ${pct(ret4h)}`,
      `按日残差波动折算为 ${z.toFixed(2)}σ`,
      `成交额 RVOL ${rvol.toFixed(2)}x${recentNews.length ? `；6小时相关新闻 ${recentNews.length} 条` : ""}`,
    ].join("\n"),
    noise_filters_checked:
      "已检查成交确认、短窗噪音、新闻时效和同资产冷却；首轮历史/既有事件不推送。",
    ui_deep_link: `https://alva.ai/u/${USERNAME}/playbooks/${PLAYBOOK}#sig-${signalId}`,
    score,
    asset_return: ret4h,
    btc_return: null,
    residual_return: ret4h,
    z_idio: z,
    rvol,
    confidence: clamp(0.55 + Math.min(rvol, 3) / 6 + (recentNews.length ? 0.1 : 0), 0, 1),
    portfolio_impact: Math.abs(ret4h) * 0.2,
  };
}

function pickPush(incidents, state, nowMs, firstRun) {
  const current = incidents
    .filter((s) => s.timeframe === "4h" || s.event_time >= dayKey(nowMs - 36 * 3600 * 1000))
    .filter((s) => s.tier === "P0" || s.tier === "P1")
    .sort((a, b) => b.score - a.score);

  const seen = state.seen || {};
  const cooldown = state.cooldown || {};
  const nextSeen = Object.assign({}, seen);
  const nextCooldown = Object.assign({}, cooldown);
  const eligible = [];

  for (const sig of current) {
    nextSeen[sig.signal_id] = nowMs;
    const cd = cooldown[sig.episode_key];
    const tierValue = sig.tier === "P0" ? 2 : 1;
    const cdTier = cd && cd.tier === "P0" ? 2 : cd && cd.tier === "P1" ? 1 : 0;
    const within = cd && nowMs - Number(cd.time || 0) < 6 * 3600 * 1000;
    const ratchet = tierValue > cdTier;
    if (!firstRun && !seen[sig.signal_id] && (!within || ratchet)) {
      eligible.push(sig);
      nextCooldown[sig.episode_key] = { time: nowMs, tier: sig.tier };
    }
  }

  if (!eligible.length) {
    return {
      body: "<|SKIP_NOTIFICATION|>",
      state: { seen: nextSeen, cooldown: nextCooldown },
      pushed: [],
    };
  }
  const selected = eligible.slice(0, 4);
  const body = selected
    .map((sig) =>
      [
        `[${sig.tier}] ${sig.headline}`,
        `Move: ${sig.timeframe} ${pct(sig.asset_return)} · ${sig.z_idio.toFixed(2)}σ`,
        `Why: ${sig.why_it_matters}`,
        `Evidence: ${sig.evidence.replace(/\n/g, " · ")}`,
        `Open: ${sig.ui_deep_link}`,
      ].join("\n"),
    )
    .join("\n\n");
  return {
    body,
    state: { seen: nextSeen, cooldown: nextCooldown },
    pushed: selected,
  };
}

(async () => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const startDaily = nowSec - 55 * 86400;
  const startTen = nowSec - 11 * 86400;
  const startHourly = nowSec - 72 * 3600;
  const runDate = new Date(nowMs).toISOString();

  const universe = await getUniverse(nowSec);
  const btcBars = await getKlines("BTC", startDaily, nowSec, "1d", 80);
  const btcReturns = returnsFromBars(btcBars);
  const btcByDay = {};
  btcReturns.forEach((r) => {
    btcByDay[r.day] = r.ret;
  });
  const newsRows = await getNews(startTen, nowSec);

  const assets = [];
  let allIncidents = [];
  let allTimeline = [];

  for (let i = 0; i < universe.length; i += 1) {
    const u = universe[i];
    const detail = await getDetails(u.symbol);
    const dailyBars = u.symbol === "BTC" ? btcBars : await getKlines(u.symbol, startDaily, nowSec, "1d", 80);
    if (dailyBars.length < 20) throw new Error(`${u.symbol} has insufficient daily kline history`);
    const hourlyBars = await getKlines(u.symbol, startHourly, nowSec, "1h", 100);
    const returns = returnsFromBars(dailyBars);
    const reg = u.symbol === "BTC" ? { beta: 1, residuals: returns.map((r) => ({ day: r.day, residual: r.ret })) } : regress(returns, btcByDay);
    const residualVals = reg.residuals.map((r) => r.residual);
    const sigmaEwma = ewmaSigma(returns.slice(-30).map((r) => r.ret));
    const sigmaMad = robustSigma(returns.slice(-30).map((r) => r.ret));
    const sigmaResidual = Math.max(ewmaSigma(residualVals.slice(-30)), robustSigma(residualVals.slice(-30)), sigmaEwma * 0.35, 0.0001);
    const latestRet = returns[returns.length - 1];
    const tenAgo = dailyBars[Math.max(0, dailyBars.length - 11)];
    const latestBar = dailyBars[dailyBars.length - 1];
    const tenDayReturn = tenAgo && tenAgo.close > 0 ? latestBar.close / tenAgo.close - 1 : null;
    const avgVolUsd = mean(returns.slice(-21, -1).map((r) => r.volumeUsd));
    const rvolLatest = avgVolUsd > 0 ? latestRet.volumeUsd / avgVolUsd : 1;
    const funding = await getFunding(u.pair, nowSec - 7 * 86400, nowSec);
    const oi = await getOpenInterest(u.pair, nowSec - 14 * 86400, nowSec);
    const flows = await getExchangeFlows(u.symbol, nowSec - 14 * 86400, nowSec);
    const latestOi = oi.length ? Number(oi[oi.length - 1].sum_open_interest_value) : null;
    const priorOi = oi.length > 1 ? Number(oi[oi.length - 2].sum_open_interest_value) : null;
    const asset = {
      symbol: u.symbol,
      pair: u.pair,
      name: detail.name || u.symbol,
      rank: i + 1,
      market_cap: u.market_cap,
      market_cap_date: u.market_cap_date,
      last_close: latestBar.close,
      daily_return: latestRet.simpleRet,
      ten_day_return: tenDayReturn,
      sigma_ewma: sigmaEwma,
      sigma_mad: sigmaMad,
      sigma_eps: sigmaResidual,
      beta: reg.beta,
      returns,
      rvol_latest: rvolLatest,
      funding_latest: funding.length ? Number(funding[funding.length - 1].funding_rate) : null,
      open_interest_latest: latestOi,
      open_interest_change_24h: latestOi && priorOi ? latestOi / priorOi - 1 : null,
      exchange_netflow_latest: flows.length ? Number(flows[flows.length - 1].netflow_total) : null,
      capability_notes: [
        "spot:Binance USDT 1d/1h",
        funding.length ? "funding:Binance" : "funding:unavailable",
        oi.length ? "OI:Binance" : "OI:unavailable",
        flows.length ? "exchange-flow:Binance" : "exchange-flow:not-covered",
      ].join("; "),
      status: "active",
    };
    const daily = buildDailyIncidents(asset, btcByDay, newsRows);
    const intra = buildIntradayIncident(asset, hourlyBars, newsRows, nowSec);
    allIncidents = allIncidents.concat(daily.incidents);
    if (intra) allIncidents.push(intra);
    allTimeline = allTimeline.concat(daily.timeline);
    assets.push(asset);
  }

  allIncidents.sort((a, b) => b.score - a.score || Math.abs(b.z_idio) - Math.abs(a.z_idio));
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, total: allIncidents.length };
  allIncidents.forEach((s) => {
    counts[s.tier] = (counts[s.tier] || 0) + 1;
  });

  await feed.run(async (ctx) => {
    let state = {};
    const rawState = await ctx.kv.load("alert_state");
    if (rawState) {
      state = JSON.parse(rawState);
    }
    const firstRun = !rawState;
    const push = pickPush(allIncidents, state, nowMs, firstRun);
    await ctx.kv.put("alert_state", JSON.stringify(push.state));

    const recordDate = nowMs;
    await ctx.self.ts("watch", "overview").append([
      {
        date: recordDate,
        as_of: runDate,
        snapshot_date: universe[0].market_cap_date || "",
        inclusion_policy:
          "按最新 MARKET_CAP screener 选前五大非稳定币 crypto 资产；剔除 USDT/USDC/DAI 等稳定币，因为它们不是波动型投资监控标的。",
        universe_json: JSON.stringify(assets.map((a) => ({
          symbol: a.symbol,
          pair: a.pair,
          name: a.name,
          rank: a.rank,
          market_cap: a.market_cap,
        }))),
        counts_json: JSON.stringify(counts),
        benchmark_json: JSON.stringify({
          primary: "BTC",
          method: "alts are scored by residual move versus BTC beta; BTC is scored against its own volatility baseline",
          crypto_threshold_multiplier: 1.25,
        }),
        freshness_json: JSON.stringify({
          run_at: runDate,
          daily_bars_latest: assets[0] && assets[0].returns.length ? assets[0].returns[assets[0].returns.length - 1].day : "",
          hourly_refresh: "automation runs hourly",
          initial_backfill_alerts: "silent",
          pushed_this_run: push.pushed.length,
        }),
        source_notes_json: JSON.stringify({
          market_cap: "Arrays crypto screener MARKET_CAP",
          spot: "Arrays Binance spot USDT kline",
          derivatives: "Arrays Binance funding rate and open interest when available",
          exchange_flow: "Arrays Binance exchange flows for BTC/ETH only",
          news: "Arrays market-news topic BLOCKCHAIN, used only as catalyst confirmation",
        }),
      },
    ]);

    await ctx.self.ts("watch", "assets").append(
      assets.map((a) => ({
        date: recordDate,
        symbol: a.symbol,
        pair: a.pair,
        name: a.name,
        rank: a.rank,
        market_cap: a.market_cap,
        last_close: a.last_close,
        daily_return: a.daily_return,
        ten_day_return: a.ten_day_return,
        sigma_ewma: a.sigma_ewma,
        sigma_mad: a.sigma_mad,
        sigma_eps: a.sigma_eps,
        beta_btc: a.beta,
        rvol_latest: a.rvol_latest,
        funding_latest: a.funding_latest,
        open_interest_latest: a.open_interest_latest,
        open_interest_change_24h: a.open_interest_change_24h,
        exchange_netflow_latest: a.exchange_netflow_latest,
        capability_notes: a.capability_notes,
        status: a.status,
      })),
    );

    await ctx.self.ts("watch", "incidents").append(
      allIncidents.map((s) => Object.assign({ date: recordDate }, s)),
    );

    await ctx.self.ts("watch", "timeline").append(
      allTimeline.map((s) => Object.assign({ date: recordDate }, s)),
    );

    await ctx.self.ts("notify", "message").append([
      {
        date: recordDate,
        title: "Crypto Top 5 Watch",
        body: push.body,
      },
    ]);
  });
})();
