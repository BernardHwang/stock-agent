from datetime import datetime
from types import SimpleNamespace

import pytest

from stockagent.bot import BotCommands, normalize_ticker
from stockagent.models import Position
from stockagent.store import Store

OWNER = 42
NOW = datetime(2026, 11, 6, 2, 0)


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


class Msg:
    def __init__(self):
        self.replies = []

    async def reply_text(self, text, **kw):
        self.replies.append(text)


def upd(chat=OWNER):
    return SimpleNamespace(effective_chat=SimpleNamespace(id=chat), message=Msg())


def ctx(*args):
    return SimpleNamespace(args=list(args))


def cmds(store, enqueued=None):
    async def kick():
        if enqueued is not None:
            enqueued.append(True)
    status = {"opend": "connected", "ai_runs_today": 1, "max_runs_per_day": 6, "queue": 0, "last_screen": None,
              "problems": []}
    return BotCommands(OWNER, store, status_fn=lambda: status, kick_queue=kick, now=lambda: NOW)


@pytest.mark.parametrize("arg,code", [
    ("NVDA", "US.NVDA"), ("nvda", "US.NVDA"), ("US.NVDA", "US.NVDA"), ("BRK.B", "US.BRK.B"),
    ("0700.HK", "HK.00700"), ("HK.00700", "HK.00700"), ("0166.KL", "MY.0166"), ("$$$", None), ("", None),
    ("A" * 20, None),
])
def test_normalize_ticker(arg, code):
    assert normalize_ticker(arg) == code


async def test_non_owner_ignored(store):
    u = upd(chat=999)
    await cmds(store).plan(u, ctx("NVDA"))
    assert u.message.replies == [] and store.pending_count() == 0


async def test_plan_command_enqueues_priority_1_and_kicks_queue(store):
    kicked = []
    u = upd()
    await cmds(store, kicked).plan(u, ctx("NVDA"))
    item = store.next_queue_item()
    assert item.code == "US.NVDA" and item.priority == 1 and kicked == [True]
    assert "Queued" in u.message.replies[0]


async def test_plan_without_arg_shows_usage(store):
    u = upd()
    await cmds(store).plan(u, ctx())
    assert "Usage" in u.message.replies[0]


async def test_bad_ticker_friendly_error(store):
    u = upd()
    await cmds(store).plan(u, ctx("$$$"))
    assert "ticker" in u.message.replies[0].lower() and store.pending_count() == 0


async def test_watch_unwatch_roundtrip(store):
    c = cmds(store)
    await c.watch(upd(), ctx("NVDA"))
    assert c.watchlist() == ["US.NVDA"]
    await c.unwatch(upd(), ctx("NVDA"))
    assert c.watchlist() == []


async def test_status_includes_opend_ai_quota_queue(store):
    u = upd()
    await cmds(store).status(u, ctx())
    text = u.message.replies[0]
    assert "OpenD" in text and "1/6" in text and "waiting" in text


async def test_holdings_lists_positions(store):
    store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=100)], NOW)
    u = upd()
    await cmds(store).holdings(u, ctx())
    assert "US.NVDA" in u.message.replies[0] and "no plan yet" in u.message.replies[0]
