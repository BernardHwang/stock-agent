"""Deep analysis: TradingAgents report -> structured plan -> lifecycle + Telegram, within a daily AI budget."""

import asyncio
import copy
import logging
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from .config import Settings
from .health import Health
from .lifecycle import apply_new_analysis
from .messages import format_health, format_info, format_invalid_plan, format_no_plan, format_plan
from .models import PlanFields, Position, validate_fields
from .store import Store
from .symbols import to_yf

log = logging.getLogger(__name__)

TradingAgentsGraph: Any = None  # imported lazily: the framework is slow to import

RunFn = Callable[[str, str, Settings], str]
ExtractFn = Callable[[str, str, Position | None, Settings], PlanFields]

# TradingAgents provider name -> langchain init_chat_model provider name
_LC_PROVIDER = {"google": "google_genai"}

EXTRACT_PROMPT = """You turn an equity research report into a trade plan for a long-only investor.
The investor holds positions for 3-12 months and targets at least 20% gain per year.
They place every order themselves; you only advise.

Rules:
- Long-only. Use BUY to open a new position. If the investor already holds the stock, use HOLD, TRIM
  (take partial profit / reduce) or EXIT instead of BUY.
- For BUY: give a buy zone (entry_low..entry_high) near current support or current price, a stop loss below
  a meaningful support level (usually 8-15% below entry), a take-profit sized for at least 20% upside, and
  optionally a partial take-profit in between.
- For HOLD/TRIM: give updated tp and sl relative to the current price. For EXIT, levels may be empty.
- If the report does not support a buy, do not invent one: return HOLD with low confidence.
- All prices in the stock's trading currency. Reasoning: plain English, at most 600 characters.

Ticker: {code}
{held}
Report:
{report}
"""


def run_tradingagents(symbol: str, day: str, settings: Settings) -> str:
    global TradingAgentsGraph
    if TradingAgentsGraph is None:
        from tradingagents.graph.trading_graph import TradingAgentsGraph as _Graph
        TradingAgentsGraph = _Graph
    from tradingagents.default_config import DEFAULT_CONFIG

    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg.update(
        llm_provider=settings.llm_provider,
        deep_think_llm=settings.deep_model,
        quick_think_llm=settings.quick_model,
        max_debate_rounds=settings.max_debate_rounds,
        max_risk_discuss_rounds=settings.max_risk_discuss_rounds,
        holding_period_days=90,
    )
    graph = TradingAgentsGraph(selected_analysts=("market", "social", "news", "fundamentals"), debug=False,
                               config=cfg)
    state, _signal = graph.propagate(symbol, day)
    sections = [("Final decision", "final_trade_decision"), ("Trader plan", "trader_investment_plan"),
                ("Technical analysis", "market_report"), ("Fundamentals", "fundamentals_report")]
    return "\n\n".join(f"## {title}\n{str(state.get(key, ''))[:6000]}" for title, key in sections
                       if state.get(key))


def extract_plan(report: str, code: str, held: Position | None, settings: Settings) -> PlanFields:
    from langchain.chat_models import init_chat_model

    provider = _LC_PROVIDER.get(settings.llm_provider, settings.llm_provider)
    llm = init_chat_model(settings.deep_model, model_provider=provider).with_structured_output(PlanFields)
    held_line = (f"The investor HOLDS {held.qty:g} shares at average cost {held.avg_cost:.2f}." if held
                 else "The investor does not hold this stock.")
    result = llm.invoke(EXTRACT_PROMPT.format(code=code, held=held_line, report=report))
    return result if isinstance(result, PlanFields) else PlanFields.model_validate(result)


def is_rate_limit(exc: BaseException) -> bool:
    seen: BaseException | None = exc
    while seen is not None:
        text = f"{type(seen).__name__} {seen}".lower()
        if any(k in text for k in ("429", "resourceexhausted", "resource_exhausted", "rate limit", "ratelimit",
                                   "quota")):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class AnalysisWorker:
    def __init__(self, settings: Settings, store: Store, health: Health, notify: Callable[[str], Awaitable[None]],
                 run: RunFn = run_tradingagents, extract: ExtractFn = extract_plan,
                 now: Callable[[], datetime] = _utcnow):
        self.settings, self.store, self.health, self.notify = settings, store, health, notify
        self.run, self.extract, self.now = run, extract, now
        self._lock = asyncio.Lock()

    async def drain(self) -> None:
        async with self._lock:  # one analysis at a time
            while self.store.count_runs_on(self.now().date()) < self.settings.max_runs_per_day:
                item = self.store.next_queue_item()
                if item is None:
                    return
                if not await self._process(item.id, item.code, item.reason):
                    return

    async def _process(self, item_id: int, code: str, reason: str) -> bool:
        """Returns False when draining should stop (AI quota exhausted)."""
        now = self.now()
        held = next((p for p in self.store.last_positions() if p.code == code), None)
        try:
            self.store.record_run(code, now)
            report = await asyncio.to_thread(self.run, to_yf(code), now.date().isoformat(), self.settings)
            fields = await asyncio.to_thread(self.extract, report, code, held, self.settings)
        except Exception as exc:
            if is_rate_limit(exc):
                self.store.requeue(item_id)
                alert = self.health.problem("ai_quota", "AI quota reached. Remaining analyses will retry later.")
                if alert:
                    await self.notify(format_health(alert.text))
                return False
            log.exception("analysis failed for %s", code)
            self.store.finish_queue_item(item_id, "failed")
            await self.notify(format_info(f"Analysis for {code} failed ({type(exc).__name__}). It will not retry "
                                          "automatically; use /plan to try again."))
            return True

        recovered = self.health.resolved("ai_quota")
        if recovered:
            await self.notify(format_info("AI quota available again."))
        errors = validate_fields(fields)
        if errors:
            log.warning("invalid plan for %s: %s", code, errors)
            self.store.finish_queue_item(item_id, "done")
            await self.notify(format_invalid_plan(code, errors))
            return True

        plan = apply_new_analysis(self.store, code, fields, reason, now)
        self.store.finish_queue_item(item_id, "done")
        text = format_plan(plan, now, self.settings.tz) if plan.id else format_no_plan(code, fields)
        await self.notify(text)
        return True


def _cli() -> None:
    """Manual live check: uv run python -m stockagent.analysis NVDA"""
    from dotenv import load_dotenv

    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    s = Settings()
    code = sys.argv[1] if "." in sys.argv[1] else f"US.{sys.argv[1]}"
    report = run_tradingagents(to_yf(code), _utcnow().date().isoformat(), s)
    print(extract_plan(report, code, None, s).model_dump_json(indent=2))


if __name__ == "__main__":
    _cli()
