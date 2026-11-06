from datetime import datetime
from types import SimpleNamespace

import pytest

from stockagent.bot import BotCommands, normalize_ticker
from stockagent.chat import ChatReply
from stockagent.messages import FOOTER
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
    def __init__(self, text=None, quoted=None):
        self.replies = []
        self.markups = []
        self.text = text
        self.reply_to_message = SimpleNamespace(text=quoted) if quoted else None

    async def reply_text(self, text, reply_markup=None, **kw):
        self.replies.append(text)
        self.markups.append(reply_markup)


def upd(chat=OWNER, user=OWNER, text=None, quoted=None):
    return SimpleNamespace(effective_chat=SimpleNamespace(id=chat), effective_user=SimpleNamespace(id=user),
                           message=Msg(text, quoted))


def cb_upd(data, user=OWNER):
    answered = []

    async def answer(*a, **kw):
        answered.append(True)

    q = SimpleNamespace(data=data, from_user=SimpleNamespace(id=user), message=Msg(), answer=answer)
    return SimpleNamespace(effective_chat=SimpleNamespace(id=OWNER), effective_user=SimpleNamespace(id=user),
                           callback_query=q, message=None)


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


class FakeChat:
    def __init__(self, reply=None):
        self.calls = []
        self.result = reply or ChatReply("Wait for 310-320.")

    async def reply(self, text, quoted=None):
        self.calls.append((text, quoted))
        return self.result


def cmds_with_chat(store, reply=None):
    chat = FakeChat(reply)
    queued = []

    async def queue_deep(code):
        queued.append(code)
        return 2

    c = BotCommands(OWNER, store, status_fn=lambda: {}, kick_queue=_kick, now=lambda: NOW, chat=chat,
                    queue_deep=queue_deep)
    return c, chat, queued


async def _kick():
    return None


def _save(store, code="US.MDB", text="## Final decision\nUnderweight: trim in stages.\n\n## Trader plan\nSell"):
    from stockagent.analysis import save_report
    save_report(store, code, text, NOW)


async def test_why_shows_saved_analysis(store):
    _save(store)
    u = upd()
    await cmds(store).why(u, ctx("MDB"))
    text = u.message.replies[0]
    assert "US.MDB" in text and "Underweight: trim in stages." in text and "2026-11-06" in text


async def test_why_without_analysis_suggests_plan(store):
    u = upd()
    await cmds(store).why(u, ctx("MDB"))
    assert "/plan MDB" in u.message.replies[0]


async def test_text_routes_to_chat_with_quote(store):
    c, chat, _ = cmds_with_chat(store)
    u = upd(text="why?", quoted="SL hit")
    await c.text(u, ctx())
    assert chat.calls == [("why?", "SL hit")]
    assert u.message.replies[-1].endswith(FOOTER) and "Wait for 310-320." in u.message.replies[-1]


async def test_text_from_other_user_in_owner_chat_ignored(store):
    c, chat, _ = cmds_with_chat(store)
    u = upd(text="hi", user=7)
    await c.text(u, ctx())
    assert chat.calls == [] and u.message.replies == []


async def test_reply_escaped_and_chunked(store):
    c, _, _ = cmds_with_chat(store, ChatReply("<b>" + "x" * 5000))
    u = upd(text="hi")
    await c.text(u, ctx())
    assert all(len(r) <= 4096 for r in u.message.replies)
    assert u.message.replies[0].startswith("&lt;b&gt;")


async def test_offer_adds_button(store):
    c, _, _ = cmds_with_chat(store, ChatReply("Wait.", ["US.MDB"]))
    u = upd(text="add MDB?")
    await c.text(u, ctx())
    markup = u.message.markups[-1]
    assert markup.inline_keyboard[0][0].callback_data == "deep:US.MDB"
    assert all(m is None for m in u.message.markups[:-1])


async def test_button_queues_deep(store):
    c, _, queued = cmds_with_chat(store)
    u = cb_upd("deep:US.MDB")
    await c.button(u, ctx())
    assert queued == ["US.MDB"] and "#2 in line" in u.callback_query.message.replies[-1]
    await c.button(cb_upd("deep:$$$"), ctx())
    await c.button(cb_upd("deep:US.MDB", user=7), ctx())
    assert queued == ["US.MDB"]


async def test_ask_uses_chat(store):
    c, chat, _ = cmds_with_chat(store)
    u = upd()
    await c.ask(u, ctx("MDB", "why", "not", "sell?"))
    assert chat.calls[0][0] == "About US.MDB: why not sell?"


async def test_ask_usage(store):
    c, chat, _ = cmds_with_chat(store)
    u = upd()
    await c.ask(u, ctx("MDB"))
    assert "Usage" in u.message.replies[0] and chat.calls == []


async def test_ask_ignored_for_non_owner(store):
    c, chat, _ = cmds_with_chat(store)
    await c.ask(upd(chat=999), ctx("MDB", "why?"))
    assert chat.calls == []


async def test_commands_registered_in_telegram_menu():
    from stockagent.bot import BOT_COMMANDS, register_commands

    names = [n for n, _ in BOT_COMMANDS]
    assert {"plan", "why", "ask", "plans", "holdings", "watch", "unwatch", "status", "help"} <= set(names)
    sent = {}

    class FakeBot:
        async def set_my_commands(self, commands):
            sent["cmds"] = [(c.command, c.description) for c in commands]

    await register_commands(SimpleNamespace(bot=FakeBot()))
    assert [n for n, _ in sent["cmds"]] == names
