# stockagent

A personal, **alert-only** stock idea agent. Every week it screens tech stocks (US first; MY/HK optional),
runs the open-source [TradingAgents](https://github.com/TauricResearch/TradingAgents) multi-agent analysis
on a few candidates, and sends trade plans to Telegram: buy zone, take-profit, stop loss, confidence,
risk/reward and reasoning. It then watches prices and news and alerts you when a level is hit.

**It never trades.** It reads your moomoo account (quotes and positions) through OpenD, read-only.
The code has no order or trade-unlock calls, and a test (`tests/test_safety.py`) fails if any appear.
You place every order yourself in the moomoo app.

> Informational only, not financial advice.

## How it works

| When (MYT) | What |
|---|---|
| Sun 10:00 | Screen the tech universe (`config/universe.yaml`, rules in `config/screener.yaml`), queue the top candidates and your watchlist for AI analysis |
| Mon 20:00 | Queue a review of every stock you hold |
| Tue–Sat 08:30 | Daily morning briefing after US market close: index moves, holdings day change & P/L, news, and automatic deep plan re-review if a holding moved >=5% or had major news |
| Every 15 min | Read your positions from moomoo; link buys to plans, close plans you sold, queue analysis for holdings without a plan |
| Every 30 min | Check news on held stocks; major news queues an urgent re-review |
| Live | Price alerts: entered buy zone, partial TP, TP, SL (each once per plan) |
| Daily | Expire unused plans after 60 days; score past plans (TP or SL first, 4/12/26-week returns) |
| Sun 21:00 | Weekly summary |

Analyses run one at a time from a priority queue: stop-loss/news re-reviews, then `/plan` requests and new
holdings, then weekly reviews, then new candidates. `MAX_RUNS_PER_DAY` caps AI usage for the free tier.

## Talk to it

Just message the bot in plain words, e.g. *"I saw the market dropped, is it a good time to enter MDB, or should I
buy more NVDA?"* It answers in seconds on the quick AI model: a verdict (Yes / Wait / No), the reason, and an
entry or add range with take-profit and stop loss. It looks things up as it goes: live prices, your moomoo
positions (portfolio weight is of stock holdings, cash excluded), plans, the latest deep analysis, news and the
day's index moves. It can't trade.

It offers a **Run full analysis (~5 min)** button when the quick answer rests on weak ground: the last deep
analysis is older than `DEEP_STALE_DAYS` (7), the price moved more than `DEEP_MOVE_PCT` (8%) since, there's major
news since, or the stock was never analysed. Ask "do a full analysis on MDB" to run one directly. When it
finishes, the bot follows up and says whether its view changed.

**Memory:** it remembers the last `CHAT_HISTORY` (20) messages, including alerts it sent, so you can reply
"why?" to an alert. It keeps short dated notes per stock and about you ("I don't short", "max 20% per
stock"). Ask "what do you remember about MDB?" or say "forget that"; forgotten notes can be restored.

`CHAT_MAX_PER_DAY` (1000) is a safety cap on chat AI calls (each lookup round counts); you get a heads-up at 90%.
It is separate from `MAX_RUNS_PER_DAY`, which still caps deep analyses.

## Quick-check Telegram commands

`/holdings` · `/plans` · `/status` · `/help`. Only your `TELEGRAM_CHAT_ID` is answered.
The commands are registered in Telegram's "/" menu each time the service starts.
Everything else—requesting a deep analysis, asking why an analysis made a call, or adding/removing tickers on your watchlist—is done simply by talking to your advisor in plain words.

## Setup (local trial on Windows)

1. Install [uv](https://docs.astral.sh/uv/), then `uv sync`.
2. Telegram: create a bot with @BotFather (token) and get your chat id (e.g. message @userinfobot).
3. AI provider (one of): Gemini (free key at aistudio.google.com), OpenAI (platform.openai.com) or Anthropic
   (console.anthropic.com). See the three blocks in `.env.example`; switching later is just those lines.
4. `copy .env.example .env` and fill it in.
5. Install moomoo OpenD for Windows, log in, keep it running.
6. Check what your account can do through the API:

   ```bash
   uv run python scripts/check_permissions.py
   ```

   If US `live_subscribe` is not ok, set `PRICE_SOURCE=poll`. Add `MY`/`HK` to `MARKETS` only if they work.
7. Try one analysis: `uv run python -m stockagent.analysis NVDA`
8. Run the service: `uv run python -m stockagent`

Deploying 24/7 on Oracle Cloud's free tier: see [deploy/ORACLE_SETUP.md](deploy/ORACLE_SETUP.md).

## Development

```bash
uv run pytest
uv run ruff check .
uv run mypy src scripts
```
