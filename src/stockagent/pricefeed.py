import asyncio
import contextlib
import logging
import math
from collections.abc import Callable
from typing import Any, Protocol

import pandas as pd
import yfinance as yf

from .symbols import from_yf, to_yf

log = logging.getLogger(__name__)

TickFn = Callable[[str, float], None]
FetchFn = Callable[[list[str]], dict[str, float]]


class PriceFeed(Protocol):
    def set_codes(self, codes: set[str]) -> None: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...


class MoomooFeed:
    """Live push quotes through OpenD; ticks arrive via the gateway's on_tick."""

    def __init__(self, gateway: Any):
        self.gateway = gateway

    def set_codes(self, codes: set[str]) -> None:
        self.gateway.subscribe(codes)

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass


def yf_last_prices(codes: list[str]) -> dict[str, float]:
    """Latest 1-minute price per code, including pre/post-market."""
    symbols = [to_yf(c) for c in codes]
    df = yf.download(symbols, period="1d", interval="1m", prepost=True, progress=False, group_by="ticker",
                     auto_adjust=False, threads=True)
    out: dict[str, float] = {}
    if df is None or df.empty:
        return out
    for sym in symbols:
        try:
            series = df[sym]["Close"] if isinstance(df.columns, pd.MultiIndex) else df["Close"]
        except KeyError:
            continue
        series = series.dropna()
        if not series.empty:
            out[from_yf(sym)] = float(series.iloc[-1])
    return out


class PollingFeed:
    """Fallback when the API has no live quotes: poll yfinance every ``interval_s`` seconds."""

    def __init__(self, on_tick: TickFn, interval_s: int, fetch: FetchFn = yf_last_prices):
        self.on_tick, self.interval_s, self.fetch = on_tick, interval_s, fetch
        self.codes: set[str] = set()
        self._task: asyncio.Task | None = None

    def set_codes(self, codes: set[str]) -> None:
        self.codes = set(codes)

    async def poll_once(self) -> None:
        if not self.codes:
            return
        try:
            prices = await asyncio.to_thread(self.fetch, sorted(self.codes))
        except Exception as exc:
            log.warning("price poll failed: %s", exc)
            return
        for code, price in prices.items():
            if code in self.codes and price and not math.isnan(price):
                self.on_tick(code, price)

    async def _loop(self) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(self.interval_s)

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task


def make_feed(price_source: str, gateway: Any, on_tick: TickFn, interval_s: int) -> PriceFeed:
    if price_source == "moomoo":
        return MoomooFeed(gateway)
    return PollingFeed(on_tick, interval_s)
