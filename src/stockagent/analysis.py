"""Deep analysis: TradingAgents report -> structured plan -> lifecycle + Telegram, within a daily AI budget."""

import asyncio
import copy
import json
import logging
import os
import re
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from .config import Settings
from .health import Health
from .lifecycle import apply_new_analysis
from .messages import format_health, format_info, format_invalid_plan, format_no_plan, format_plan
from .models import PlanFields, Position, validate_against_price, validate_fields
from .store import Store
from .symbols import to_yf

log = logging.getLogger(__name__)

TradingAgentsGraph: Any = None  # imported lazily: the framework is slow to import

RunFn = Callable[[str, str, Settings], str]
ExtractFn = Callable[[str, str, Position | None, Settings], PlanFields]

# TradingAgents provider name -> langchain init_chat_model provider name
_LC_PROVIDER = {"google": "google_genai", "cloudflare": "openai"}


def llm_client_kwargs(settings: Settings) -> dict[str, Any]:
    """Extra kwargs for init_chat_model when using OpenAI-compatible endpoints like Cloudflare Workers AI."""
    kw: dict[str, Any] = {}
    if settings.llm_provider.lower() == "cloudflare":
        if settings.cloudflare_account_id:
            kw["base_url"] = (
                f"https://api.cloudflare.com/client/v4/accounts/{settings.cloudflare_account_id}/ai/v1"
            )
        if settings.cloudflare_api_token:
            kw["api_key"] = settings.cloudflare_api_token.get_secret_value()
    if settings.openai_base_url:
        kw["base_url"] = settings.openai_base_url
    return kw

EXTRACT_PROMPT = """You are a pragmatic, candid personal financial advisor turning an equity research report
into a clear trade plan for a long-only investor. The investor typically holds positions for 3-12 months and
targets at least 20% annualized return. They place every order themselves; you advise them as their partner.

Rules:
- Long-only. Use BUY to open a new position. If the investor already holds the stock, use HOLD, TRIM
  (take partial profit / reduce risk) or EXIT instead of BUY.
- For BUY: give a buy zone (entry_low..entry_high) near current support or current price, a stop loss below
  a meaningful support level (usually 8-15% below entry), a take-profit sized for at least 20% upside, and
  optionally a partial take-profit in between.
- For HOLD/TRIM: give updated tp and sl relative to the current price. For EXIT, levels may be empty.
- If the report does not support a buy, do not force one: return HOLD with low confidence and explain honestly
  why waiting or passing is the smarter move.
- All prices in the stock's trading currency.
- Reasoning: write directly to the investor in a warm, candid advisor voice ("I'd look to accumulate...",
  "Since you're already holding at...", "The risk here is..."). Explain the core thesis, key catalyst, and
  main risk in plain English, at most 600 characters.

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
    provider = settings.llm_provider
    extra_cfg: dict[str, Any] = {}
    if provider.lower() == "cloudflare":
        provider = "openai"
        if settings.cloudflare_account_id:
            extra_cfg["backend_url"] = (
                f"https://api.cloudflare.com/client/v4/accounts/{settings.cloudflare_account_id}/ai/v1"
            )
        if settings.cloudflare_api_token and not os.environ.get("OPENAI_API_KEY"):
            os.environ["OPENAI_API_KEY"] = settings.cloudflare_api_token.get_secret_value()
    elif settings.openai_base_url:
        extra_cfg["backend_url"] = settings.openai_base_url
    cfg.update(
        llm_provider=provider,
        deep_think_llm=settings.deep_model,
        quick_think_llm=settings.quick_model,
        max_debate_rounds=settings.max_debate_rounds,
        max_risk_discuss_rounds=settings.max_risk_discuss_rounds,
        holding_period_days=90,
        **extra_cfg,
    )
    graph = TradingAgentsGraph(selected_analysts=("market", "social", "news", "fundamentals"), debug=False,
                               config=cfg)
    state, _signal = graph.propagate(symbol, day)
    sections = [("Final decision", "final_trade_decision"), ("Trader plan", "trader_investment_plan"),
                ("Technical analysis", "market_report"), ("Fundamentals", "fundamentals_report")]
    return "\n\n".join(f"## {title}\n{str(state.get(key, ''))[:6000]}" for title, key in sections
                       if state.get(key))


def langchain_provider(name: str) -> str:
    return _LC_PROVIDER.get(name.lower(), name.lower())


JSON_SCHEMA_HINT = """
Respond ONLY with a valid JSON object matching this exact schema (no markdown fences or extra text):
{
  "action": "BUY" | "HOLD" | "TRIM" | "EXIT",
  "entry_low": number or null,
  "entry_high": number or null,
  "partial_tp": number or null,
  "tp": number or null,
  "sl": number or null,
  "confidence": "low" | "medium" | "high",
  "holding_months": integer,
  "reasoning": "string (at most 600 chars)"
}"""


def parse_plan_json(raw_text: str) -> PlanFields:
    """Extract and validate a PlanFields JSON object from raw LLM output (handles markdown fences)."""
    cleaned = raw_text.strip()
    match = re.search(r"\{.*\}", cleaned, re.S)
    if match:
        cleaned = match.group(0)
    return PlanFields.model_validate_json(cleaned)


def extract_plan(report: str, code: str, held: Position | None, settings: Settings) -> PlanFields:
    from langchain.chat_models import init_chat_model

    provider = langchain_provider(settings.llm_provider)
    base_llm = init_chat_model(
        settings.deep_model, model_provider=provider, **llm_client_kwargs(settings)
    )
    held_line = (f"The investor HOLDS {held.qty:g} shares at average cost {held.avg_cost:.2f}." if held
                 else "The investor does not hold this stock.")
    prompt = EXTRACT_PROMPT.format(code=code, held=held_line, report=report)
    try:
        llm = base_llm.with_structured_output(PlanFields)
        result = llm.invoke(prompt)
        if result is not None:
            return result if isinstance(result, PlanFields) else PlanFields.model_validate(result)
    except Exception:
        log.info("structured output unsupported or failed for %s; falling back to JSON extraction", code)
    ai_msg = base_llm.invoke(prompt + "\n" + JSON_SCHEMA_HINT)
    content = getattr(ai_msg, "content", ai_msg)
    return parse_plan_json(str(content))


class SavedReport(BaseModel):
    at: datetime
    text: str
    price: float | None = None  # price when the analysis ran; None for reports saved before it was recorded


def save_report(store: Store, code: str, report: str, at: datetime, price: float | None = None) -> None:
    store.kv_set(f"report:{code}", json.dumps({"at": at.isoformat(timespec="minutes"), "text": report,
                                               "price": price}))


def load_report(store: Store, code: str) -> SavedReport | None:
    raw = store.kv_get(f"report:{code}")
    return SavedReport.model_validate_json(raw) if raw else None


def report_section(report: str, title: str) -> str | None:
    """Text of a '## title' section from a saved report."""
    match = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", report, re.S | re.M)
    return match.group(1).strip() if match else None


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
                 now: Callable[[], datetime] = _utcnow,
                 price_fn: Callable[[str], float | None] | None = None,
                 on_result: Callable[[str, str, str], Awaitable[None]] | None = None):
        self.settings, self.store, self.health, self.notify = settings, store, health, notify
        self.run, self.extract, self.now, self.price_fn = run, extract, now, price_fn
        self.on_result = on_result  # (code, queue reason, message sent) after a plan or no-plan message
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

        if self.health.resolved("ai_quota"):
            await self.notify(format_info("AI quota available again."))
        price = await self._price(code)
        save_report(self.store, code, report, now, price)
        try:
            errors = validate_fields(fields) or validate_against_price(fields, price)
            if errors:
                log.warning("invalid plan for %s: %s", code, errors)
                self.store.finish_queue_item(item_id, "done")
                await self.notify(format_invalid_plan(code, errors))
                return True
            plan = apply_new_analysis(self.store, code, fields, reason, now, held=held is not None)
            self.store.finish_queue_item(item_id, "done")
        except Exception as exc:
            log.exception("saving plan failed for %s", code)
            self.store.finish_queue_item(item_id, "failed")
            await self.notify(format_info(f"Analysis for {code} failed while saving ({type(exc).__name__})."))
            return True
        text = format_plan(plan, now, self.settings.tz) if plan.id else format_no_plan(code, fields)
        await self.notify(text)
        if self.on_result is not None:
            try:
                await self.on_result(code, reason, text)
            except Exception:
                log.exception("on_result failed for %s", code)
        return True

    async def _price(self, code: str) -> float | None:
        if self.price_fn is None:
            return None
        try:
            return await asyncio.to_thread(self.price_fn, code)
        except Exception:
            log.info("no current price for %s", code)
            return None


def _cli() -> None:
    """Manual live check: uv run python -m stockagent.analysis NVDA"""
    from dotenv import load_dotenv

    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    s = Settings()
    code = sys.argv[1] if "." in sys.argv[1] else f"US.{sys.argv[1]}"
    held = read_held_position(code, s)
    print(f"Position in {code}: " + (f"{held.qty:g} @ {held.avg_cost:.2f}" if held else "none found"))
    report = run_tradingagents(to_yf(code), _utcnow().date().isoformat(), s)
    print(extract_plan(report, code, held, s).model_dump_json(indent=2))


def read_held_position(code: str, settings: Settings, gateway: Any = None) -> Position | None:
    """Read-only lookup of the owner's moomoo position; None if not held or OpenD is unavailable."""
    if gateway is None:
        from .moomoo_gw import MoomooGateway

        gateway = MoomooGateway(settings.moomoo_host, settings.moomoo_port, settings.moomoo_security_firm,
                                settings.markets, on_tick=lambda c, p: None)
    try:
        return next((p for p in gateway.positions() if p.code == code), None)
    except Exception as exc:
        print(f"Could not read moomoo positions ({type(exc).__name__}); analysing as not held.")
        return None


if __name__ == "__main__":
    _cli()
