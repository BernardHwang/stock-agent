from datetime import datetime, timedelta

import pytest

from stockagent.models import Level, Plan, PlanFields, PlanState, Position
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


def plan(code="US.NVDA", state=PlanState.OPEN, **kw):
    return Plan(code=code, fields=fields(), state=state, created_at=NOW, source="weekly", **kw)


def test_save_and_get_plan_roundtrip(store):
    pid = store.save_plan(plan(fired={Level.ENTRY}))
    p = store.get_plan(pid)
    assert p.code == "US.NVDA" and p.fired == {Level.ENTRY} and p.fields.tp == 130


def test_active_plan_one_per_ticker(store):
    store.save_plan(plan())
    with pytest.raises(ValueError):
        store.save_plan(plan())


def test_update_plan_state(store):
    pid = store.save_plan(plan())
    p = store.get_plan(pid)
    p.state = PlanState.EXPIRED
    store.update_plan(p)
    assert store.active_plan("US.NVDA") is None
    store.save_plan(plan())  # allowed again once the old one is inactive


def test_queue_priority_order(store):
    store.enqueue("US.A", "weekly", 3, NOW)
    store.enqueue("US.B", "news", 0, NOW)
    store.enqueue("US.C", "plan_cmd", 1, NOW)
    order = [store.next_queue_item().code for _ in range(3)]
    assert order == ["US.B", "US.C", "US.A"]
    assert store.next_queue_item() is None


def test_enqueue_dedup(store):
    a = store.enqueue("US.A", "weekly", 3, NOW)
    b = store.enqueue("US.A", "weekly", 3, NOW)
    assert a == b and store.pending_count() == 1


def test_enqueue_raises_priority_of_pending(store):
    store.enqueue("US.A", "weekly", 3, NOW)
    store.enqueue("US.B", "weekly", 2, NOW)
    store.enqueue("US.A", "plan_cmd", 1, NOW)
    assert store.next_queue_item().code == "US.A"


def test_requeue_returns_to_pending(store):
    store.enqueue("US.A", "weekly", 3, NOW)
    item = store.next_queue_item()
    store.requeue(item.id)
    assert store.pending_count() == 1


def test_runs_today_counts_only_today(store):
    store.record_run("US.A", NOW - timedelta(days=1))
    store.record_run("US.B", NOW)
    assert store.count_runs_on(NOW.date()) == 1


def test_positions_snapshot(store):
    store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=100)], NOW)
    store.save_positions([Position(code="US.AMD", qty=5, avg_cost=50)], NOW + timedelta(minutes=15))
    assert [p.code for p in store.last_positions()] == ["US.AMD"]


def test_kv_and_news(store):
    assert store.kv_get("x") is None
    store.kv_set("x", "1")
    assert store.kv_get("x") == "1"
    assert not store.seen_news("n1")
    store.mark_news("n1")
    assert store.seen_news("n1")


def test_recent_messages_window(store):
    for i in range(25):
        store.log_message("owner", f"m{i}", NOW + timedelta(seconds=i))
    assert [m.text for m in store.recent_messages(20)] == [f"m{i}" for i in range(5, 25)]


def test_notes_by_code_and_owner(store):
    store.add_note("US.MDB", "wait 310-320", NOW)
    store.add_note(None, "I don't short", NOW)
    assert [n.text for n in store.notes("US.MDB")] == ["wait 310-320"]
    assert [n.text for n in store.notes(None)] == ["I don't short"]


def test_deactivate_and_restore_note(store):
    nid = store.add_note("US.MDB", "wait 310-320", NOW)
    assert store.set_note_active(nid, False) is True
    assert store.notes("US.MDB") == []
    assert len(store.notes("US.MDB", include_inactive=True)) == 1
    store.set_note_active(nid, True)
    assert len(store.notes("US.MDB")) == 1
    assert store.set_note_active(999, False) is False


def test_chat_call_counter_per_day(store):
    a, b = NOW.date(), (NOW + timedelta(days=1)).date()
    assert store.count_chat_call(a) == 1
    assert store.count_chat_call(a) == 2
    assert store.count_chat_call(b) == 1
    assert store.chat_calls_on(a) == 2
