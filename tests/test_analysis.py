from datetime import datetime

import pytest

from stockagent import analysis
from stockagent.analysis import AnalysisWorker, is_rate_limit
from stockagent.config import Settings
from stockagent.health import Health
from stockagent.models import PlanFields, PlanState, Position
from stockagent.store import Store

NOW = datetime(2026, 11, 6, 2, 0)


class RateLimited(Exception):
    pass


def settings(**kw):
    return Settings(_env_file=None, telegram_bot_token="t", telegram_chat_id=1, **kw)


def buy(**kw):
    base = {"action": "BUY", "entry_low": 100, "entry_high": 105, "tp": 130, "sl": 90,
            "confidence": "medium", "holding_months": 6, "reasoning": "r"}
    return PlanFields(**(base | kw))


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


def make(store, run=None, extract=None, **kw):
    sent: list[str] = []

    async def notify(text):
        sent.append(text)

    w = AnalysisWorker(settings(**kw), store, Health(), notify,
                       run=run or (lambda symbol, day, s: f"report for {symbol}"),
                       extract=extract or (lambda report, code, held, s: buy()),
                       now=lambda: NOW)
    return w, sent


async def test_valid_plan_saved_and_notified(store):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store)
    await w.drain()
    assert store.active_plan("US.NVDA").state == PlanState.OPEN
    assert len(sent) == 1 and "US.NVDA" in sent[0] and "BUY" in sent[0]
    assert store.count_runs_on(NOW.date()) == 1


async def test_invalid_plan_not_saved_owner_told(store):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store, extract=lambda *a: buy(sl=101))
    await w.drain()
    assert store.active_plan("US.NVDA") is None
    assert len(sent) == 1 and "inconsistent levels" in sent[0]


async def test_rate_limit_requeues_and_alerts_once(store):
    store.enqueue("US.A", "weekly", 3, NOW)
    store.enqueue("US.B", "weekly", 3, NOW)

    def run(*a):
        raise RateLimited("429 RESOURCE_EXHAUSTED quota exceeded")

    w, sent = make(store, run=run)
    await w.drain()
    await w.drain()
    assert store.pending_count() == 2
    assert len(sent) == 1 and "quota" in sent[0].lower()


async def test_daily_cap_respected(store):
    for code in ("US.A", "US.B", "US.C"):
        store.enqueue(code, "weekly", 3, NOW)
    w, _ = make(store, max_runs_per_day=2)
    await w.drain()
    assert store.pending_count() == 1


async def test_priority_order_processed(store):
    order = []
    store.enqueue("US.LOW", "weekly", 3, NOW)
    store.enqueue("US.HIGH", "news", 0, NOW)
    w, _ = make(store, run=lambda symbol, day, s: order.append(symbol) or "r")
    await w.drain()
    assert order == ["HIGH", "LOW"]


async def test_other_failure_marked_failed_and_reported(store):
    store.enqueue("US.A", "weekly", 3, NOW)

    def run(*a):
        raise ValueError("bad data")

    w, sent = make(store, run=run)
    await w.drain()
    assert store.pending_count() == 0 and "failed" in sent[0] and "ValueError" in sent[0]


async def test_held_position_passed_to_extractor(store):
    store.save_positions([Position(code="US.NVDA", qty=10, avg_cost=100)], NOW)
    store.enqueue("US.NVDA", "review", 2, NOW)
    seen = {}

    def extract(report, code, held, s):
        seen["held"] = held
        return buy()

    w, _ = make(store, extract=extract)
    await w.drain()
    assert seen["held"].qty == 10


async def test_no_buy_signal_still_reported(store):
    store.enqueue("US.NVDA", "plan_cmd", 1, NOW)
    exit_f = PlanFields(action="HOLD", tp=130, sl=90, confidence="low", holding_months=3, reasoning="wait")
    w, sent = make(store, extract=lambda *a: exit_f)
    await w.drain()
    assert store.active_plan("US.NVDA") is None
    assert "buy plan" in sent[0].lower()


def test_is_rate_limit():
    assert is_rate_limit(RateLimited("429 Too Many Requests"))
    assert is_rate_limit(RuntimeError("ResourceExhausted: quota"))
    assert not is_rate_limit(ValueError("bad"))


def test_config_passed_to_tradingagents(monkeypatch):
    captured = {}

    class FakeGraph:
        def __init__(self, selected_analysts, debug, config):
            captured.update(config)

        def propagate(self, symbol, day):
            return {"final_trade_decision": "BUY", "market_report": "support 100"}, "Buy"

    monkeypatch.setattr(analysis, "TradingAgentsGraph", FakeGraph)
    out = analysis.run_tradingagents("NVDA", "2026-11-06", settings(deep_model="d", quick_model="q"))
    assert captured["max_debate_rounds"] == 1 and captured["deep_think_llm"] == "d"
    assert captured["quick_think_llm"] == "q" and captured["llm_provider"] == "google"
    assert "BUY" in out and "support 100" in out


async def test_stop_above_current_price_rejected(store):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store)
    w.price_fn = lambda code: 85.0  # already below the proposed stop of 90
    await w.drain()
    assert store.active_plan("US.NVDA") is None and "inconsistent levels" in sent[0]


async def test_failure_after_extraction_does_not_leave_item_running(store, monkeypatch):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store)
    monkeypatch.setattr(analysis, "apply_new_analysis", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db")))
    await w.drain()
    assert store.pending_count() == 0 and not any(i.status == "running" for i in store.pending_items())
    assert "failed" in sent[0]


@pytest.mark.parametrize("name,expected", [("google", "google_genai"), ("openai", "openai"),
                                           ("anthropic", "anthropic"), ("OpenAI", "openai"),
                                           ("cloudflare", "openai")])
def test_langchain_provider_mapping(name, expected):
    assert analysis.langchain_provider(name) == expected


def test_cloudflare_llm_client_kwargs():
    s = settings(llm_provider="cloudflare", cloudflare_account_id="acc123", cloudflare_api_token="tok456",
                 deep_model="@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                 quick_model="@cf/meta/llama-3.1-8b-instruct-fast")
    kw = analysis.llm_client_kwargs(s)
    assert kw["base_url"] == "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1"
    assert kw["api_key"] == "tok456"
    assert s.effective_chat_model == "@cf/meta/llama-3.3-70b-instruct-fp8-fast"


def test_extract_plan_json_fallback(monkeypatch):
    import langchain.chat_models as cm
    from langchain_core.messages import AIMessage

    class FallbackLLM:
        def with_structured_output(self, schema):
            raise NotImplementedError("Cloudflare model does not support strict json_schema")

        def invoke(self, prompt):
            return AIMessage(
                '```json\n{"action":"BUY","entry_low":100,"entry_high":105,"tp":130,"sl":90,'
                '"confidence":"high","holding_months":6,"reasoning":"Strong setup"}\n```'
            )

    monkeypatch.setattr(cm, "init_chat_model", lambda *a, **kw: FallbackLLM())
    res = analysis.extract_plan("report", "US.NVDA", None, settings(llm_provider="cloudflare"))
    assert res.action == "BUY" and res.tp == 130 and res.confidence == "high"


def test_extractor_uses_configured_provider(monkeypatch):
    import langchain.chat_models as cm

    captured = {}

    class FakeLLM:
        def with_structured_output(self, schema):
            return self

        def invoke(self, prompt):
            return buy()

    def fake_init(model, model_provider, **kw):
        captured.update(model=model, provider=model_provider)
        return FakeLLM()

    monkeypatch.setattr(cm, "init_chat_model", fake_init)
    s = settings(llm_provider="openai", deep_model="gpt-6-sol", quick_model="gpt-6-luna")
    assert analysis.extract_plan("report", "US.NVDA", None, s).action == "BUY"
    assert captured == {"model": "gpt-6-sol", "provider": "openai"}


def test_openai_config_passed_to_tradingagents(monkeypatch):
    captured = {}

    class FakeGraph:
        def __init__(self, selected_analysts, debug, config):
            captured.update(config)

        def propagate(self, symbol, day):
            return {"final_trade_decision": "HOLD"}, "Hold"

    monkeypatch.setattr(analysis, "TradingAgentsGraph", FakeGraph)
    analysis.run_tradingagents("NVDA", "2026-11-06", settings(llm_provider="openai", deep_model="gpt-6-sol",
                                                              quick_model="gpt-6-luna"))
    assert captured["llm_provider"] == "openai" and captured["quick_think_llm"] == "gpt-6-luna"


class _PosGw:
    def __init__(self, positions=None, error=None):
        self._positions, self._error = positions or [], error

    def positions(self):
        if self._error:
            raise self._error
        return self._positions


def test_read_held_position_found():
    gw = _PosGw([Position(code="US.MDB", qty=3, avg_cost=350.0)])
    held = analysis.read_held_position("US.MDB", settings(), gateway=gw)
    assert held.qty == 3 and held.avg_cost == 350.0


def test_read_held_position_not_held_or_unavailable():
    assert analysis.read_held_position("US.MDB", settings(), gateway=_PosGw([])) is None
    assert analysis.read_held_position("US.MDB", settings(), gateway=_PosGw(error=ConnectionError())) is None


async def test_worker_saves_report_for_follow_up_questions(store):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, _ = make(store)
    await w.drain()
    saved = analysis.load_report(store, "US.NVDA")
    assert saved.text == "report for NVDA" and saved.at == NOW and saved.price is None


async def test_worker_saves_price_with_report(store):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, _ = make(store)
    w.price_fn = lambda code: 150.0
    await w.drain()
    assert analysis.load_report(store, "US.NVDA").price == 150.0


def test_report_roundtrip_with_price(store):
    analysis.save_report(store, "US.X", "t", NOW, price=123.4)
    assert analysis.load_report(store, "US.X").price == 123.4


def test_old_report_loads_without_price(store):
    import json
    store.kv_set("report:US.X", json.dumps({"at": "2026-11-01T00:00", "text": "t"}))
    saved = analysis.load_report(store, "US.X")
    assert saved.price is None and saved.text == "t"


async def test_worker_calls_on_result(store):
    store.enqueue("US.NVDA", "chat", 1, NOW)
    w, sent = make(store)
    calls = []

    async def on_result(code, reason, text):
        calls.append((code, reason, text))
    w.on_result = on_result
    await w.drain()
    assert calls == [("US.NVDA", "chat", sent[-1])]


def test_openai_payload_gives_tool_call_turns_content():
    # Cloudflare Workers AI answers HTTP 400 when an assistant tool-call message has null content;
    # TradingAgents' analysts send exactly that on their second round.
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from langchain_openai import ChatOpenAI

    analysis.patch_openai_tool_messages()
    llm = ChatOpenAI(model="m", api_key="k", base_url="http://localhost:1")
    msgs = [HumanMessage("q"), AIMessage("", tool_calls=[{"name": "t", "args": {}, "id": "c1"}]),
            ToolMessage("r", tool_call_id="c1")]
    assistant = llm._get_request_payload(msgs)["messages"][1]
    assert assistant["role"] == "assistant" and assistant["content"] and assistant["tool_calls"]
    analysis.patch_openai_tool_messages()  # idempotent
    assert llm._get_request_payload(msgs)["messages"][1]["content"] == assistant["content"]


async def test_report_kept_when_plan_extraction_fails(store):
    def bad_extract(report, code, held, s):
        raise ValueError("model returned junk")

    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store, extract=bad_extract)
    await w.drain()
    saved = analysis.load_report(store, "US.NVDA")
    assert saved is not None and saved.text == "report for NVDA"  # the expensive part is not thrown away
    assert "failed" in sent[-1] and store.pending_count() == 0


def test_openai_payload_splits_parallel_tool_calls():
    # Cloudflare Workers AI rejects (HTTP 400) an assistant message holding more than one tool call, and it
    # gives parallel calls the same id. TradingAgents' news analyst often calls several tools at once.
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from langchain_openai import ChatOpenAI

    analysis.patch_openai_tool_messages()
    llm = ChatOpenAI(model="m", api_key="k", base_url="http://localhost:1")
    calls = [{"name": "get_news", "args": {}, "id": "same"}, {"name": "get_global_news", "args": {}, "id": "same"}]
    msgs = [HumanMessage("q"), AIMessage("", tool_calls=calls),
            ToolMessage("news", tool_call_id="same"), ToolMessage("global", tool_call_id="same")]
    out = llm._get_request_payload(msgs)["messages"]
    assert [m["role"] for m in out] == ["user", "assistant", "tool", "assistant", "tool"]
    assert [m["tool_calls"][0]["function"]["name"] for m in out if m["role"] == "assistant"] == \
        ["get_news", "get_global_news"]
    ids = [m["tool_calls"][0]["id"] for m in out if m["role"] == "assistant"]
    assert len(set(ids)) == 2 and [m["tool_call_id"] for m in out if m["role"] == "tool"] == ids
    assert [m["content"] for m in out if m["role"] == "tool"] == ["news", "global"]
    assert all(m["content"] for m in out if m["role"] == "assistant")
