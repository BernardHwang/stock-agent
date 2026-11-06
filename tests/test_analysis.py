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
    assert len(sent) == 1 and "BUY US.NVDA" in sent[0]
    assert store.count_runs_on(NOW.date()) == 1


async def test_invalid_plan_not_saved_owner_told(store):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store, extract=lambda *a: buy(sl=101))
    await w.drain()
    assert store.active_plan("US.NVDA") is None
    assert len(sent) == 1 and "no valid plan" in sent[0]


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
    assert "no buy plan" in sent[0].lower()


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
    assert store.active_plan("US.NVDA") is None and "no valid plan" in sent[0]


async def test_failure_after_extraction_does_not_leave_item_running(store, monkeypatch):
    store.enqueue("US.NVDA", "weekly", 3, NOW)
    w, sent = make(store)
    monkeypatch.setattr(analysis, "apply_new_analysis", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db")))
    await w.drain()
    assert store.pending_count() == 0 and not any(i.status == "running" for i in store.pending_items())
    assert "failed" in sent[0]


@pytest.mark.parametrize("name,expected", [("google", "google_genai"), ("openai", "openai"),
                                           ("anthropic", "anthropic"), ("OpenAI", "openai")])
def test_langchain_provider_mapping(name, expected):
    assert analysis.langchain_provider(name) == expected


def test_extractor_uses_configured_provider(monkeypatch):
    import langchain.chat_models as cm

    captured = {}

    class FakeLLM:
        def with_structured_output(self, schema):
            return self

        def invoke(self, prompt):
            return buy()

    def fake_init(model, model_provider):
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
    at, text = analysis.load_report(store, "US.NVDA")
    assert text == "report for NVDA" and at.startswith("2026-11-06")
