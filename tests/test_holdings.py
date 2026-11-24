from datetime import datetime

import pytest

from stockagent.holdings import sync_holdings
from stockagent.lifecycle import apply_new_analysis
from stockagent.models import PlanFields, PlanState, Position
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 2, 0)


def buy():
    return PlanFields(action="BUY", entry_low=100, entry_high=105, tp=130, sl=90, confidence="medium",
                      holding_months=6, reasoning="r")


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


def pos(code="US.NVDA", qty=10):
    return Position(code=code, qty=qty, avg_cost=102)


def test_buy_links_open_plan(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    alerts = sync_holdings(store, [pos()], NOW)
    assert store.active_plan("US.NVDA").state == PlanState.HELD
    assert [a.kind for a in alerts] == ["info"] and store.pending_count() == 0


def test_full_sell_closes_plan_after_second_empty_read(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    sync_holdings(store, [pos()], NOW)
    assert sync_holdings(store, [], NOW) == []  # one empty read may be a glitch
    assert store.active_plan("US.NVDA").state == PlanState.HELD
    sync_holdings(store, [], NOW)
    assert store.active_plan("US.NVDA") is None


def test_empty_read_glitch_does_not_requeue_holdings(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    sync_holdings(store, [pos()], NOW)
    sync_holdings(store, [], NOW)
    assert sync_holdings(store, [pos()], NOW) == []
    assert store.active_plan("US.NVDA").state == PlanState.HELD and store.pending_count() == 0
    sync_holdings(store, [], NOW)  # the earlier empty read must not count towards this one
    assert store.active_plan("US.NVDA").state == PlanState.HELD


def test_selling_one_of_several_closes_immediately(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    sync_holdings(store, [pos(), pos("US.AMD")], NOW)
    sync_holdings(store, [pos("US.AMD")], NOW)
    assert store.active_plan("US.NVDA") is None
    assert store.plans_in({PlanState.CLOSED})[0].code == "US.NVDA"


def test_partial_sell_keeps_held(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    sync_holdings(store, [pos(qty=10)], NOW)
    alerts = sync_holdings(store, [pos(qty=4)], NOW)
    assert store.active_plan("US.NVDA").state == PlanState.HELD and alerts == []
    assert store.last_positions()[0].qty == 4


def test_untracked_holding_enqueued_priority_1_once(store):
    alerts = sync_holdings(store, [pos("US.AMD")], NOW)
    assert [a.kind for a in alerts] == ["info"]
    item = store.next_queue_item()
    assert item.code == "US.AMD" and item.priority == 1 and item.reason == "new_holding"
    assert sync_holdings(store, [pos("US.AMD")], NOW) == []  # not re-announced on the next sync


def test_hold_analysis_for_untracked_holding_creates_held_plan(store):
    hold = PlanFields(action="HOLD", tp=130, sl=90, confidence="medium", holding_months=6, reasoning="r")
    p = apply_new_analysis(store, "US.AMD", hold, "new_holding", NOW, held=True)
    assert p.id is not None and p.state == PlanState.HELD


def test_holding_bought_far_from_buy_zone_gets_fresh_plan(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)  # zone 100-105
    alerts = sync_holdings(store, [Position(code="US.NVDA", qty=10, avg_cost=358)], NOW)
    assert store.active_plan("US.NVDA") is None
    assert store.plans_in({PlanState.CLOSED})[0].code == "US.NVDA"
    assert store.pending_count() == 1 and len(alerts) == 1


def test_held_buy_plan_far_from_cost_is_replaced(store):
    # Repairs plans linked before the cost check existed.
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)
    plan = store.active_plan("US.NVDA")
    plan.state = PlanState.HELD
    store.update_plan(plan)
    store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=358)], NOW)
    sync_holdings(store, [Position(code="US.NVDA", qty=10, avg_cost=358)], NOW)
    assert store.active_plan("US.NVDA") is None and store.pending_count() == 1
    assert sync_holdings(store, [Position(code="US.NVDA", qty=10, avg_cost=358)], NOW) == []
    assert store.pending_count() == 1


def test_averaging_down_keeps_a_linked_plan(store):
    apply_new_analysis(store, "US.NVDA", buy(), "weekly", NOW)  # zone 100-105
    sync_holdings(store, [Position(code="US.NVDA", qty=10, avg_cost=102)], NOW)
    sync_holdings(store, [Position(code="US.NVDA", qty=30, avg_cost=80)], NOW)
    plan = store.active_plan("US.NVDA")
    assert plan.state == PlanState.HELD and plan.fields.action == "HOLD" and store.pending_count() == 0
