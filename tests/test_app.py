import asyncio
import threading
from datetime import datetime

import pytest

from stockagent.app import App
from stockagent.config import Settings
from stockagent.models import Plan, PlanFields, PlanState, Position
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 2, 0)


class FakeGw:
    def __init__(self):
        self.codes = set()
        self.reason = None

    def subscribe(self, codes):
        self.codes = set(codes)

    def positions(self):
        return [Position(code="US.NVDA", qty=10, avg_cost=100)]

    def health_check(self):
        return self.reason


@pytest.fixture
def app(tmp_path):
    s = Settings(_env_file=None, telegram_bot_token="t", telegram_chat_id=1, db_path=str(tmp_path / "t.db"))
    store = Store(s.db_path)
    store.init()
    sent: list[str] = []

    async def sender(text):
        sent.append(text)

    a = App(s, store=store, gateway=FakeGw(), sender=sender, now=lambda: NOW)
    a.sent = sent
    a.worker.drain = _noop  # never start real AI analyses in tests
    return a


def held_plan(store):
    f = PlanFields(action="HOLD", tp=130, sl=90, confidence="medium", holding_months=6, reasoning="r")
    store.save_plan(Plan(code="US.NVDA", fields=f, state=PlanState.HELD, created_at=NOW, source="review"))


def test_job_schedule(app):
    names = {name for name, _ in app.jobs()}
    assert names == {"weekly_screen", "holdings_review", "daily_summary", "drain_queue", "holdings_sync",
                     "news_poll", "expire_stale", "outcomes", "weekly_summary", "opend_health"}
    triggers = dict(app.jobs())
    assert "sun" in str(triggers["weekly_screen"]) and "hour='10'" in str(triggers["weekly_screen"])
    assert "mon" in str(triggers["holdings_review"]) and "hour='20'" in str(triggers["holdings_review"])
    assert "tue-sat" in str(triggers["daily_summary"]) and "hour='8'" in str(triggers["daily_summary"])


async def test_job_exception_alerts_once_and_continues(app):
    async def boom():
        raise RuntimeError("x")

    await app.run_job("news_poll", boom)
    await app.run_job("news_poll", boom)
    assert len(app.sent) == 1 and "news_poll" in app.sent[0]


async def test_tick_bridge_calls_rule_engine_on_loop(app):
    held_plan(app.store)
    app.loop = asyncio.get_running_loop()
    t = threading.Thread(target=app.on_tick, args=("US.NVDA", 85.0))
    t.start()
    t.join()
    for _ in range(20):
        await asyncio.sleep(0.01)
        if app.sent:
            break
    assert any("Stop loss" in m for m in app.sent)


async def test_sl_alert_queues_priority_0_review(app):
    held_plan(app.store)
    await app._tick("US.NVDA", 85.0)
    item = app.store.next_queue_item()
    assert item.code == "US.NVDA" and item.priority == 0


async def test_opend_health_alerts_once_and_recovers(app):
    app.gateway.reason = "OpenD not logged in"
    await app.opend_health()
    await app.opend_health()
    await app.opend_health()
    app.gateway.reason = None
    await app.opend_health()
    assert len(app.sent) == 2 and "not logged in" in app.sent[0] and "Recovered" in app.sent[1]


async def test_holdings_sync_queues_untracked_and_watches(app):
    await app.holdings_sync()
    assert app.store.pending_count() == 1 and any("Now tracking" in m for m in app.sent)


async def test_holdings_review_queues_held(app):
    held_plan(app.store)
    await app.holdings_review()
    assert app.store.next_queue_item().priority == 2


async def _noop():
    return None


async def test_sl_review_queued_once_per_plan_per_day(app):
    held_plan(app.store)
    await app._tick("US.NVDA", 85.0)
    app.store.next_queue_item()  # taken by the worker
    plan = app.store.active_plan("US.NVDA")
    plan.fired = set()  # a new analysis re-armed the stop
    app.store.update_plan(plan)
    await app._tick("US.NVDA", 84.0)
    assert app.store.pending_count() == 0


async def test_holdings_review_queues_positions_without_plan(app):
    app.store.save_positions([Position(code="US.AMD", qty=5, avg_cost=50)], NOW)
    await app.holdings_review()
    item = app.store.next_queue_item()
    assert item.code == "US.AMD" and item.priority == 2


async def test_subscribe_failure_alerts_owner(app):
    held_plan(app.store)
    app.gateway.subscribe = lambda codes: set(codes)  # every code failed
    await app.refresh_watch()
    await app.refresh_watch()
    assert len(app.sent) == 1 and "US.NVDA" in app.sent[0]


async def test_news_review_once_per_stock_per_day(app, monkeypatch):
    held_plan(app.store)
    hits = [("US.NVDA", {"id": "1", "title": "Nvidia misses earnings", "link": ""})]
    monkeypatch.setattr("stockagent.app.poll_news", lambda store, codes: hits)
    await app.news_poll()
    app.store.next_queue_item()
    await app.news_poll()
    assert app.store.pending_count() == 0


async def test_tick_errors_reported(app, monkeypatch):
    def boom(*a):
        raise RuntimeError("db locked")
    monkeypatch.setattr(app.rules, "on_price", boom)
    await app._tick("US.NVDA", 85.0)
    assert any("price_alerts" in m for m in app.sent)


def test_chat_wired_into_commands(app):
    assert app.commands.chat is app.chat
    assert app.commands.queue_deep == app.queue_deep


async def test_notify_logs_alert(app):
    await app.notify("<b>TP</b> hit")
    last = app.store.recent_messages(5)[-1]
    assert last.role == "alert" and last.text == "TP hit"


async def test_chat_analysis_follow_up(app):
    async def follow_up(code, text):
        return "View unchanged."
    app.chat.follow_up = follow_up
    await app.on_analysis_result("US.MDB", "chat", "plan text")
    assert any("Update on US.MDB" in m and "View unchanged." in m for m in app.sent)
    before = len(app.sent)
    await app.on_analysis_result("US.MDB", "weekly", "plan text")
    assert len(app.sent) == before


async def test_queue_deep_uses_chat_reason(app):
    assert await app.queue_deep("US.MDB") == 1
    assert [(i.code, i.reason) for i in app.store.pending_items()] == [("US.MDB", "chat")]


async def test_follow_up_when_already_queued_via_plan(app):
    async def follow_up(code, text):
        return "View unchanged."
    app.chat.follow_up = follow_up
    app.store.enqueue("US.MDB", "plan_cmd", 1, NOW)
    await app.queue_deep("US.MDB")
    await app.on_analysis_result("US.MDB", "plan_cmd", "plan text")
    assert any("Update on US.MDB" in m for m in app.sent)
    before = len(app.sent)
    await app.on_analysis_result("US.MDB", "plan_cmd", "plan text")  # flag cleared after one follow-up
    assert len(app.sent) == before


async def test_queue_deep_while_running_does_not_duplicate(app):
    app.store.enqueue("US.MDB", "weekly", 3, NOW)
    app.store.next_queue_item()  # now running
    assert await app.queue_deep("US.MDB") == 0
    assert app.store.pending_items() == []


async def test_daily_summary_queues_big_mover_and_notifies(app, monkeypatch):
    held_plan(app.store)
    app.store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=100)], NOW)
    monkeypatch.setattr("stockagent.app.yf_index_moves", lambda: {"SPY": 0.01, "QQQ": 0.015})
    monkeypatch.setattr("stockagent.app.yf_day_moves", lambda codes: {"US.NVDA": -0.062})
    monkeypatch.setattr("stockagent.app.yf_news", lambda code: [])
    app.prices = lambda codes: {"US.NVDA": 110.0}

    async def fake_briefing(snapshot):
        assert snapshot["auto_queued_reviews"] == ["US.NVDA"]
        return "NVDA dropped 6.2% today; queued a fresh plan review."

    app.chat.daily_briefing = fake_briefing
    await app.daily_summary()
    assert any("NVDA dropped 6.2%" in m for m in app.sent)
    item = app.store.next_queue_item()
    assert item.code == "US.NVDA" and item.reason == "daily_move" and item.priority == 0


async def test_holdings_sync_failure_shows_moomoo_reason(app):
    def fail():
        raise RuntimeError("position query failed for US: Unlock or verify the device first")

    app.gateway.positions = fail
    await app.holdings_sync()
    assert "verify the device first" in app.sent[-1]


async def test_opend_single_blip_is_silent(app):
    app.gateway.reason = "OpenD unreachable: invalid connid"
    await app.opend_health()
    app.gateway.reason = None
    await app.opend_health()
    assert app.sent == []


async def test_news_alerts_capped_per_stock_per_day(app, monkeypatch):
    held_plan(app.store)
    hits = [("US.NVDA", {"id": str(i), "title": f"Nvidia CEO news {i}", "link": ""}) for i in range(5)]
    monkeypatch.setattr("stockagent.app.poll_news", lambda store, codes: hits)
    await app.news_poll()
    assert len(app.sent) == 3
