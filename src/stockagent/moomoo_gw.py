"""Read-only adapter for moomoo OpenD.

Deliberately exposes only quotes and position queries. Nothing here can unlock trading or send orders.
"""

import logging
from collections.abc import Callable
from typing import Any

import moomoo
import pandas as pd

from .models import Position
from .symbols import market_of

log = logging.getLogger(__name__)

TickFn = Callable[[str, float], None]


class MoomooGateway:
    def __init__(self, host: str, port: int, security_firm: str, markets: list[str], on_tick: TickFn,
                 quote_factory: Callable[[], Any] | None = None,
                 trade_factory: Callable[[str], Any] | None = None):
        self.host, self.port, self.markets, self.on_tick = host, port, markets, on_tick
        self.security_firm = security_firm
        self._quote_factory = quote_factory or self._default_quote
        self._trade_factory = trade_factory or self._default_trade
        self._quote: Any = None
        self._subscribed: set[str] = set()
        self._healthy = True

    def _default_quote(self) -> Any:
        return moomoo.OpenQuoteContext(host=self.host, port=self.port)

    def _default_trade(self, market: str) -> Any:
        return moomoo.OpenSecTradeContext(filter_trdmarket=getattr(moomoo.TrdMarket, market), host=self.host,
                                          port=self.port, security_firm=getattr(moomoo.SecurityFirm,
                                                                                self.security_firm))

    def connect(self) -> None:
        self._quote = self._quote_factory()
        gw = self

        class _QuoteHandler(moomoo.StockQuoteHandlerBase):
            def on_recv_rsp(self, rsp_pb):
                ret, data = super().on_recv_rsp(rsp_pb)
                if ret == moomoo.RET_OK:
                    gw._forward_quotes(data)
                return ret, data

        self._quote.set_handler(_QuoteHandler())

    def close(self) -> None:
        if self._quote is not None:
            self._quote.close()

    def _forward_quotes(self, df: pd.DataFrame) -> None:
        for code, price in zip(df["code"], df["last_price"], strict=True):
            if pd.notna(price) and price > 0:
                self.on_tick(str(code), float(price))

    def subscribe(self, codes: set[str]) -> None:
        """Make the live subscription equal ``codes``. US tickers get 24h (pre/post/overnight) quotes."""
        codes = {c for c in codes if market_of(c) in self.markets}
        removed, added = self._subscribed - codes, codes - self._subscribed
        if removed:
            ret, err = self._quote.unsubscribe(sorted(removed), [moomoo.SubType.QUOTE])
            if ret != moomoo.RET_OK:  # moomoo refuses unsubscribing within a minute of subscribing
                log.info("unsubscribe deferred: %s", err)
            else:
                self._subscribed -= removed
        us = sorted(c for c in added if market_of(c) == "US")
        other = sorted(c for c in added if market_of(c) != "US")
        if us:
            self._sub(us, session=moomoo.Session.ALL)
        if other:
            self._sub(other)

    def _sub(self, codes: list[str], **kw: Any) -> None:
        ret, err = self._quote.subscribe(codes, [moomoo.SubType.QUOTE], **kw)
        if ret == moomoo.RET_OK:
            self._subscribed |= set(codes)
        else:
            log.warning("subscribe failed for %s: %s", codes, err)

    def snapshot(self, codes: list[str]) -> dict[str, float]:
        ret, df = self._quote.get_market_snapshot(codes)
        if ret != moomoo.RET_OK:
            raise RuntimeError(f"snapshot failed: {df}")
        return {str(c): float(p) for c, p in zip(df["code"], df["last_price"], strict=True) if pd.notna(p)}

    def positions(self) -> list[Position]:
        out: list[Position] = []
        for market in self.markets:
            ctx = self._trade_factory(market)
            try:
                ret, df = ctx.position_list_query(trd_env=moomoo.TrdEnv.REAL, refresh_cache=True)
            finally:
                ctx.close()
            if ret != moomoo.RET_OK:
                raise RuntimeError(f"position query failed for {market}: {df}")
            cost_col = "average_cost" if "average_cost" in df.columns else "cost_price"
            for code, qty, cost in zip(df["code"], df["qty"], df[cost_col], strict=True):
                if qty and float(qty) > 0:
                    out.append(Position(code=str(code), qty=float(qty), avg_cost=float(cost)))
        return out

    def health_check(self) -> str | None:
        """None when OpenD is connected and logged in, otherwise a short reason."""
        try:
            ret, state = self._quote.get_global_state()
        except Exception as exc:  # SDK raises on a dead socket
            reason: str | None = f"OpenD unreachable ({type(exc).__name__})"
        else:
            if ret != moomoo.RET_OK:
                reason = f"OpenD unreachable: {state}"
            elif not state.get("qot_logined"):
                reason = "OpenD not logged in. It may need SMS verification."
            else:
                reason = None
        if reason is None and not self._healthy:
            codes, self._subscribed = self._subscribed, set()
            self.subscribe(codes)
        self._healthy = reason is None
        return reason

    def permission_report(self, sample: dict[str, str]) -> dict[str, Any]:
        """Probe what this account can actually do. ``sample`` maps market -> one ticker code."""
        report: dict[str, Any] = {"login": self.health_check() or "ok", "markets": {}}
        for market, code in sample.items():
            row: dict[str, Any] = {}
            kw = {"session": moomoo.Session.ALL} if market == "US" else {}
            ret, err = self._quote.subscribe([code], [moomoo.SubType.QUOTE], **kw)
            row["live_subscribe"] = "ok" if ret == moomoo.RET_OK else f"no ({err})"
            ret, df = self._quote.get_market_snapshot([code])
            row["snapshot"] = f"ok, last {df['last_price'].iloc[0]}" if ret == moomoo.RET_OK else f"no ({df})"
            try:
                ctx = self._trade_factory(market)
                try:
                    ret, df = ctx.position_list_query(trd_env=moomoo.TrdEnv.REAL)
                finally:
                    ctx.close()
                row["positions_read"] = "ok" if ret == moomoo.RET_OK else f"no ({df})"
            except Exception as exc:
                row["positions_read"] = f"no ({type(exc).__name__}: {exc})"
            report["markets"][market] = row
        ret, quota = self._quote.query_subscription()
        report["subscription_quota"] = quota if ret == moomoo.RET_OK else f"unknown ({quota})"
        return report
