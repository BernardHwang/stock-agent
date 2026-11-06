"""Weekly no-AI screen: narrow the tech universe to a handful of candidates for deep analysis."""

import logging
from collections.abc import Callable
from dataclasses import dataclass

import yfinance as yf

from .config import ScreenerRules
from .symbols import market_of, to_yf

log = logging.getLogger(__name__)


@dataclass
class Fundamentals:
    revenue_growth: float | None
    earnings_growth: float | None
    forward_pe: float | None
    peg: float | None
    price: float | None
    sma50: float | None
    sma200: float | None
    high_52w: float | None


def passes(f: Fundamentals, r: ScreenerRules) -> bool:
    if f.revenue_growth is None or f.revenue_growth < r.min_revenue_growth:
        return False
    if f.earnings_growth is None or f.earnings_growth < r.min_earnings_growth:
        return False
    if f.forward_pe is not None and (f.forward_pe <= 0 or f.forward_pe > r.max_forward_pe):
        return False
    if f.peg is not None and f.peg > r.max_peg:
        return False
    if f.price is None or f.sma200 is None or f.price <= f.sma200:
        return False
    uptrend = f.sma50 is not None and f.price > f.sma50
    pullback = False
    if f.high_52w:
        drop = 1 - f.price / f.high_52w
        pullback = r.pullback_min <= drop <= r.pullback_max
    return uptrend or pullback


def screen(universe: dict[str, list[str]], markets: list[str], rules: ScreenerRules,
           fetch: Callable[[str], Fundamentals | None], limit: int, exclude: set[str] | None = None) -> list[str]:
    exclude = exclude or set()
    scored: list[tuple[float, str]] = []
    for market in markets:
        for code in universe.get(market, []):
            if code in exclude or market_of(code) != market:
                continue
            try:
                f = fetch(code)
            except Exception as exc:
                log.info("screen fetch failed for %s: %s", code, exc)
                continue
            if f is not None and passes(f, rules):
                assert f.revenue_growth is not None and f.earnings_growth is not None
                scored.append((f.revenue_growth + f.earnings_growth, code))
    scored.sort(reverse=True)
    return [code for _, code in scored[:limit]]


def _num(info: dict, *keys: str) -> float | None:
    for k in keys:
        v = info.get(k)
        if isinstance(v, int | float):
            return float(v)
    return None


def yf_fetch(code: str) -> Fundamentals | None:
    info = yf.Ticker(to_yf(code)).info or {}
    if not info:
        return None
    return Fundamentals(
        revenue_growth=_num(info, "revenueGrowth"),
        earnings_growth=_num(info, "earningsGrowth", "earningsQuarterlyGrowth"),
        forward_pe=_num(info, "forwardPE"),
        peg=_num(info, "trailingPegRatio", "pegRatio"),
        price=_num(info, "currentPrice", "regularMarketPrice"),
        sma50=_num(info, "fiftyDayAverage"),
        sma200=_num(info, "twoHundredDayAverage"),
        high_52w=_num(info, "fiftyTwoWeekHigh"),
    )
