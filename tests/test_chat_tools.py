import json
from datetime import datetime

import pytest

from stockagent.chat_tools import TOOL_NAMES, ChatDeps, ChatToolbox, similar_codes
from stockagent.config import Settings
from stockagent.models import Position
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 2, 0)


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


class Fakes:
    def __init__(self, prices=None, fail_prices=False):
        self.price_map = prices or {}
        self.fail_prices = fail_prices
        self.synced = 0
        self.queued: list[str] = []

    def prices(self, codes):
        if self.fail_prices:
            raise RuntimeError("OpenD down")
        return {c: self.price_map[c] for c in codes if c in self.price_map}

    def news(self, code):
        return [{"id": "1", "title": f"{code} beats earnings", "link": "", "published": "2026-11-05T00:00:00"}]

    def market(self):
        return {"SPY": -0.02, "QQQ": -0.03}

    async def sync(self):
        self.synced += 1

    async def queue(self, code):
        self.queued.append(code)
        return 1


def toolbox(store, fakes):
    s = Settings(_env_file=None, telegram_bot_token="t", telegram_chat_id=1)
    deps = ChatDeps(prices=fakes.prices, news=fakes.news, market=fakes.market, sync_positions=fakes.sync,
                    queue_deep=fakes.queue)
    return ChatToolbox(s, store, deps, now=lambda: NOW)


async def call(tb, name, **kw):
    return json.loads(await getattr(tb, name)(**kw))


async def test_portfolio_weights_stocks_only(store):
    store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=100),
                          Position(code="US.MDB", qty=5, avg_cost=300)], NOW)
    out = await call(toolbox(store, Fakes({"US.NVDA": 150.0})), "get_portfolio")
    by = {p["code"]: p for p in out["positions"]}
    assert by["US.NVDA"]["market_value"] == 1500 and by["US.NVDA"]["price_estimated"] is False
    assert by["US.MDB"]["market_value"] == 1500 and by["US.MDB"]["price_estimated"] is True
    assert by["US.NVDA"]["weight_pct"] == 50.0 and by["US.MDB"]["weight_pct"] == 50.0
    assert by["US.NVDA"]["pnl_pct"] == 50.0
    assert out["total_market_value"] == 3000


async def test_stock_context_flags_deep_when_never_analysed(store):
    out = await call(toolbox(store, Fakes({"US.MDB": 300.0})), "get_stock_context", ticker="MDB")
    assert out["code"] == "US.MDB" and out["price"] == 300.0
    assert out["deep_recommended"] is True and out["deep_reason"] == "never analysed"


async def test_lookalike_warning(store):
    store.save_positions([Position(code="US.SPCX", qty=1, avg_cost=10)], NOW)
    out = await call(toolbox(store, Fakes()), "get_stock_context", ticker="SPXC")
    assert out["lookalike"] == ["US.SPCX"]
    assert similar_codes("US.NVDA", ["US.NVDA"]) == []
    assert similar_codes("US.NVDA", ["US.NVDX", "US.AMD", "HK.NVDA"]) == ["US.NVDX"]


async def test_unknown_ticker_returns_error(store):
    tb = toolbox(store, Fakes())
    assert (await call(tb, "get_quotes", tickers=["$$$"]))["error"].startswith("unknown ticker")
    assert "error" in await call(tb, "get_stock_context", ticker="Nvidia")


async def test_notes_tools(store):
    tb = toolbox(store, Fakes())
    added = await call(tb, "add_note", text="I don't short")
    assert [n["text"] for n in (await call(tb, "list_notes"))["notes"]] == ["I don't short"]
    await call(tb, "forget_note", note_id=added["id"])
    assert (await call(tb, "list_notes"))["notes"] == []
    await call(tb, "restore_note", note_id=added["id"])
    assert len((await call(tb, "list_notes"))["notes"]) == 1
    await call(tb, "add_note", text="wait 310-320", ticker="MDB")
    assert [n["text"] for n in (await call(tb, "list_notes", ticker="MDB"))["notes"]] == ["wait 310-320"]


async def test_refresh_positions_syncs(store):
    f = Fakes()
    out = await call(toolbox(store, f), "refresh_positions")
    assert f.synced == 1 and out["positions"] == []


async def test_offer_and_queue(store):
    f = Fakes()
    tb = toolbox(store, f)
    await call(tb, "offer_deep_analysis", ticker="MDB")
    assert tb.offers == ["US.MDB"]
    out = await call(tb, "queue_deep_analysis", ticker="MDB")
    assert f.queued == ["US.MDB"] and out["queue_position"] == 1


async def test_dep_failure_becomes_error(store):
    out = await call(toolbox(store, Fakes(fail_prices=True)), "get_quotes", tickers=["NVDA"])
    assert "error" in out


async def test_news_and_market(store):
    tb = toolbox(store, Fakes())
    news = await call(tb, "get_news", ticker="NVDA")
    assert news["items"][0]["major"] is True
    assert (await call(tb, "get_market_overview"))["SPY"] == -0.02


def test_tool_names_are_methods():
    assert all(callable(getattr(ChatToolbox, n)) for n in TOOL_NAMES)
    assert "place_order" not in TOOL_NAMES


async def test_queue_reports_already_running(store):
    f = Fakes()

    async def running(code):
        return 0
    f.queue = running
    out = await call(toolbox(store, f), "queue_deep_analysis", ticker="MDB")
    assert out["already_running"] is True


async def test_watchlist_and_plans_tools(store):
    from stockagent.models import Plan, PlanFields, PlanState
    tb = toolbox(store, Fakes())
    assert (await call(tb, "get_watchlist"))["watchlist"] == []
    added = await call(tb, "add_to_watchlist", ticker="NVDA")
    assert added["watchlist"] == ["US.NVDA"]
    assert (await call(tb, "get_watchlist"))["watchlist"] == ["US.NVDA"]
    removed = await call(tb, "remove_from_watchlist", ticker="NVDA")
    assert removed["watchlist"] == []

    f = PlanFields(action="BUY", entry_low=100, entry_high=105, tp=130, sl=90, confidence="high",
                   holding_months=6, reasoning="AI growth")
    store.save_plan(Plan(code="US.NVDA", fields=f, state=PlanState.OPEN, created_at=NOW, source="chat"))
    plans = await call(tb, "list_active_plans")
    assert len(plans["plans"]) == 1 and plans["plans"][0]["code"] == "US.NVDA"


async def test_stock_context_includes_pnl_and_weight_for_holding(store):
    store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=100),
                          Position(code="US.MDB", qty=5, avg_cost=200)], NOW)
    out = await call(toolbox(store, Fakes({"US.NVDA": 125.0})), "get_stock_context", ticker="NVDA")
    assert out["held"]["pnl_pct"] == 25.0
    assert out["held"]["approx_weight_pct"] == 50.0


async def test_get_full_report_tool(store):
    from stockagent.analysis import save_report
    tb = toolbox(store, Fakes())
    empty = await call(tb, "get_full_report", ticker="NVDA")
    assert empty["report"] is None
    save_report(store, "US.NVDA", "## Final decision\nStrong buy on AI demand.", NOW, price=120.0)
    saved = await call(tb, "get_full_report", ticker="NVDA")
    assert "Strong buy on AI demand." in saved["report"] and saved["price_at_analysis"] == 120.0
