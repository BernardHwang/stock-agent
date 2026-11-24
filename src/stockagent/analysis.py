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

from .config import Settings, local_date
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


TOOL_CALL_FILLER = "Looking that up."


def patch_openai_tool_messages() -> None:
    """Make tool-call history acceptable to Cloudflare Workers AI in every ChatOpenAI request.

    Applies to TradingAgents' ChatOpenAI subclasses too. Cloudflare answers HTTP 400 when an assistant tool-call
    message has ``content: null`` (langchain's default) or holds more than one tool call (parallel calls, which it
    also gives identical ids). Either made deep analyses fail mid-run after earlier calls had already spent quota.
    """
    from langchain_openai import ChatOpenAI

    original = ChatOpenAI._get_request_payload
    if getattr(original, "_cloudflare_safe", False):
        return

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = original(self, input_, stop=stop, **kwargs)
        if "messages" in payload:
            payload["messages"] = _cloudflare_safe_messages(payload["messages"])
        return payload

    _get_request_payload._cloudflare_safe = True  # type: ignore[attr-defined]
    ChatOpenAI._get_request_payload = _get_request_payload  # type: ignore[method-assign]


def _cloudflare_safe_messages(messages: list[dict]) -> list[dict]:
    """One tool call per assistant message, each with text, a unique id, and its result right after it."""
    out: list[dict] = []
    i = 0
    while i < len(messages):
        m = messages[i]
        calls = m.get("tool_calls") if m.get("role") == "assistant" else None
        if not calls:
            out.append(m)
            i += 1
            continue
        results = []
        j = i + 1
        while j < len(messages) and messages[j].get("role") == "tool":
            results.append(messages[j])
            j += 1
        if len(calls) > 1 and len(results) != len(calls):
            log.warning("cannot split %d tool calls with %d results; Cloudflare may reject this request",
                        len(calls), len(results))
        if len(calls) == 1 or len(results) != len(calls):
            out.append({**m, "content": m.get("content") or TOOL_CALL_FILLER})
            i += 1
            continue
        # Results follow in call order (ids may be duplicated, so position is the only reliable link).
        for k, (call, result) in enumerate(zip(calls, results, strict=True)):
            call_id = f"{call.get('id') or 'call'}_{k}"
            content = m.get("content") if k == 0 else None
            out.append({**m, "content": content or TOOL_CALL_FILLER, "tool_calls": [{**call, "id": call_id}]})
            out.append({**result, "tool_call_id": call_id})
        i = j
    return out


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

VERIFIED_SECTION = "Verified market data snapshot"

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
- Base every price level on the "{verified}" section at the end of the report: it is verified exchange data
  (latest close, moving averages, Bollinger bands, recent closes). If the analysts' text quotes different
  prices, trust the verified data. A BUY zone must sit near the latest close, not where it traded long ago.
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
    parts = [f"## {title}\n{str(state.get(key, ''))[:6000]}" for title, key in sections if state.get(key)]
    try:
        parts.append(verified_snapshot(symbol, day)[:4000])  # has its own "## Verified market data snapshot" heading
    except Exception:
        log.warning("no verified market snapshot for %s", symbol, exc_info=True)
    return "\n\n".join(parts)


def verified_snapshot(symbol: str, day: str) -> str:
    """TradingAgents' deterministic yfinance snapshot: latest close, indicators, recent closes (no AI calls)."""
    from tradingagents.dataflows.vendors.yahoo.snapshot import build_verified_market_snapshot

    return build_verified_market_snapshot(symbol, day, 10)


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
    prompt = EXTRACT_PROMPT.format(code=code, held=held_line, report=report, verified=VERIFIED_SECTION)
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


RETRY_NOTE = ("\n\n## Correction needed\nYour previous plan was rejected: {errors}. Return a corrected plan that "
              "follows every rule; for HOLD or TRIM give both tp and sl.")


def _plan_errors(fields: PlanFields, price: float | None) -> list[str]:
    return validate_fields(fields) or validate_against_price(fields, price)


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


_RATE_LIMIT_RE = re.compile(r"\b429\b|resourceexhausted|resource_exhausted|rate limit|ratelimit|quota")


def is_rate_limit(exc: BaseException) -> bool:
    seen: BaseException | None = exc
    while seen is not None:
        if getattr(seen, "status_code", None) == 429 or _RATE_LIMIT_RE.search(f"{type(seen).__name__} {seen}".lower()):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def error_detail(exc: BaseException, limit: int = 200) -> str:
    """The provider's own reason, short and with the account id masked, for the owner to see."""
    text = re.sub(r"accounts/[^/\s'\"]+", "accounts/…", " ".join(str(exc).split()))
    return text[:limit]


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
            tz = self.settings.tz
            while self.store.count_runs_on(local_date(self.now(), tz), tz) < self.settings.max_runs_per_day:
                item = self.store.next_queue_item()
                if item is None:
                    return
                if not await self._process(item.id, item.code, item.reason):
                    return

    async def _process(self, item_id: int, code: str, reason: str) -> bool:
        """Returns False when draining should stop (AI quota exhausted)."""
        now = self.now()
        held = next((p for p in self.store.last_positions() if p.code == code), None)
        pending_key = f"extract_pending:{code}"
        saved = load_report(self.store, code) if self.store.kv_get(pending_key) else None
        if saved is not None:
            # The last run's extraction hit a rate limit: retry it from the saved report instead of re-running.
            report = saved.text
            price = await self._price(code) or saved.price
        else:
            try:
                self.store.record_run(code, now)
                report = await asyncio.to_thread(self.run, to_yf(code), now.date().isoformat(), self.settings)
            except Exception as exc:
                if is_rate_limit(exc):
                    self.store.forget_run(code, now)  # refused before any work: don't spend the daily budget
                return await self._failed(item_id, code, exc)
            # Save before extracting: the report is the expensive part and chat can still use it.
            price = await self._price(code)
            save_report(self.store, code, report, now, price)
        try:
            fields = await asyncio.to_thread(self.extract, report, code, held, self.settings)
        except Exception as exc:
            self.store.kv_set(pending_key, "1" if is_rate_limit(exc) else "")
            return await self._failed(item_id, code, exc)
        self.store.kv_set(pending_key, "")

        if self.health.resolved("ai_quota"):
            await self.notify(format_info("AI quota available again."))
        errors = _plan_errors(fields, price)
        if errors:
            # One extraction call is cheap next to the analysis it would otherwise throw away.
            log.info("plan for %s rejected (%s); retrying extraction once", code, errors)
            retry_report = report + RETRY_NOTE.format(errors="; ".join(errors))
            try:
                retried = await asyncio.to_thread(self.extract, retry_report, code, held, self.settings)
            except Exception:
                log.warning("retrying the plan extraction failed for %s", code, exc_info=True)
            else:
                if not _plan_errors(retried, price):
                    fields, errors = retried, []
        try:
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

    async def _failed(self, item_id: int, code: str, exc: Exception) -> bool:
        """Returns False when draining should stop (AI quota exhausted)."""
        if is_rate_limit(exc):
            self.store.requeue(item_id)
            alert = self.health.problem("ai_quota", "AI quota reached. Remaining analyses will retry later. "
                                                    f"Provider said: {error_detail(exc)}")
            if alert:
                await self.notify(format_health(alert.text))
            return False
        log.exception("analysis failed for %s", code)
        self.store.finish_queue_item(item_id, "failed")
        await self.notify(format_info(f"Analysis for {code} failed ({type(exc).__name__}). It will not retry "
                                      "automatically; ask me to run a full analysis to try again."))
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
    patch_openai_tool_messages()
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
                                settings.markets, on_tick=lambda c, p: None,
                                rsa_key_path=settings.moomoo_rsa_key_path)
        own_gateway = True
    else:
        own_gateway = False
    try:
        return next((p for p in gateway.positions() if p.code == code), None)
    except Exception as exc:
        print(f"Could not read moomoo positions ({type(exc).__name__}); analysing as not held.")
        return None
    finally:
        if own_gateway:
            gateway.close()  # the SDK's threads are non-daemon: an open context would keep the CLI alive


if __name__ == "__main__":
    _cli()
