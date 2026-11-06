from datetime import datetime, timedelta

import pytest

from stockagent.lifecycle import apply_new_analysis, expire_stale
from stockagent.models import Level, Plan, PlanFields, PlanState
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 10, 0)


def buy(**kw):
    base = {"action": "BUY", "entry_low": 100, "entry_high": 105, "tp": 130, "sl": 90,
            "confidence": "medium", "holding_months": 6, "reasoning": "r"}
    return PlanFields(**(base | kw))


def hold(**kw):
    base = {"action": "HOLD", "tp": 130, "sl": 90, "confidence": "medium", "holding_months": 6, "reasoning": "r"}
    return PlanFields(**(base | kw))


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


def test_buy_without_plan_creates_open(store):
    p = apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    assert p.id is not None and p.state == PlanState.OPEN


def test_new_buy_replaces_open_plan(store):
    old = apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    new = apply_new_analysis(store, "US.NVDA", buy(tp=140), "weekly", NOW)
    assert store.get_plan(old.id).state == PlanState.EXPIRED
    assert store.active_plan("US.NVDA").id == new.id


def test_new_analysis_changed_levels_rearms(store):
    p = apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    p.state, p.fired = PlanState.HELD, {Level.SL}
    store.update_plan(p)
    updated = apply_new_analysis(store, "US.NVDA", hold(sl=95), "review", NOW)
    assert updated.id == p.id and updated.fired == set() and updated.fields.sl == 95


def test_new_analysis_same_levels_keeps_fired(store):
    p = apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    p.state, p.fired = PlanState.HELD, {Level.SL}
    store.update_plan(p)
    updated = apply_new_analysis(store, "US.NVDA", hold(), "review", NOW)
    assert updated.fired == {Level.SL}


def test_held_buy_signal_keeps_held_and_entry_levels(store):
    p = apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    p.state = PlanState.HELD
    store.update_plan(p)
    updated = apply_new_analysis(store, "US.NVDA", buy(tp=150), "review", NOW)
    assert updated.state == PlanState.HELD and updated.fields.tp == 150


def test_exit_without_holding_not_saved(store):
    p = apply_new_analysis(store, "US.NVDA", PlanFields(action="EXIT", confidence="high", holding_months=0,
                                                       reasoning="r"), "plan_cmd", NOW)
    assert p.id is None and store.active_plan("US.NVDA") is None


def test_expire_stale_60_days(store):
    old = Plan(code="US.A", fields=buy(), state=PlanState.OPEN, created_at=NOW - timedelta(days=61), source="w")
    fresh = Plan(code="US.B", fields=buy(), state=PlanState.TRIGGERED, created_at=NOW - timedelta(days=59),
                 source="w")
    held = Plan(code="US.C", fields=buy(), state=PlanState.HELD, created_at=NOW - timedelta(days=200), source="w")
    for p in (old, fresh, held):
        store.save_plan(p)
    expired = expire_stale(store, NOW)
    assert [p.code for p in expired] == ["US.A"]
    assert store.active_plan("US.B") and store.active_plan("US.C")
