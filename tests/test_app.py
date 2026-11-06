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
    assert names == {"weekly_screen", "holdings_review", "drain_queue", "holdings_sync", "news_poll",
                     "expire_stale", "outcomes", "weekly_summary", "opend_health"}
    triggers = dict(app.jobs())
    assert "sun" in str(triggers["weekly_screen"]) and "hour='10'" in str(triggers["weekly_screen"])
    assert "mon" in str(triggers["holdings_review"]) and "hour='20'" in str(triggers["holdings_review"])


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
