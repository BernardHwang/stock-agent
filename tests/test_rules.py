from datetime import datetime

import pytest

from stockagent.models import Plan, PlanFields, PlanState
from stockagent.rules import RuleEngine
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 10, 0)


def fields(**kw):
    base = {"action": "BUY", "entry_low": 100, "entry_high": 105, "tp": 130, "sl": 90,
            "confidence": "medium", "holding_months": 6, "reasoning": "r"}
    return PlanFields(**(base | kw))


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


def add(store, state, **kw):
    p = Plan(code="US.NVDA", fields=fields(**kw), state=state, created_at=NOW, source="weekly")
    store.save_plan(p)
    return p


def feed(engine, prices):
    out = []
    for price in prices:
        out += engine.on_price("US.NVDA", price, NOW)
    return out


def test_entry_zone_fires_once(store):
    add(store, PlanState.OPEN)
    alerts = feed(RuleEngine(store), [110, 104, 103, 104.5])
    assert [a.kind for a in alerts] == ["entry"]
    assert store.active_plan("US.NVDA").state == PlanState.TRIGGERED


def test_flapping_sl_fires_once(store):
    add(store, PlanState.HELD)
    alerts = feed(RuleEngine(store), [91, 89.9, 90.5, 89])
    assert [a.kind for a in alerts] == ["sl"]


def test_gap_through_sl_fires(store):
    add(store, PlanState.HELD)
    alerts = feed(RuleEngine(store), [95, 70])
    assert [(a.kind, a.price) for a in alerts] == [("sl", 70)]


def test_tp_and_partial_tp_each_once(store):
    add(store, PlanState.HELD, partial_tp=118)
    alerts = feed(RuleEngine(store), [119, 131, 132])
    assert [a.kind for a in alerts] == ["partial_tp", "tp"]


def test_gap_through_partial_and_tp_fires_both(store):
    add(store, PlanState.HELD, partial_tp=118)
    assert [a.kind for a in feed(RuleEngine(store), [135])] == ["partial_tp", "tp"]


def test_sl_before_buy_expires(store):
    add(store, PlanState.OPEN)
    engine = RuleEngine(store)
    alerts = feed(engine, [89])
    assert [a.kind for a in alerts] == ["expired"]
    assert store.active_plan("US.NVDA") is None
    assert "US.NVDA" not in engine.watched_codes()


def test_unknown_code_no_alerts(store):
    assert RuleEngine(store).on_price("US.AMD", 1.0, NOW) == []


def test_held_exit_plan_without_levels_is_quiet(store):
    p = Plan(code="US.NVDA", fields=PlanFields(action="EXIT", confidence="high", holding_months=0, reasoning="r"),
             state=PlanState.HELD, created_at=NOW, source="review")
    store.save_plan(p)
    assert RuleEngine(store).on_price("US.NVDA", 50, NOW) == []
