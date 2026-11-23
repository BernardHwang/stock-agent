import pandas as pd
import pytest

from stockagent.models import Position
from stockagent.moomoo_gw import MoomooGateway

RET_OK = 0


class FakeQuote:
    def __init__(self, logged_in=True):
        self.sub_calls, self.unsub_calls, self.handlers = [], [], []
        self.logged_in = logged_in

    def set_handler(self, h):
        self.handlers.append(h)

    def subscribe(self, codes, subtypes, **kw):
        self.sub_calls.append((sorted(codes), kw.get("session")))
        return RET_OK, None

    def unsubscribe(self, codes, subtypes, **kw):
        self.unsub_calls.append(sorted(codes))
        return RET_OK, None

    def get_market_snapshot(self, codes):
        return RET_OK, pd.DataFrame({"code": codes, "last_price": [1.5] * len(codes)})

    def get_global_state(self):
        return RET_OK, {"qot_logined": self.logged_in, "trd_logined": self.logged_in}

    def query_subscription(self, is_all_conn=True):
        return RET_OK, {"total_used": 2, "remain": 98}

    def close(self):
        pass


class FakeTrade:
    def __init__(self, market):
        self.market = market

    def position_list_query(self, **kw):
        assert kw["trd_env"] == "REAL"
        if self.market != "US":
            return RET_OK, pd.DataFrame(columns=["code", "qty", "average_cost"])
        return RET_OK, pd.DataFrame({"code": ["US.NVDA", "US.AMD"], "qty": [10.0, 0.0],
                                     "average_cost": [120.5, 50.0]})

    def close(self):
        pass


def gw(quote=None, markets=("US",)):
    q = quote or FakeQuote()
    g = MoomooGateway("127.0.0.1", 11111, "FUTUMY", list(markets), on_tick=lambda c, p: None,
                      quote_factory=lambda: q, trade_factory=FakeTrade)
    g.connect()
    return g, q


def test_subscribe_diffs():
    g, q = gw()
    g.subscribe({"US.A", "US.B"})
    g.subscribe({"US.B", "US.C"})
    assert q.unsub_calls == [["US.A"]]
    assert q.sub_calls[-1][0] == ["US.C"]


def test_us_subscriptions_use_24h_session():
    g, q = gw(markets=("US", "HK"))
    g.subscribe({"US.A", "HK.00700"})
    sessions = {tuple(codes): s for codes, s in q.sub_calls}
    assert sessions[("US.A",)] == "ALL"
    assert sessions[("HK.00700",)] is None


def test_positions_maps_dataframe_and_drops_zero_qty():
    g, _ = gw(markets=("US", "HK"))
    assert g.positions() == [Position(code="US.NVDA", qty=10, avg_cost=120.5)]


def test_health_check_reports_logged_out():
    g, _ = gw(quote=FakeQuote(logged_in=False))
    assert "not logged in" in g.health_check()


def test_health_check_ok_and_resubscribe_after_recovery():
    q = FakeQuote(logged_in=False)
    g, _ = gw(quote=q)
    g.subscribe({"US.A"})
    assert g.health_check() is not None
    q.logged_in = True
    assert g.health_check() is None
    assert q.sub_calls[-1][0] == ["US.A"]  # resubscribed once healthy again


def test_tick_handler_forwards_last_price():
    ticks = []
    q = FakeQuote()
    g = MoomooGateway("h", 1, "FUTUMY", ["US"], on_tick=lambda c, p: ticks.append((c, p)),
                      quote_factory=lambda: q, trade_factory=FakeTrade)
    g.connect()
    g._forward_quotes(pd.DataFrame({"code": ["US.NVDA"], "last_price": [101.25]}))
    assert ticks == [("US.NVDA", 101.25)]


def test_subscribe_returns_failed_codes():
    q = FakeQuote()
    q.subscribe = lambda codes, subtypes, **kw: (-1, "quota exceeded")
    g, _ = gw(quote=q)
    assert g.subscribe({"US.A"}) == {"US.A"}


def test_trade_contexts_reused_across_position_reads():
    made, closed = [], []

    class CountingTrade(FakeTrade):
        def __init__(self, market):
            super().__init__(market)
            made.append(market)

        def close(self):
            closed.append(self.market)

    g = MoomooGateway("h", 1, "FUTUMY", ["US", "HK"], on_tick=lambda c, p: None,
                      quote_factory=FakeQuote, trade_factory=CountingTrade)
    g.connect()
    g.positions()
    g.positions()
    assert made == ["US", "HK"] and closed == []  # no connect/disconnect churn on every sync
    g.close()
    assert sorted(closed) == ["HK", "US"]


def test_trade_context_replaced_after_failed_query():
    made, closed = [], []

    class FlakyTrade(FakeTrade):
        fail = True

        def __init__(self, market):
            super().__init__(market)
            made.append(market)

        def position_list_query(self, **kw):
            if FlakyTrade.fail:
                return -1, "disconnected"
            return super().position_list_query(**kw)

        def close(self):
            closed.append(self.market)

    g = MoomooGateway("h", 1, "FUTUMY", ["US"], on_tick=lambda c, p: None,
                      quote_factory=FakeQuote, trade_factory=FlakyTrade)
    g.connect()
    with pytest.raises(RuntimeError, match="disconnected"):
        g.positions()
    FlakyTrade.fail = False
    assert g.positions() == [Position(code="US.NVDA", qty=10, avg_cost=120.5)]
    assert made == ["US", "US"] and closed == ["US"]
