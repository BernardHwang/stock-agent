import asyncio
import json
from datetime import datetime

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from stockagent import chat
from stockagent.chat import ChatEngine
from stockagent.chat_tools import ChatDeps, ChatToolbox
from stockagent.config import Settings
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 2, 0)


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


class ScriptedLLM:
    def __init__(self, script):
        self.script = list(script)
        self.calls: list[list] = []

    async def ainvoke(self, messages):
        self.calls.append(list(messages))
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        if callable(step):
            return await step()
        return step


def tool_call(name, args=None, i=0):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args or {}, "id": f"c{i}"}])


async def _sync():
    return None


async def _queue(code):
    return 1


def engine(store, script, **settings_kw):
    s = Settings(_env_file=None, telegram_bot_token="t", telegram_chat_id=1, **settings_kw)
    deps = ChatDeps(prices=lambda codes: {c: 100.0 for c in codes}, news=lambda code: [], market=lambda: {},
                    sync_positions=_sync, queue_deep=_queue)
    tb = ChatToolbox(s, store, deps, now=lambda: NOW)
    llm = ScriptedLLM(script)
    return ChatEngine(s, store, tb, llm_factory=lambda tools: llm, now=lambda: NOW), llm


async def test_plain_answer_logged(store):
    eng, _ = engine(store, [AIMessage("Wait.")])
    reply = await eng.reply("good time to add MDB?")
    assert reply.text == "Wait." and reply.offer_deep == []
    assert [(m.role, m.text) for m in store.recent_messages(5)] == [("owner", "good time to add MDB?"),
                                                                     ("bot", "Wait.")]


async def test_tool_round_trip(store):
    eng, llm = engine(store, [tool_call("get_quotes", {"tickers": ["NVDA"]}), AIMessage("NVDA is 100.")])
    reply = await eng.reply("price of nvda?")
    assert reply.text == "NVDA is 100."
    tool_msgs = [m for m in llm.calls[1] if isinstance(m, ToolMessage)]
    assert "US.NVDA" in tool_msgs[0].content


async def test_history_and_alerts_included(store):
    store.log_message("alert", "TP hit on MDB", NOW)
    eng, llm = engine(store, [AIMessage("ok")])
    await eng.reply("why?")
    texts = [m.content for m in llm.calls[0]]
    assert "[Bot alert] TP hit on MDB" in texts
    assert texts.count("why?") == 1


async def test_quoted_reply_prefix(store):
    eng, llm = engine(store, [AIMessage("ok")])
    await eng.reply("why?", quoted="SL hit on NVDA")
    last = llm.calls[0][-1]
    assert isinstance(last, HumanMessage) and last.content.startswith("[Replying to: SL hit on NVDA]")


async def test_round_limit(store):
    eng, _ = engine(store, [tool_call("get_market_overview", i=i) for i in range(7)])
    reply = await eng.reply("loop")
    assert reply.text == chat.ROUND_LIMIT_TEXT
    assert store.chat_calls_on(NOW.date()) == 6


async def test_cap_reached(store):
    eng, llm = engine(store, [AIMessage("never")], chat_max_per_day=2)
    store.count_chat_call(NOW.date())
    store.count_chat_call(NOW.date())
    reply = await eng.reply("hi")
    assert reply.text == chat.CAP_TEXT and llm.calls == []


async def test_warning_at_90_percent(store):
    eng, _ = engine(store, [AIMessage("one"), AIMessage("two")], chat_max_per_day=10)
    for _ in range(8):
        store.count_chat_call(NOW.date())
    first = await eng.reply("a")
    second = await eng.reply("b")
    assert chat.WARN_TEXT in first.text and chat.WARN_TEXT not in second.text


async def test_timeout(store, monkeypatch):
    monkeypatch.setattr(chat, "TURN_TIMEOUT_S", 0.01)

    async def forever():
        await asyncio.sleep(10)

    eng, _ = engine(store, [forever])
    assert (await eng.reply("hi")).text == chat.TIMEOUT_TEXT


async def test_rate_limit(store):
    eng, _ = engine(store, [Exception("429 rate limit")])
    assert (await eng.reply("hi")).text == chat.QUOTA_TEXT


async def test_other_error(store):
    eng, _ = engine(store, [KeyError("x")])
    assert (await eng.reply("hi")).text == "Couldn't answer that (KeyError)."


async def test_offer_deep_returned(store):
    eng, _ = engine(store, [tool_call("offer_deep_analysis", {"ticker": "MDB"}), AIMessage("Wait.")])
    reply = await eng.reply("add MDB?")
    assert reply.offer_deep == ["US.MDB"]
    assert (await engine(store, [AIMessage("x")])[0].reply("again")).offer_deep == []


async def test_unknown_tool_name(store):
    eng, llm = engine(store, [tool_call("place_order", {"code": "US.NVDA"}), AIMessage("no")])
    await eng.reply("buy it")
    tool_msg = next(m for m in llm.calls[1] if isinstance(m, ToolMessage))
    assert "unknown tool" in tool_msg.content


async def test_bad_tool_args_become_error(store):
    eng, llm = engine(store, [tool_call("get_news", {"wrong": 1}), AIMessage("sorry")])
    await eng.reply("news?")
    tool_msg = next(m for m in llm.calls[1] if isinstance(m, ToolMessage))
    assert "error" in json.loads(tool_msg.content)


async def test_owner_notes_in_system_prompt(store):
    store.add_note(None, "I don't short", NOW)
    eng, llm = engine(store, [AIMessage("ok")])
    await eng.reply("hi")
    assert "I don't short" in llm.calls[0][0].content


async def test_follow_up(store):
    eng, llm = engine(store, [AIMessage("View unchanged: still wait.")])
    assert await eng.follow_up("US.MDB", "plan text") == "View unchanged: still wait."
    assert "plan text" in llm.calls[0][-1].content


async def test_follow_up_over_cap_returns_none(store):
    eng, llm = engine(store, [AIMessage("x")], chat_max_per_day=1)
    store.count_chat_call(NOW.date())
    assert await eng.follow_up("US.MDB", "plan") is None and llm.calls == []


async def test_history_never_starts_with_bot_turn(store):
    store.log_message("bot", "earlier answer", NOW)
    store.log_message("owner", "earlier question", NOW)
    eng, llm = engine(store, [AIMessage("ok")])
    await eng.reply("now")
    assert isinstance(llm.calls[0][1], HumanMessage)
