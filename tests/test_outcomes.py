from datetime import date, datetime, timedelta

import pandas as pd
import pytest

from stockagent.models import Plan, PlanFields, PlanState
from stockagent.outcomes import update_outcomes
from stockagent.store import Store

CREATED = datetime(2026, 1, 5, 2, 0)


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


def add_plan(store):
    f = PlanFields(action="BUY", entry_low=100, entry_high=100, tp=130, sl=90, confidence="medium",
                   holding_months=6, reasoning="r")
    return store.save_plan(Plan(code="US.NVDA", fields=f, state=PlanState.OPEN, created_at=CREATED,
                                source="weekly"))


def history(highs, lows, closes):
    idx = pd.date_range(CREATED.date(), periods=len(closes), freq="D")
    df = pd.DataFrame({"High": highs, "Low": lows, "Close": closes}, index=idx)
    return lambda code, start, end: df


def test_outcome_tp_first(store):
    pid = add_plan(store)
    n = 40
    update_outcomes(store, history([105] * 10 + [131] + [100] * (n - 11), [95] * n, [100] * n),
                    CREATED.date() + timedelta(days=n))
    assert store.outcome(pid)["first_hit"] == "TP"


def test_outcome_sl_first(store):
    pid = add_plan(store)
    n = 40
    update_outcomes(store, history([105] * n, [95] * 5 + [89] + [95] * (n - 6), [100] * n),
                    CREATED.date() + timedelta(days=n))
    assert store.outcome(pid)["first_hit"] == "SL"


def test_outcome_returns_at_4_weeks_only_when_due(store):
    pid = add_plan(store)
    n = 40
    closes = [100.0] * 28 + [110.0] * (n - 28)
    update_outcomes(store, history([105] * n, [95] * n, closes), CREATED.date() + timedelta(days=n))
    o = store.outcome(pid)
    assert o["ret_4w"] == pytest.approx(0.10) and o["ret_12w"] is None


def test_too_young_plan_skipped(store):
    pid = add_plan(store)
    update_outcomes(store, history([105], [95], [100]), date(2026, 1, 20))
    assert store.outcome(pid) is None
