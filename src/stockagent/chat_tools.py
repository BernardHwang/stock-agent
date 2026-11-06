"""Tools the chat model can call. Read-only on the brokerage; writes only the agent's own memory notes."""

import asyncio
import functools
import json
import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .analysis import load_report, report_section
from .config import Settings
from .deep_rule import deep_reason
from .news import NewsItem, is_major
from .store import Store
from .symbols import market_of, normalize_ticker

log = logging.getLogger(__name__)

TOOL_NAMES: tuple[str, ...] = (
    "get_quotes", "get_portfolio", "refresh_positions", "get_stock_context", "get_news", "get_market_overview",
    "list_notes", "add_note", "forget_note", "restore_note", "queue_deep_analysis", "offer_deep_analysis",
)

SUMMARY_MAX = 3000


@dataclass
class ChatDeps:
    prices: Callable[[list[str]], dict[str, float]]  # blocking
    news: Callable[[str], list[NewsItem]]  # blocking
    market: Callable[[], dict[str, float]]  # blocking; index -> day change as a fraction
    sync_positions: Callable[[], Awaitable[None]]
    queue_deep: Callable[[str], Awaitable[int]]  # returns position in the queue


class BadTicker(ValueError):
    pass


def similar_codes(code: str, candidates: Iterable[str]) -> list[str]:
    """Codes in the same market whose symbol is an anagram of, or one letter off, this one (SPXC vs SPCX)."""
    market, sym = code.split(".", 1)
    out = []
    for c in dict.fromkeys(candidates):
        if c == code or market_of(c) != market:
            continue
        other = c.split(".", 1)[1]
        if len(other) != len(sym):
            continue
        if sorted(other) == sorted(sym) or sum(a != b for a, b in zip(other, sym, strict=True)) == 1:
            out.append(c)
    return out


def _tool(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[str]]:
    """Run a tool and return JSON; errors come back as {"error": ...} so the model can recover."""
    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> str:
        try:
            result = await fn(*args, **kwargs)
        except BadTicker as exc:
            result = {"error": str(exc)}
        except Exception as exc:
            log.warning("chat tool %s failed", fn.__name__, exc_info=True)
            result = {"error": f"{fn.__name__} failed ({type(exc).__name__})"}
        return json.dumps(result, default=str)
    return wrapper


class ChatToolbox:
    def __init__(self, settings: Settings, store: Store, deps: ChatDeps, now: Callable[[], datetime]):
        self.settings, self.store, self.deps, self.now = settings, store, deps, now
        self.offers: list[str] = []

    @staticmethod
    def _code(ticker: str) -> str:
        code = normalize_ticker(ticker or "")
        if code is None:
            raise BadTicker(f"unknown ticker {ticker}; try NVDA, 0700.HK or 0166.KL")
        return code

    async def _prices(self, codes: list[str]) -> dict[str, float]:
        return await asyncio.to_thread(self.deps.prices, codes) if codes else {}

    async def _prices_or_empty(self, codes: list[str]) -> dict[str, float]:
        try:
            return await self._prices(codes)
        except Exception:
            log.info("no prices for %s", codes)
            return {}

    def _known_codes(self) -> list[str]:
        watch = json.loads(self.store.kv_get("watchlist") or "[]")
        return ([p.code for p in self.store.last_positions()] + [p.code for p in self.store.active_plans()]
                + list(watch))

    @_tool
    async def get_quotes(self, tickers: list[str]) -> dict:
        codes = [self._code(t) for t in tickers]
        prices = await self._prices(codes)
        return {"prices": {c: prices.get(c) for c in codes}}

    @_tool
    async def get_portfolio(self) -> dict:
        positions = self.store.last_positions()
        prices = await self._prices_or_empty([p.code for p in positions])
        rows: list[dict[str, Any]] = []
        for p in positions:
            price = prices.get(p.code)
            rows.append({"code": p.code, "qty": p.qty, "avg_cost": p.avg_cost, "price": price,
                         "market_value": round(p.qty * (price if price is not None else p.avg_cost), 2),
                         "pnl_pct": round((price / p.avg_cost - 1) * 100, 1) if price and p.avg_cost else None,
                         "price_estimated": price is None})
        total: float = sum(r["market_value"] for r in rows)
        for r in rows:
            r["weight_pct"] = round(r["market_value"] / total * 100, 1) if total else None
        return {"positions": rows, "total_market_value": round(total, 2),
                "note": "weight_pct is of stock holdings only, cash excluded"}

    @_tool
    async def refresh_positions(self) -> dict:
        await self.deps.sync_positions()
        return json.loads(await self.get_portfolio())

    @_tool
    async def get_stock_context(self, ticker: str) -> dict:
        code = self._code(ticker)
        held = next((p for p in self.store.last_positions() if p.code == code), None)
        plan = self.store.active_plan(code)
        report = load_report(self.store, code)
        price = (await self._prices_or_empty([code])).get(code)
        try:
            news = await asyncio.to_thread(self.deps.news, code)
        except Exception:
            news = []
        reason = deep_reason(report, price, news, self.now(), self.settings.deep_stale_days,
                             self.settings.deep_move_pct)
        summary = (report_section(report.text, "Final decision") or report.text) if report else None
        return {
            "code": code,
            "held": held.model_dump() if held else None,
            "plan": ({"id": plan.id, "state": plan.state.value, "created_at": plan.created_at,
                      **plan.fields.model_dump(mode="json")} if plan else None),
            "analysis_at": report.at if report else None,
            "analysis_summary": summary[:SUMMARY_MAX] if summary else None,
            "price": price,
            "price_at_analysis": report.price if report else None,
            "deep_recommended": reason is not None,
            "deep_reason": reason,
            "notes": [{"id": n.id, "at": n.at, "text": n.text} for n in self.store.notes(code)],
            "lookalike": similar_codes(code, self._known_codes()),
        }

    @_tool
    async def get_news(self, ticker: str) -> dict:
        code = self._code(ticker)
        items = await asyncio.to_thread(self.deps.news, code)
        return {"code": code, "items": [{"title": i["title"], "published": i.get("published"),
                                         "major": is_major(i["title"])} for i in items[:10]]}

    @_tool
    async def get_market_overview(self) -> dict:
        return await asyncio.to_thread(self.deps.market)

    @_tool
    async def list_notes(self, ticker: str | None = None) -> dict:
        code = self._code(ticker) if ticker else None
        return {"ticker": code, "notes": [{"id": n.id, "at": n.at, "text": n.text} for n in self.store.notes(code)]}

    @_tool
    async def add_note(self, text: str, ticker: str | None = None) -> dict:
        code = self._code(ticker) if ticker else None
        return {"id": self.store.add_note(code, text.strip(), self.now()), "ticker": code, "saved": text.strip()}

    @_tool
    async def forget_note(self, note_id: int) -> dict:
        return {"ok": self.store.set_note_active(note_id, False)}

    @_tool
    async def restore_note(self, note_id: int) -> dict:
        return {"ok": self.store.set_note_active(note_id, True)}

    @_tool
    async def queue_deep_analysis(self, ticker: str) -> dict:
        code = self._code(ticker)
        position = await self.deps.queue_deep(code)
        return {"queued": code, "queue_position": position, "already_running": position == 0}

    @_tool
    async def offer_deep_analysis(self, ticker: str) -> dict:
        code = self._code(ticker)
        if code not in self.offers:
            self.offers.append(code)
        return {"offered": code}
