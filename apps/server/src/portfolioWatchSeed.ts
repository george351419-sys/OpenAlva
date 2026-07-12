import { Alfs } from '@openalva/alfs';
import type { CronJob, CronService, SchedulerStore } from '@openalva/scheduler';
import type { ReleaseService } from './releaseService.js';

export interface PortfolioWatchHolding {
  symbol: string;
  name?: string;
  sector?: string;
  weight?: number;
}

export interface PortfolioWatchSeedInput {
  playbookName?: string;
  displayName?: string;
  description?: string;
  holdings?: PortfolioWatchHolding[];
  profileCron?: string;
  watchCron?: string;
  trigger?: boolean;
  release?: boolean;
}

export interface PortfolioWatchSeedResult {
  playbook: string;
  displayName: string;
  configPath: string;
  profileEntryPath: string;
  watchEntryPath: string;
  liveUrl: string | null;
  releaseVersion: string | null;
  jobs: {
    profile: CronJob;
    watch: CronJob;
  };
  runs: {
    profile?: { status: string; error: string | null };
    watch?: { status: string; error: string | null };
  };
}

interface PortfolioWatchSeederOptions {
  root: string;
  user: string;
  schedulerStore: SchedulerStore;
  cronService: CronService;
  releases: ReleaseService;
}

const DEFAULT_HOLDINGS: PortfolioWatchHolding[] = [
  { symbol: 'NVDA', name: 'NVIDIA', sector: 'Semiconductors', weight: 0.35 },
  { symbol: 'SMH', name: 'VanEck Semiconductor ETF', sector: 'Semiconductors', weight: 0.25 },
  { symbol: 'AAPL', name: 'Apple', sector: 'Hardware', weight: 0.2 },
  { symbol: 'MSFT', name: 'Microsoft', sector: 'Software', weight: 0.2 },
];

export class PortfolioWatchSeeder {
  private readonly alfs: Alfs;

  constructor(private readonly opts: PortfolioWatchSeederOptions) {
    this.alfs = new Alfs(opts.root, opts.user);
  }

  async seed(input: PortfolioWatchSeedInput = {}): Promise<PortfolioWatchSeedResult> {
    const playbookName = cleanName(input.playbookName ?? 'portfolio-watch');
    const displayName = input.displayName?.trim() || 'Portfolio Watch';
    const description =
      input.description?.trim() ||
      'Seed portfolio watch playbook built from Portfolio-Watch-Skill methodology.';
    const holdings = normalizeHoldings(input.holdings);
    const profileEntryPath = '~/feeds/pw-profile/v1/src/index.js';
    const watchEntryPath = '~/feeds/pw-watch/v1/src/index.js';
    const releaseWanted = input.release !== false;
    const triggerWanted = input.trigger !== false;

    await this.writeFile(
      '~/feeds/pw-config/v1/holdings.json',
      JSON.stringify(
        {
          schema: 'openalva.portfolio-watch.holdings/v1',
          updated_at: new Date().toISOString(),
          holdings,
        },
        null,
        2,
      ),
    );
    await this.writeFile('~/feeds/pw-profile/v1/src/index.js', profileFeedSource());
    await this.writeFile('~/feeds/pw-watch/v1/src/index.js', watchFeedSource());

    await this.opts.releases.createDraft({
      name: playbookName,
      displayName,
      description,
      feeds: ['~/feeds/pw-config/v1', '~/feeds/pw-profile/v1', '~/feeds/pw-watch/v1'],
    });
    await this.writeFile(`~/playbooks/${playbookName}/index.html`, playbookHtml(displayName));
    await this.writeFile(`~/playbooks/${playbookName}/README.md`, playbookReadme(displayName));
    await this.writeFile(`~/playbooks/${playbookName}/udf/updateWatchlist.js`, updateWatchlistUdf());

    const profile = this.ensureJob({
      name: 'portfolio-watch-profile',
      entryPath: profileEntryPath,
      cron: input.profileCron ?? '15 13 * * 1-5',
      pushNotify: false,
    });
    const watch = this.ensureJob({
      name: 'portfolio-watch-watch',
      entryPath: watchEntryPath,
      cron: input.watchCron ?? '30 13 * * 1-5',
      pushNotify: true,
    });

    const runs: PortfolioWatchSeedResult['runs'] = {};
    if (triggerWanted) {
      await this.opts.cronService.execute(profile.id, 'manual');
      runs.profile = simplifyRun(this.opts.schedulerStore.runs(profile.id, 1)[0]);
      await this.opts.cronService.execute(watch.id, 'manual');
      runs.watch = simplifyRun(this.opts.schedulerStore.runs(watch.id, 1)[0]);
    }

    let liveUrl: string | null = null;
    let releaseVersion: string | null = null;
    if (releaseWanted) {
      const published = await this.opts.releases.publish({
        name: playbookName,
        changelog: 'Seed Portfolio Watch playbook from Portfolio-Watch-Skill methodology.',
      });
      liveUrl = published.release.live_url;
      releaseVersion = published.release.version;
    }

    return {
      playbook: playbookName,
      displayName,
      configPath: '~/feeds/pw-config/v1/holdings.json',
      profileEntryPath,
      watchEntryPath,
      liveUrl,
      releaseVersion,
      jobs: { profile, watch },
      runs,
    };
  }

  private async writeFile(path: string, content: string): Promise<void> {
    await this.alfs.writeFile(path, content.endsWith('\n') ? content : `${content}\n`);
  }

  private ensureJob(input: {
    name: string;
    entryPath: string;
    cron: string;
    pushNotify: boolean;
  }): CronJob {
    const existing = this.opts.schedulerStore
      .list(this.opts.user)
      .find((job) => job.name === input.name && job.entry_path === input.entryPath);
    if (existing) {
      if (existing.status !== 'active') {
        return this.opts.schedulerStore.setStatus(existing.id, 'active') ?? existing;
      }
      return existing;
    }
    return this.opts.schedulerStore.create({
      name: input.name,
      user: this.opts.user,
      entryPath: input.entryPath,
      cron: input.cron,
      pushNotify: input.pushNotify,
      maxHeapSizeMb: 256,
    });
  }
}

function cleanName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(clean)) {
    throw new Error('playbookName must match /^[a-z0-9][a-z0-9_-]{1,62}$/');
  }
  return clean;
}

function normalizeHoldings(input: unknown): PortfolioWatchHolding[] {
  const raw = Array.isArray(input) && input.length > 0 ? input : DEFAULT_HOLDINGS;
  const rows = raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((h) => {
      const symbol = typeof h.symbol === 'string' ? h.symbol.trim().toUpperCase() : '';
      if (!/^[A-Z0-9._-]{1,16}$/.test(symbol)) return null;
      const weight = typeof h.weight === 'number' && Number.isFinite(h.weight) ? h.weight : 0;
      return {
        symbol,
        name: typeof h.name === 'string' && h.name.trim() ? h.name.trim() : symbol,
        sector: typeof h.sector === 'string' && h.sector.trim() ? h.sector.trim() : 'Unclassified',
        weight,
      };
    })
    .filter((h): h is Required<PortfolioWatchHolding> => h !== null);
  if (rows.length === 0) throw new Error('holdings must include at least one valid symbol');
  const total = rows.reduce((sum, h) => sum + Math.max(0, h.weight), 0);
  return rows.map((h) => ({
    ...h,
    weight: total > 0 ? round(Math.max(0, h.weight) / total, 6) : round(1 / rows.length, 6),
  }));
}

function simplifyRun(run: { status: string; error: string | null } | undefined):
  | { status: string; error: string | null }
  | undefined {
  if (!run) return undefined;
  return { status: run.status, error: run.error };
}

function round(n: number, places = 4): number {
  const m = 10 ** places;
  return Math.round(n * m) / m;
}

function profileFeedSource(): string {
  return String.raw`
const { Feed, feedPath, makeDoc, str, num } = require("@alva/feed");
const alfs = require("alfs");
const env = require("env");
const http = require("net/http");

const CONFIG_PATH = "/alva/home/" + env.username + "/feeds/pw-config/v1/holdings.json";
const BASE = "https://data-tools.prd.space.id";
const DEFAULT_HOLDINGS = [
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors", weight: 0.35 },
  { symbol: "SMH", name: "VanEck Semiconductor ETF", sector: "Semiconductors", weight: 0.25 },
  { symbol: "AAPL", name: "Apple", sector: "Hardware", weight: 0.2 },
  { symbol: "MSFT", name: "Microsoft", sector: "Software", weight: 0.2 }
];

const feed = new Feed({
  path: feedPath("pw-profile", "v1"),
  name: "Portfolio Watch Profile",
  description: "Adaptive per-holding baselines for Portfolio Watch."
});

feed.def("profile", {
  holdings: makeDoc("holdings", "Per-holding adaptive baseline rows.", [
    str("symbol"),
    str("name"),
    str("sector"),
    num("weight"),
    num("baseline_price"),
    num("last_price"),
    num("day_return"),
    num("vol_20d"),
    num("avg_volume"),
    num("beta"),
    str("baseline_source"),
    num("sample_size")
  ])
});

(async () => {
  await feed.run(async (ctx) => {
    const holdings = await loadHoldings();
    const benchmark = await bars("SPY", 60);
    const benchReturns = returns(benchmark);
    const rows = [];
    for (const h of holdings) {
      const b = await bars(h.symbol, 60);
      const r = returns(b);
      const last = b[b.length - 1] || syntheticBar(h.symbol, 0);
      const prev = b[b.length - 2] || last;
      const avgVolume = avg(b.slice(-20).map((x) => numVal(x.volume, 1000000)));
      rows.push({
        date: dayBucket(),
        symbol: h.symbol,
        name: h.name || h.symbol,
        sector: h.sector || "Unclassified",
        weight: Number(h.weight || 0),
        baseline_price: round(avg(b.slice(-20).map((x) => numVal(x.price_close, last.price_close)))),
        last_price: round(numVal(last.price_close, 0)),
        day_return: round(pct(numVal(last.price_close, 0), numVal(prev.price_close, 0)), 6),
        vol_20d: round(stdev(r.slice(-20)) || 0.018, 6),
        avg_volume: Math.round(avgVolume),
        beta: round(beta(r, benchReturns) || 1, 4),
        baseline_source: b[0] && b[0]._synthetic ? "synthetic-fallback" : "arrays",
        sample_size: b.length
      });
    }
    await ctx.self.ts("profile", "holdings").append(rows);
    await ctx.kv.put("last_run", new Date().toISOString());
    console.log("profiled " + rows.length + " holdings");
  });
})();

async function loadHoldings() {
  try {
    const cfg = JSON.parse(String(await alfs.readFile(CONFIG_PATH)));
    if (cfg && Array.isArray(cfg.holdings) && cfg.holdings.length) return cfg.holdings;
  } catch (_err) {}
  return DEFAULT_HOLDINGS;
}

async function bars(symbol, limit) {
  const now = Math.floor(Date.now() / 1000);
  const url = BASE + "/api/v1/stocks/kline?symbol=" + encodeURIComponent(symbol) +
    "&interval=1d&session=RTH&limit=" + limit +
    "&start_time=" + (now - limit * 86400 * 2) +
    "&end_time=" + now;
  try {
    const resp = await http.fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const json = await resp.json();
    if (!json || json.success !== true || !Array.isArray(json.data) || json.data.length < 2) {
      throw new Error("bad kline shape");
    }
    return json.data.slice().map(normalizeBar).sort((a, b) => a.t - b.t);
  } catch (err) {
    console.warn("profile fallback for " + symbol + ": " + String(err && err.message || err));
    const out = [];
    for (let i = limit - 1; i >= 0; i--) out.push(syntheticBar(symbol, i));
    return out.sort((a, b) => a.t - b.t);
  }
}

function normalizeBar(row) {
  const t = numVal(row.time_close, row.time_open || Date.now() / 1000);
  return {
    t: t < 10000000000 ? t * 1000 : t,
    price_close: numVal(row.price_close, row.close || row.c || 0),
    volume: numVal(row.volume, row.volume_traded || 1000000)
  };
}

function syntheticBar(symbol, age) {
  const seed = hash(symbol);
  const base = 40 + (seed % 240);
  const wave = Math.sin((60 - age + seed) / 5) * 0.03;
  const drift = (60 - age) * 0.0015;
  const price = base * (1 + drift + wave);
  return { _synthetic: true, t: Date.now() - age * 86400000, price_close: price, volume: 1000000 + seed * 1000 };
}

function returns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) out.push(pct(bars[i].price_close, bars[i - 1].price_close));
  return out.filter(Number.isFinite);
}

function pct(now, prev) {
  return prev ? (now - prev) / prev : 0;
}

function avg(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = avg(values);
  return Math.sqrt(values.reduce((s, x) => s + Math.pow(x - m, 2), 0) / (values.length - 1));
}

function beta(asset, market) {
  const n = Math.min(asset.length, market.length);
  if (n < 5) return 1;
  const a = asset.slice(asset.length - n);
  const m = market.slice(market.length - n);
  const ma = avg(a);
  const mm = avg(m);
  let cov = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (m[i] - mm);
    variance += Math.pow(m[i] - mm, 2);
  }
  return variance ? cov / variance : 1;
}

function hash(symbol) {
  return String(symbol).split("").reduce((s, c) => s + c.charCodeAt(0), 0);
}

function numVal(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(n, places) {
  const p = Math.pow(10, places || 4);
  return Math.round(n * p) / p;
}

function dayBucket() {
  return Math.floor(Date.now() / 86400000) * 86400000;
}
`;
}

function watchFeedSource(): string {
  return String.raw`
const { Feed, feedPath, makeDoc, str, num } = require("@alva/feed");
const alfs = require("alfs");
const env = require("env");
const pi = require("@alva/pi");

const CONFIG_PATH = "/alva/home/" + env.username + "/feeds/pw-config/v1/holdings.json";

const feed = new Feed({
  path: feedPath("pw-watch", "v1"),
  name: "Portfolio Watch",
  description: "Relative-to-baseline portfolio watch signals.",
  upstreams: { profile: "/alva/home/" + env.username + "/feeds/pw-profile/v1" }
});

feed.def("watch", {
  overview: makeDoc("overview", "Portfolio-level watch summary.", [
    num("portfolio_score"),
    str("posture"),
    num("alert_count"),
    num("holding_count"),
    str("narrative")
  ]),
  holdings: makeDoc("holdings", "Holding-level watch rows.", [
    str("symbol"),
    str("name"),
    str("sector"),
    num("weight"),
    num("last_price"),
    num("day_return"),
    num("z_score"),
    str("signal"),
    str("reason")
  ]),
  signals: makeDoc("signals", "Ranked incident candidates.", [
    str("symbol"),
    str("severity"),
    str("title"),
    str("body"),
    num("score")
  ]),
  digest: makeDoc("digest", "Readable digest row for the playbook.", [
    str("body")
  ])
});
feed.def("notify", {
  message: makeDoc("message", "Local notification sidecar.", [
    str("title"),
    str("body")
  ])
});

(async () => {
  await feed.run(async (ctx) => {
    const config = await loadConfig();
    let profiles = await ctx.upstream.profile.ts("profile", "holdings").last(1);
    if (!profiles.length) profiles = fallbackProfiles(config.holdings);
    const rows = profiles.map(scoreHolding);
    const alertRows = rows.filter((r) => Math.abs(r.z_score) >= 1.5).slice(0, 5);
    const portfolioScore = round(rows.reduce((s, r) => s + r.weight * r.z_score, 0), 4);
    const posture = portfolioScore > 1.2 ? "risk-on" : portfolioScore < -1.2 ? "risk-off" : "watchful";
    const phrase = rows.map((r) => r.symbol + " " + r.signal).join(", ");
    let narrative = posture + ": " + phrase;
    try {
      narrative = await pi.tldr("Write one concise portfolio watch sentence: " + phrase);
    } catch (_err) {}
    const now = Date.now();
    await ctx.self.ts("watch", "overview").append([{
      date: now,
      portfolio_score: portfolioScore,
      posture,
      alert_count: alertRows.length,
      holding_count: rows.length,
      narrative
    }]);
    await ctx.self.ts("watch", "holdings").append(rows.map((r) => ({ ...r, date: now })));
    await ctx.self.ts("watch", "signals").append((alertRows.length ? alertRows : rows.slice(0, 1)).map((r) => ({
      date: now,
      symbol: r.symbol,
      severity: Math.abs(r.z_score) >= 2 ? "high" : Math.abs(r.z_score) >= 1 ? "medium" : "low",
      title: r.symbol + " " + r.signal,
      body: r.reason,
      score: Math.abs(r.z_score)
    })));
    await ctx.self.ts("watch", "digest").append([{ date: now, body: narrative }]);
    await ctx.self.ts("notify", "message").append([{
      date: now,
      title: "Portfolio Watch",
      body: alertRows.length
        ? alertRows[0].symbol + ": " + alertRows[0].reason
        : "Portfolio Watch refreshed: " + posture + "."
    }]);
    await ctx.kv.put("last_run", new Date(now).toISOString());
    console.log("watch refreshed " + rows.length + " holdings; alerts=" + alertRows.length);
  });
})();

async function loadConfig() {
  try {
    const cfg = JSON.parse(String(await alfs.readFile(CONFIG_PATH)));
    if (cfg && Array.isArray(cfg.holdings)) return cfg;
  } catch (_err) {}
  return { holdings: [] };
}

function fallbackProfiles(holdings) {
  return holdings.map((h, i) => ({
    symbol: h.symbol,
    name: h.name || h.symbol,
    sector: h.sector || "Unclassified",
    weight: h.weight || 0,
    last_price: 100 + i * 7,
    baseline_price: 98 + i * 7,
    day_return: 0.01,
    vol_20d: 0.02,
    beta: 1,
    sample_size: 0
  }));
}

function scoreHolding(p) {
  const vol = Math.max(Math.abs(Number(p.vol_20d || 0.02)), 0.005);
  const dayReturn = Number(p.day_return || 0);
  const z = round(dayReturn / vol, 3);
  const signal = z >= 1.5 ? "breakout" : z <= -1.5 ? "drawdown" : "in-band";
  const reason =
    signal === "in-band"
      ? "Move is inside its adaptive baseline."
      : "Move is " + Math.abs(z).toFixed(1) + " vol units from its own baseline.";
  return {
    symbol: String(p.symbol),
    name: String(p.name || p.symbol),
    sector: String(p.sector || "Unclassified"),
    weight: Number(p.weight || 0),
    last_price: round(Number(p.last_price || 0), 2),
    day_return: round(dayReturn, 6),
    z_score: z,
    signal,
    reason
  };
}

function round(n, places) {
  const p = Math.pow(10, places || 4);
  return Math.round(n * p) / p;
}
`;
}

function updateWatchlistUdf(): string {
  return String.raw`
const alfs = require("alfs");
const env = require("env");
const { Feed, feedPath, makeDoc, str, num } = require("@alva/feed");

const CONFIG_PATH = "/alva/home/" + env.username + "/feeds/pw-config/v1/holdings.json";

(async () => {
  const args = env.args || {};
  const action = String(args.action || "add").toLowerCase();
  const symbol = String(args.symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,16}$/.test(symbol)) throw new Error("symbol is required");
  const cfg = await loadConfig();
  const current = Array.isArray(cfg.holdings) ? cfg.holdings : [];
  let next = current.slice();
  if (action === "remove") {
    next = next.filter((h) => String(h.symbol).toUpperCase() !== symbol);
  } else {
    const row = {
      symbol,
      name: String(args.name || symbol),
      sector: String(args.sector || "Unclassified"),
      weight: Number(args.weight || 0)
    };
    const idx = next.findIndex((h) => String(h.symbol).toUpperCase() === symbol);
    if (idx >= 0) next[idx] = { ...next[idx], ...row };
    else next.push(row);
  }
  next = normalizeWeights(next);
  const updated = {
    schema: "openalva.portfolio-watch.holdings/v1",
    updated_at: new Date().toISOString(),
    holdings: next
  };
  await alfs.writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2));
  await writeColdProfile(next);
  console.log("watchlist " + action + " " + symbol + "; holdings=" + next.length);
})();

async function loadConfig() {
  try {
    return JSON.parse(String(await alfs.readFile(CONFIG_PATH)));
  } catch (_err) {
    return { holdings: [] };
  }
}

function normalizeWeights(rows) {
  if (!rows.length) return rows;
  const total = rows.reduce((s, h) => s + Math.max(0, Number(h.weight || 0)), 0);
  return rows.map((h) => ({
    symbol: String(h.symbol).toUpperCase(),
    name: h.name || h.symbol,
    sector: h.sector || "Unclassified",
    weight: total > 0 ? Math.max(0, Number(h.weight || 0)) / total : 1 / rows.length
  }));
}

async function writeColdProfile(holdings) {
  const feed = new Feed({ path: feedPath("pw-profile", "v1") });
  feed.def("profile", {
    holdings: makeDoc("holdings", "UDF cold-start profile rows.", [
      str("symbol"),
      str("name"),
      str("sector"),
      num("weight"),
      num("baseline_price"),
      num("last_price"),
      num("day_return"),
      num("vol_20d"),
      num("avg_volume"),
      num("beta"),
      str("baseline_source"),
      num("sample_size")
    ])
  });
  await feed.run(async (ctx) => {
    const now = Math.floor(Date.now() / 86400000) * 86400000;
    await ctx.self.ts("profile", "holdings").append(holdings.map((h, i) => ({
      date: now,
      symbol: h.symbol,
      name: h.name || h.symbol,
      sector: h.sector || "Unclassified",
      weight: Number(h.weight || 0),
      baseline_price: 100 + i,
      last_price: 100 + i,
      day_return: 0,
      vol_20d: 0.02,
      avg_volume: 0,
      beta: 1,
      baseline_source: "udf-cold-start",
      sample_size: 0
    })));
  });
}
`;
}

function playbookHtml(title: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="/design-system/v1/design-system.css">
  <script src="/openalva/v1/client.js"></script>
  <style>
    html {
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }
    body {
      margin: 0;
      background: #f7f8fb;
      color: #171923;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-weight: 400;
    }
    .playbook-container {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 22px;
    }
    h1, h2, h3, p {
      margin: 0;
      font-weight: 500;
    }
    h1 {
      font-size: 28px;
      line-height: 1.18;
    }
    h2 {
      font-size: 18px;
      line-height: 1.3;
      margin-bottom: 12px;
    }
    h3 {
      font-size: 14px;
      line-height: 1.35;
    }
    .muted {
      color: #667085;
      font-size: 13px;
      line-height: 1.55;
      margin-top: 6px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.3fr 0.7fr;
      gap: 16px;
    }
    .panel {
      background: #ffffff;
      border: 1px solid #e4e7ec;
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat {
      background: #f9fafb;
      border: 1px solid #eaecf0;
      border-radius: 8px;
      padding: 12px;
      min-height: 76px;
    }
    .label {
      color: #667085;
      font-size: 12px;
      line-height: 1.4;
    }
    .value {
      margin-top: 8px;
      font-size: 22px;
      line-height: 1.1;
      font-weight: 500;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .tab {
      border: 1px solid #d0d5dd;
      background: #ffffff;
      color: #344054;
      border-radius: 8px;
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
    }
    .tab.active {
      background: #111827;
      color: #ffffff;
      border-color: #111827;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 13px;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid #eaecf0;
      text-align: left;
      vertical-align: top;
      word-break: break-word;
    }
    th {
      color: #667085;
      font-weight: 500;
    }
    .signal {
      display: inline-flex;
      border-radius: 999px;
      padding: 3px 8px;
      background: #eef4ff;
      color: #3538cd;
      font-size: 12px;
    }
    .form {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 14px;
    }
    input {
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      padding: 9px 10px;
      font: inherit;
      min-width: 0;
    }
    .button {
      border: 0;
      border-radius: 8px;
      padding: 10px 12px;
      background: #111827;
      color: #ffffff;
      font: inherit;
      cursor: pointer;
    }
    .button.secondary {
      background: #eef2f6;
      color: #1f2937;
    }
    .section {
      display: none;
    }
    .section.active {
      display: block;
    }
    .list {
      display: grid;
      gap: 10px;
    }
    .item {
      border: 1px solid #eaecf0;
      border-radius: 8px;
      padding: 12px;
      background: #ffffff;
    }
    @media (max-width: 760px) {
      .topbar, .grid {
        display: block;
      }
      .stats, .form {
        grid-template-columns: 1fr 1fr;
      }
      .panel {
        margin-bottom: 14px;
      }
    }
  </style>
</head>
<body>
  <div class="playbook-container">
    <div class="topbar">
      <div>
        <h1>${safeTitle}</h1>
        <p class="muted">Adaptive watchlist built from Portfolio-Watch-Skill: profile feed, watch feed, incidents, formulas, UDF edits, and notification sidecar.</p>
      </div>
      <button class="button secondary" id="refresh">Refresh</button>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="watch">Watch</button>
      <button class="tab" data-tab="incident">Incident</button>
      <button class="tab" data-tab="theory">Theory</button>
      <button class="tab" data-tab="formulas">Formulas</button>
    </div>

    <section id="watch" class="section active">
      <div class="stats">
        <div class="stat"><div class="label">Posture</div><div class="value" id="posture">-</div></div>
        <div class="stat"><div class="label">Score</div><div class="value" id="score">-</div></div>
        <div class="stat"><div class="label">Alerts</div><div class="value" id="alerts">-</div></div>
        <div class="stat"><div class="label">Holdings</div><div class="value" id="count">-</div></div>
      </div>
      <div class="grid">
        <div class="panel">
          <h2>Holdings</h2>
          <table>
            <thead><tr><th>Symbol</th><th>Weight</th><th>Last</th><th>Day</th><th>Signal</th><th>Reason</th></tr></thead>
            <tbody id="holdings"></tbody>
          </table>
        </div>
        <div class="panel">
          <h2>Edit Watchlist</h2>
          <p class="muted">Changes write to the config feed through a playbook UDF. The next scheduled watch run reads the updated holdings.</p>
          <div class="form">
            <input id="symbol" placeholder="Symbol">
            <input id="sector" placeholder="Sector">
            <button class="button" id="add">Add</button>
            <button class="button secondary" id="remove">Remove</button>
          </div>
          <p class="muted" id="udf-status"></p>
        </div>
      </div>
    </section>

    <section id="incident" class="section">
      <div class="panel">
        <h2>Incident Timeline</h2>
        <div class="list" id="signals"></div>
      </div>
    </section>

    <section id="theory" class="section">
      <div class="panel">
        <h2>Design Theory</h2>
        <p class="muted">Every signal is judged relative to the holding's own adaptive baseline, not a universal threshold. The profile feed estimates last price, recent volatility, benchmark beta, and sector context. The watch feed converts current movement into a z-like score, then separates quiet refreshes from incident candidates.</p>
      </div>
    </section>

    <section id="formulas" class="section">
      <div class="panel">
        <h2>Formulas</h2>
        <div class="list">
          <div class="item"><h3>Day return</h3><p class="muted">(last_price - previous_price) / previous_price</p></div>
          <div class="item"><h3>Baseline price</h3><p class="muted">Mean close over the latest profile window, falling back to deterministic cold-start data when live data is unavailable.</p></div>
          <div class="item"><h3>Signal score</h3><p class="muted">z_score = day_return / max(vol_20d, 0.005). Breakout and drawdown thresholds are symmetric around each holding's own baseline.</p></div>
        </div>
      </div>
    </section>
  </div>

  <script>
    const client = new window.OpenAlva.Client();
    const paths = {
      overview: "~/feeds/pw-watch/v1/data/watch/overview/@last/1",
      holdings: "~/feeds/pw-watch/v1/data/watch/holdings/@last/1",
      signals: "~/feeds/pw-watch/v1/data/watch/signals/@last/8"
    };
    async function readJson(path) {
      try {
        return JSON.parse(await client.fs.read({ path }));
      } catch (_err) {
        return [];
      }
    }
    async function load() {
      const overview = (await readJson(paths.overview))[0] || {};
      const holdings = await readJson(paths.holdings);
      const signals = await readJson(paths.signals);
      document.getElementById("posture").textContent = overview.posture || "-";
      document.getElementById("score").textContent = overview.portfolio_score == null ? "-" : String(overview.portfolio_score);
      document.getElementById("alerts").textContent = overview.alert_count == null ? "-" : String(overview.alert_count);
      document.getElementById("count").textContent = overview.holding_count == null ? String(holdings.length) : String(overview.holding_count);
      document.getElementById("holdings").innerHTML = holdings.map((h) =>
        "<tr><td>" + esc(h.symbol) + "</td><td>" + pct(h.weight) + "</td><td>" + money(h.last_price) + "</td><td>" + pct(h.day_return) + "</td><td><span class='signal'>" + esc(h.signal) + "</span></td><td>" + esc(h.reason) + "</td></tr>"
      ).join("");
      document.getElementById("signals").innerHTML = signals.map((s) =>
        "<div class='item'><h3>" + esc(s.title || s.symbol) + "</h3><p class='muted'>" + esc(s.body || "") + "</p></div>"
      ).join("") || "<p class='muted'>No incidents yet.</p>";
    }
    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function pct(v) {
      const n = Number(v);
      return Number.isFinite(n) ? (n * 100).toFixed(2) + "%" : "-";
    }
    function money(v) {
      const n = Number(v);
      return Number.isFinite(n) ? "$" + n.toFixed(2) : "-";
    }
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
        button.classList.add("active");
        document.getElementById(button.dataset.tab).classList.add("active");
      });
    });
    document.getElementById("refresh").addEventListener("click", load);
    document.getElementById("add").addEventListener("click", () => mutate("add"));
    document.getElementById("remove").addEventListener("click", () => mutate("remove"));
    async function mutate(action) {
      const status = document.getElementById("udf-status");
      const symbol = document.getElementById("symbol").value.trim().toUpperCase();
      const sector = document.getElementById("sector").value.trim();
      status.textContent = "Saving...";
      try {
        await window.openalva.udf.call("updateWatchlist", { action, symbol, sector });
        status.textContent = "Saved. Trigger the watch job or wait for the next cron refresh.";
      } catch (err) {
        status.textContent = String(err && err.message || err);
      }
    }
    load();
  </script>
</body>
</html>`;
}

function playbookReadme(title: string): string {
  return `# ${title}

This seed playbook is generated by OpenAlva from the Portfolio-Watch-Skill methodology.

- Config feed: \`~/feeds/pw-config/v1/holdings.json\`
- Profile feed: \`~/feeds/pw-profile/v1\`
- Watch feed: \`~/feeds/pw-watch/v1\`
- UDF: \`updateWatchlist\`
- Release: immutable snapshots under \`/pb-static/<user>/portfolio-watch/<version>/\`

The implementation preserves the compatibility shape required by Spec 7.1:
profile feed, watch feed, four-tab interface, release, UDF watchlist editing, and
\`notify/message\` sidecar fanout.
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
