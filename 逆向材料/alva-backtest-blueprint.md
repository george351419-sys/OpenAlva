# Backtest Playbook Template

For backtest analysis. Two supported modes:
- **Event Study** — "What happens to X after Y event"
- **Strategy** — Rule-based entry/exit with equity curve and trade ledger

> **Highest-priority standard — strictly follow. Template iterates; always work from the latest version of this file.**

## Ask-first gate — answer before you build (READ FIRST)

Most users who land here want an **answer**, not a deploy. Building a live
playbook is the heavy path. Default to a fast text answer first; build only
when the user wants something persistent.

**Step 1 — classify the request**
- **Build intent** -> run the full template below. Signals: "build / make /
  set up / track / monitor / watch / every day / alert / notify / dashboard /
  playbook / deploy", an explicit remix, or a follow-up accepting a build you
  offered.
- **Ask intent** -> take the Fast path (Step 2). Signals: a one-off question /
  comparison / lookup with no persistence verb ("how did NVDA's last earnings
  go", "backtest X real quick", "which mid-caps screen well", "what's
  happening with <topic>").
- **Ambiguous** -> default to Fast path, then offer to build.

**Step 2 — Fast path (the answer)**
- Give a **direct, conclusion-first text answer** in chat, on real data.
  Fetch/compute only what the question needs (see "Fast-path answer shape"
  below). Never answer market facts from model memory — Content Legitimacy
  Rules still apply.
- At most **one** inline chart via `RenderChart`, only when a number alone
  won't carry it. No feed deployed, no playbook drafted, no release.

**Step 3 — offer the build (only when it earns it)**
- If the topic is something the user would re-check or want tracked, close with
  a one-line offer to make it persistent (see "Build offer" below).
- Skip the offer for one-off curiosity. Never auto-build without a yes.

Everything below is the **build path** — used only on Build intent or an
accepted offer.

### Fast-path answer shape
Run the backtest once on Altra — the numbers must be real (Content Legitimacy
Rules apply; never report returns from memory). Return the Verdict-hero
paragraph as chat text: conclusion first, with headline forward-return and
win-rate numbers inline. Optionally one path or equity-curve chart via
`RenderChart`. Skip the four horizon/KPI cards, the side-by-side charts, the
event/trade ledger, the README, and the deploy/release.

### Build offer
Offer only when the trigger recurs and is worth tracking (drawdowns, earnings
beats, MA crosses, etc.): "Want this as a live playbook that re-runs and tracks
new occurrences?" Skip the offer for a one-off historical question.


## 0. Design System Compliance (READ FIRST)

**MANDATORY — strictly follow the Alva skill design guideline. Non-negotiable.**

Before writing HTML, read from the Alva skill:

- [references/design-system.md](../../references/design-system.md) — copy `.playbook-container` rule verbatim (max-width 2048px, 28px horizontal padding)
- [references/design-widgets.md](../../references/design-widgets.md) — metric cards / charts / tables specs
- [references/design-tokens.css](../../references/design-tokens.css) — use spacing/color tokens as-is, do NOT override

**Do NOT** apply `design-playbook-trading-strategy.md` — that doc is for trading-strategy dashboards with Overview/Analytics/Strategy/Feed tabs. Backtest playbooks (either mode) are single-scroll narratives, not dashboards.

## 0a. Backtest engine — use Alva's Altra, not local compute

**MANDATORY — all backtest / event-study / strategy-simulation computation runs on Alva's Altra engine on Alva Cloud.** Never run backtests locally or hand-roll return / streak / aggregation logic in a feed script when Altra already exposes it.

- Express the trigger rule and entry logic as an **Altra strategy definition** (`skills/alva/references/altra-trading.md`, `skills/alva/references/api/trading.md`). Altra handles event detection, forward-return computation, equity curve, trade ledger, portfolio stats, and look-ahead-bias guards — all on Alva Cloud.
- If the question genuinely cannot fit a strategy shape (e.g. joining news headlines or macro-calendar data to event timestamps for display context), use an **Alva SDK module + thin feed wrapper** that shapes SDK output for the HTML layer (≤ ~80 lines; do NOT re-implement aggregations).
- Custom feed computation is a last resort — flag it explicitly so the choice can be double-checked before shipping.

**Operations that MUST run on Altra — never in a feed-side `for` loop:**
- Event onset detection (first threshold cross, first close below a trailing high, etc.)
- Forward-return computation at any horizon
- Hit rate / win rate / median / mean / distribution quantiles across an event set
- Drawdown depth + recovery-time
- Equity curve generation under a strategy rule
- Trade-by-trade P&L, MFE/MAE, holding-period metrics
- Sharpe / Sortino / Profit Factor / CAGR
- Cross-asset or cross-ticker cohort comparisons conditioned on an event

The playbook HTML reads the computed output via runtime `fetch()` from the deployed feed path — never hardcoded data literals.

## 0b. Mode selection (READ BEFORE EVERYTHING BELOW)

Two modes. Pick one upfront — only **§3 Layout** branches; everything else is shared.

| Mode | Use when | Hero answers |
|---|---|---|
| **Event Study** | Discrete trigger event happens N times in history (drawdowns, halvings, FOMC cuts, EPS beats) | "What happens to X after Y?" |
| **Strategy** | Continuous rule with entry/exit logic (intraday ORB, MA cross, RSI<20 entry / RSI>70 exit) | "Did this rule make money?" |

**Quick test:** "After X happens..." → Event Study (§3a/§3b). "Buy when A, sell when B" → Strategy (§3e). If both apply, default to Strategy — equity curve swallows the event question, not vice versa.

## 1. Title and naming

### 1a. Title format

**Event Study mode** — `[Asset] [After/Before] [Trigger]` — short, concrete, no time-window suffix.

✓ Examples: `S&P 500 After a 10% Drawdown`, `Gold After a New All-Time High`, `QQQ After Three Down Days`, `Bitcoin After Halving`.

**Strategy mode** — see §3e for the title override (`[Strategy name] on [Instrument]`).

✗ **Do NOT append `— [N]-Year What-If`** (or any other lookback suffix). The lookback is a methodology detail, not a title element.

✗ **Do NOT include the word "What-If"** in any user-facing copy: title, `display_name`, URL slug, hero card, README. The playbook category is communicated by the playbook chrome around the HTML; repeating it inside the HTML is noise.

### 1b. Where the title lives — chrome only, never inside the HTML

The playbook subject appears in exactly two places — keep them aligned, NOT duplicated:

| Surface | Rule | Example |
|---|---|---|
| **`display_name`** (playbook chrome — rendered by the platform above the HTML iframe) | The concrete subject, ≤40 chars | `S&P 500 After a 10% Drawdown` / `NQ Daybreak ORB on QQQ` |
| **URL slug** (`name` in release CLI) | Lowercase, hyphens, no lookback | `spx-after-10-drop` / `orb-daybreak-qqq` |

✗ **Do NOT add any heading inside the HTML.** Not `<h1>`, not `<h2>`, not a `.playbook-title` row, not a `.section-title` row. The platform chrome already renders the `display_name` directly above the HTML; any heading inside the HTML is a duplicate title and pushes the hero card below the fold.

The HTML body starts directly with the first `<div class="widget-grid">` carrying the hero card (§2 / §3 step 1). Nothing above it.

### 1c. README and methodology — attached file, not in-HTML modal

Methodology is **not** rendered inside the playbook HTML. There is no in-HTML `README` chip, no modal trigger, no methodology card. The platform surfaces the playbook's `README.md` automatically above or beside the iframe.

How to attach it:

1. Write the methodology as a standalone Markdown file (see §6 for canonical sections per mode).
2. Upload to ALFS at `'~/playbooks/<name>/README.md'`.
3. Pass `--readme-url '/alva/home/<username>/playbooks/<name>/README.md'` to `alva release playbook`. The path must be an absolute ALFS path.

The bottom References card inside the HTML (§3 step 6) is **not** the methodology — it is a two-sentence data-source eyebrow only. Do not duplicate.

### 1d. 3-second rule

A reader must understand what the playbook is about within 3 seconds, without reading any paragraph. The `display_name` in the chrome carries the topic; the hero card carries the verdict; the four cards below the hero (horizons in Event Study; KPIs in Strategy) carry the headline numbers. All three must be visible without scrolling — see §3 First-fold rule.

## 2. Verdict Hero (required, first widget after section-title)

A single full-width Free Text Card that answers "did this work?" before the reader scrolls. Data-driven — no hardcoded prose.

**One prose paragraph**, ≤80 words, conclusion-first, with the headline numbers **inline** and color-coded via `.pos` / `.neg` markdown spans (not in chips, not in separate metric cards). Don't open with `Here's how X has moved…` / `Here's the distribution…`; lead with the number.

No disclaimer eyebrow (`Verdict — historical observation only` and similar) — legal text, if any, goes in the playbook README (§1c), not on the card.

**Widget:** Free Text Card with `markdown-container--m` (Medium). See `references/design-widgets.md` → Free Text Card and `references/design-components.md` → Markdown.

**Inline number coloring and emphasis** — use the markdown-container spans:
- `<span class="pos">+15.5%</span>` for positive headline numbers
- `<span class="neg">−39%</span>` for negative headline numbers
- Plain text for neutral values (counts, dates, durations)
- Use `<strong>` sparingly for non-numeric emphasis (e.g. **every single case**)

**Bold weight rule:** any `<strong>` / `<b>` / `font-weight` for emphasis must resolve to **`font-weight: 500`** (Medium). Never `700` (Bold). Add the global CSS override `strong, b { font-weight: 500; }` to defeat the browser default. The same applies to `.pos` / `.neg` color-emphasis spans — they should be `font-weight: 500`.

**Event Study hero example:**
> Across the past 25 years the S&P 500 has dropped 10% from a peak <span class="pos">8 times</span>. The first-week bounce held in **every single case** (median <span class="pos">+4.6%</span>); a year later the index was higher <span class="pos">5 of 8</span> times, with a median gain of <span class="pos">+15.5%</span> — even after counting the <span class="neg">−39%</span> scar of 2008. Every drawdown eventually clawed back to its prior high, in a median of 11 months.

**Strategy hero example:** see §3e.

### 2a. Hero chips — optional, default off

Compact asset / trigger / case-count chips at the top of the hero card are **optional and default OFF**. The hero prose already names the asset, the trigger, and the case count inline; chips are pure redundancy in the default case.

Turn chips on **only** when at least one of the following is true:
- The asset is non-mainstream and the reader may not recognise it (e.g. an industry ETF or non-US index)
- The trigger needs a compact technical label the prose can't carry cleanly (e.g. `RSI < 20`)
- The page is being remixed into a screener-like collection and chips help skimming across multiple playbooks

If chips are used, they must follow the same shape:
1. **Asset chip** — shortest recognizable label.
2. **Trigger chip** — shortest readable trigger label (1–3 words).
3. **Case count chip** — `Cases: {n_events}` (Event Study) or `Trades: {n_trades}` (Strategy).

Keep them mechanical — do not use interpretive labels like `Trend intact`, `Strong setup`, or `Risk-on`.

### 2b. Counter-narrative card — REMOVED

Earlier versions of this template allowed a separate counter-narrative card under the hero. **Do not add one.** The single most memorable counter-intuitive finding belongs **inside the hero paragraph**, not as a second card. Splitting it into a separate card pushes the four cards (§3 step 3) below the fold and breaks the 3-second rule.

## 3. Layout (single-page scroll, results first)

One vertically-scrolling page. The HTML body starts directly with the first `.widget-grid` — no heading row, no section-title, no chips above it.

**Layout depends on Mode (§0b).** Steps 1 (hero) and 6 (References) are shared; steps 2–5 swap. Event Study mode below; Strategy mode in §3e.

Top-to-bottom order (**Event Study mode**):

1. **Verdict hero** (§2) — one full-width Free Text Card (`.col-8`, `markdown-container--m`). Single paragraph with inline colored numbers. This is the first widget on the page.
2. **Four horizon cards** — exactly four metric cards (`.col-2` × 4). See §3a for which four. **These must sit directly under the hero** (no intervening widgets) so they stay in the first fold.
3. **Main path chart** (`.col-8`) — Chart Card. Normalized event paths overlay (rebased to 100 at event day), median line + a representative sample of past paths + a non-event "typical year" reference line. See §3c.
4. **Two side-by-side analysis charts** (`.col-4` + `.col-4`) — both Chart Cards. See §3b.
5. **Audit ledger** (`.col-8`) — one row per event, **newest first**. Use the row-first flex table and `initTableAlignment`. See §5 ledger collapse rule.
6. **References card** (`.col-8`) — Free Text Card with two short paragraphs:
   - **Trigger source:** how events are identified, in plain language. One sentence on the re-arm rule when relevant.
   - **Data source:** which SDK / symbol / interval, what the forward-move horizons are in trading days, what is and is not included (dividends, transaction costs), and how often the pipeline refreshes.

Methodology lives in the attached `README.md` (§1c), not inside the HTML. The bottom References card is a short data-source eyebrow — it is **not** the methodology. Do not duplicate.

No tabs, no hidden panels other than the ledger expand/collapse behavior — everything else is on the single scroll.

### 3. First-fold rule (very strict)

On a 1440 × 900 viewport, the first fold (measured from the top of the HTML iframe) must contain:
**hero card + four cards** — and nothing else.

(Event Study mode: four horizon cards. Strategy mode: four KPI cards.)

This is what enforces the "results in 3 seconds" promise. Any widget or element that lives between the hero and the four cards (counter-narrative card, belief cards, eyebrow callouts, an in-HTML title row, etc.) is rejected — they have all been removed from this template. The next-fold content starts with step 3 (main chart).

**Canonical reasoning flow:** headline (hero) → headline numbers (4 cards) → main visual (path chart or equity curve) → two side-by-side analyses → raw rows (ledger) → data provenance (references). Each step answers the objection raised by the previous. Methodology is available on-demand via the attached README.

### 3a. Choosing the four horizon cards *(Event Study mode)*

The four horizon metric cards always cut **by time**. Pick one of the two canonical sets based on the trigger:

| Set | Use when | Headline framing |
|---|---|---|
| **1W / 1M / 3M / 1Y** | The short-term reaction is the story (drawdowns, single-day shocks, sentiment extremes, breadth thrusts) | "Does the bounce hold? Then what?" |
| **1M / 3M / 6M / 1Y** | A regime / setup whose payoff plays out over months, not days (macro signals, long-base breakouts, slow-building setups) | "Does the trend stick?" |

Pick one set per playbook; **do not mix** (no 1W / 3M / 6M / 1Y).

In `forward-return` days: 1W = 5, 1M = 21, 3M = 63, 6M = 126, 1Y = 252 (trading days).

Each card carries:
- Big number = the median forward return for that horizon (signed %, color by sign)
- One short label above: `A week later` / `A month later` / `Three months later` / `Six months later` / `A year later`
- Small label below: `Typical (median)`
- Small footer: `positive in {wins} of {N}` (the win rate, not a method description)

### 3b. Two side-by-side analysis charts *(Event Study mode, §3 step 4)*

**Left chart — event vs baseline at each horizon:**
- X-axis: the four horizon labels from §3a (categorical)
- Two paired bars per horizon: event mean (teal) and unconditional baseline mean (grey)
- Baseline is the average forward path over the same period from any non-event start day (sampled regularly, e.g. quarterly). Stored in the feed's `normal_path` time series.
- Dashed line at zero. Tooltip shows both numbers with signed %.

**Right chart — per-event return at the headline horizon:**
- The headline horizon is the one the hero leans on (typically 1Y).
- One bar per past event. Sort **best-to-worst** (not by date).
- X-axis labels: short month-year of the onset (e.g. "Feb 2020"); rotate 30° to avoid clipping.
- Green bars positive, red bars negative; `borderRadius: [1, 1, 0, 0]` per the design-widgets bar spec.
- Dashed line at zero. Tooltip shows full date + signed %.

### 3c. Chart Card — widget spec (shared)

Every chart on the page is a **Chart Card**. Follow `references/design-widgets.md` → Chart Card verbatim (CSS, Chart Rules, Axis Rules, Mark Line, Tooltip, Line Chart / Bar Chart specifics). Do not re-define any of those here.

**Two overrides for this template:**

1. **Chart Card chart-container height = 432px** (excluding the `widget-title` and any `widget-subtitle`). The design-widgets default is 320px; backtest charts (event paths or equity curves) carry more horizon than a typical dashboard tile, so they need a bit more vertical room. All charts on the page — including the side-by-side `.col-4` pair — use 432px. Do not exceed 432 without an explicit reason; taller charts push the ledger and References card too far down.
2. **Every Chart Card has a `widget-subtitle`** — one line of small grey text directly under the widget-title, before the chart body. It explains *what the chart shows* in plain prose, including what colored marks mean (e.g. "Teal bars: the average move after past −10% drawdowns. Grey bars: the S&P 500's plain historical average over the same period from any non-event start day. Dashed line is zero."). This pairs with the title to set context without making the reader hover for hints.

**Main path chart rules (Event Study mode)**

- Rebase the signal day to 100.
- Do not draw every past case as a full-opacity line. Show only a small representative sample of past paths (typically 3: the strongest 1Y, the softest 1Y, and the most recent complete case), each at lineWidth 1 and opacity ≈ 0.55.
- **Do not draw a Q1–Q3 band / middle-half shaded area.** When the event set contains extreme outliers (e.g. 2008), the Q1–Q3 spread on a rebased path grows so wide that the band visually swallows the chart. The sample lines already convey dispersion; the band adds noise, not signal.
- Show the typical-after-signal line (median) and the typical-non-event-year reference line (dashed grey).
- Tooltip should show the readout lines (median, sample lines, reference) clearly; do not pollute it with helper series.

**One-event-per-bar chart rules** (the right side-by-side chart, Event Study mode)

- One bar per completed past event.
- Sort by return (best-to-worst), not by date — the visual gradient is the headline.
- Sparse year anchors on x-axis if dates are used; full date in tooltip.
- Green positive, red negative.
- Keep the zero line; avoid label text that can clip.

### 3d. Plain language (every user-visible surface)

Applies to cards, chart titles, widget subtitles, axis labels, table headers, tooltips, References card, and methodology — not just hero. LLM defaults trend toward trading-desk jargon; override them.

- **Tickers**: first mention only, in parens after the plain name ("the S&P 500 (SPY)"). Typically in the hero or References card; for basket playbooks, in the first card introducing each member. Never in chart titles, axis labels, table headers, or tooltips. Default map: SPY → "the S&P 500", USO → "oil", TLT → "long-dated Treasury bonds", GLD → "gold", QQQ → "the Nasdaq (100)", VIX → "market volatility", DXY / UUP → "the US dollar"; company tickers → company names.
- **Time horizons and telegraphic codes**: "a month later" / "a year later" / "sixty trading days after the event". Never `+1M` / `+1Y` / `D+10` / `D+60` / `d21` / `fwd_3m` / `N=15` / bare `21 trading days`.
- **Banned jargon**: `drawdown` (in body copy — title may use it as a noun if it's the trigger word; Strategy KPI cards may use it since "Max DD" is the standard label), `cohort`, `regime`, `baseline` (in body copy — methodology may use it), `dispersion`, `reaction`, `realization`, `persistency`, `cumulative return`, `IQR`, `whiskers`, `outliers`, `realized volatility`, `R-squared`. Prefer: "biggest dip", "group", "state", "plain historical average", "typical outcome", "range between biggest and smallest past cases", "middle half of past outcomes", "daily price swings", "almost no relationship between the two".
- **Explain cutoffs inline**: every `since YYYY` / sample filter / threshold carries a one-clause reason on first mention ("since 2000 — that's when the daily S&P 500 series starts in our data"; "10% from peak — the textbook threshold for a 'correction'").
- **Methodology** (in the attached README) — plain prose, no formulas, no `consensus EPS` / `recovery date` / `sample period` jargon. Any legal disclaimer lives at the bottom of the README.

### 3e. Strategy mode layout

Six-step single-scroll, steps 2–5 swapped from Event Study; steps 1 (hero) and 6 (References) shared.

1. **Verdict hero** (§2) — Strategy hero example below.
2. **Four KPI cards** (`.col-2` × 4) — pick one set, don't mix:

   | Set | Use when | Cards |
   |---|---|---|
   | **Performance** (default) | Most strategies | `Total Return` / `Sharpe` / `Max DD` / `Win Rate` |
   | **Trade-by-trade** | Intraday / high-turnover where trade count is the point | `CAGR` / `Profit Factor` / `# Trades` / `Avg Trade` |

   Big signed number colored by sign (returns / DD); plain text for Sharpe / PF / count. Short label above, observable-context footer (`vs +12.1% buy-and-hold`, `worst Feb 2026`) — never method description.

3. **Equity curve** (`.col-8`, Chart Card) — strategy net equity (teal `--main-m3`) vs buy-and-hold benchmark on same instrument and window (grey). Rebase both to 100 or to starting cash; state choice in widget-subtitle. Optional: lightly shade strategy drawdown periods (red, low opacity). 432px height per §3c.

4. **Two side-by-side** (`.col-4` + `.col-4`):
   - **Left — Drawdown underwater plot.** Time on x; drawdown % from running peak as filled area below zero (red token, low opacity); annotate the worst drawdown (depth + date); dashed zero line.
   - **Right — Trade P&L distribution.** Default: one bar per trade, sorted **best-to-worst** (green positive, red negative); dashed zero line. For >100 trades, switch to a signed-bin P&L histogram. Alternative slot: monthly return heatmap (rows = year, cols = month) when the strategy has ≥3 full years.

5. **Trade ledger** (`.col-8`) — one row per trade, **newest first**. Columns: `#` / `Open` (date+time for intraday) / `Side` / `Entry` / `Exit` / `Hold` / `P&L` (signed %, colored). Row-first flex table + `initTableAlignment`. Collapse rule per §5.

6. **References card** — two paragraphs: rule (entry / exit / sizing in plain prose), and data source (engine, instrument + interval, simulation tick, slippage + commission, window dates, refresh cadence).

**Strategy hero — required inline numbers:** total return, vs buy-and-hold, Sharpe, worst drawdown, win rate (`X of Y trades`). Optional: profit factor when trade count is high. End with one-clause fees note.

Example:
> Over the trailing 12 months on QQQ 1-min, the NQ Daybreak ORB returned <span class="pos">+18.4%</span> vs buy-and-hold's <span class="pos">+12.1%</span>, with a **1.42** Sharpe and a worst drawdown of <span class="neg">−8.3%</span>. The rule won <span class="pos">54%</span> of its **248 trades**; profit factor 1.6. Net of 1-tick slippage and $2.50/contract commission.

**Strategy title override** (replaces §1a): `[Strategy name] on [Instrument]` — e.g. `NQ Daybreak ORB on QQQ`. Slug: `orb-daybreak-qqq`. No window suffix; window lives in hero.

## 4. Data presentation

- **Number is the visual hero.** Big numerical value, small descriptive label underneath. Never the other way around.
- **Every chart** pairs a short title with a `widget-subtitle` (one-line plain-prose explanation, see §3c).
- **Consistent color semantics** across cards, charts, and tables: positive = teal/cyan token (`--main-m3`), negative = red token (`--main-m4`), neutral/reference = grey token. Same meaning everywhere. ECharts is Canvas — use raw hex/rgba, not `var(--…)`.
- **Reference lines** on comparison charts (e.g. dashed zero line on per-event / per-trade bar chart; dashed median line where helpful) to anchor interpretation at a glance.
- **Aggregate → individual.** At least one chart must show per-event (Event Study) or per-trade (Strategy) detail — not just averages — so the reader can judge dispersion and clustering. The right side-by-side chart covers this in both modes.
- **Footer = observable context.** Card footers carry a specific date, delta, or bucket label (`positive in 5 of 8`, `vs +12.1% buy-and-hold`) — never a method description. Method lives once, in the attached README and the References card.

## 5. Hard rules

- **No** "last updated / refreshed / as of" timestamp anywhere on the page.
- **No** filters, dropdowns, selectors.
- **No** in-HTML heading, title row, or section-title above the first widget-grid. The platform chrome renders the `display_name` above the iframe — the HTML adds none of its own. Hero card is the first widget on the page.
- **No** in-HTML README chip, methodology modal, or "?" trigger. Methodology lives in the attached `README.md` file (§1c), surfaced by the platform chrome.
- **No** "What-If" label anywhere user-facing (title, slug, `display_name`, hero, README, chips).
- **No** Q1–Q3 / middle-half shaded band on the main path chart (Event Study). Sample lines only (§3c).
- **No** counter-narrative card, belief cards, featured-case cards, readout rail — any element that sits between the hero and the four cards and pushes them below the fold is forbidden. Earlier template versions allowed these; they are now explicitly removed.
- **Font weight 500 only for emphasis.** All `<strong>`, `<b>`, `.pos`, `.neg` use `font-weight: 500`. The browser default for `<strong>`/`<b>` is `700`, which violates the Alva design-system rule "Regular (400) and Medium (500) only". Add `strong, b { font-weight: 500; }` globally in every playbook's CSS.
- **Only interactivity allowed:** chart hover tooltips and the ledger expand/collapse button when row count is high.

**Ledger collapse rule** (applies to event ledger in Event Study, trade ledger in Strategy)

- If row count is 12 or fewer, show all rows.
- If row count is above 12, show the latest 8 rows by default.
- Add one compact `Show all N cases` (Event Study) / `Show all N trades` (Strategy) button in the ledger title row.
- When expanded, the button becomes `Show latest 8`.
- Use the row-first flex table and `initTableAlignment`; do not use a native HTML table.

## 6. Methodology — attached README.md, not in-HTML modal

Methodology is **not** rendered inside the playbook HTML. There is no `.modal-overlay`, no `.modal-panel`, no `data-modal-open` trigger, no in-HTML README button. The platform chrome surfaces the playbook's attached `README.md` automatically.

### How to ship methodology

1. **Write** the methodology as a standalone Markdown file. Canonical section shape (see [release.md → Playbook README](../../references/api/release.md#playbook-readme)):

   - **Event Study**: intro + `## How we picked events` / `## How we measured what came next` / `## About the path chart` / `## About the side-by-side bar charts` / `## Sample size and what it means` / `## Data and refresh`
   - **Strategy**: intro + `## How the rule works` (entry/exit/sizing) / `## How we measured returns` (rebase, benchmark, fees) / `## About the equity curve and drawdown chart` / `## About the trade ledger` / `## Window, sample, and what it means` / `## Data and refresh`
   - Optional legal eyebrow (`Historical observation only; not investment advice.`)

2. **Upload** to ALFS at `'~/playbooks/<name>/README.md'`.
3. **Attach** with the release CLI: `alva release playbook --readme-url '/alva/home/<username>/playbooks/<name>/README.md'`. The path must be an absolute ALFS path.

### README ≠ References card

The attached README is the full explanation (how we picked events / how the rule works, how we measured, sample-size caveats, asset choice). The References card at the bottom of the scroll (§3 step 6) is a two-sentence data-source eyebrow. They have different audiences (curious / glancing) and different content shapes. Do not duplicate the methodology inside the References card.

### Legacy modal pattern is removed

Earlier versions of this template instructed building an in-HTML `.modal-overlay` / `.modal-panel` triggered by a `.section-readme-btn`. **That pattern is removed.** The platform chrome owns README rendering; the playbook HTML must not.