"""Scores every plan after the fact, so the owner can judge whether the agent is worth paying for."""

import logging
from collections.abc import Callable
from datetime import date, timedelta

import pandas as pd
import yfinance as yf

from .models import Level, Plan
from .store import Store
from .symbols import to_yf

log = logging.getLogger(__name__)

HistoryFn = Callable[[str, date, date], pd.DataFrame]
WEEKS = (4, 12, 26)


def yf_history(code: str, start: date, end: date) -> pd.DataFrame:
    df = yf.Ticker(to_yf(code)).history(start=start, end=end + timedelta(days=1), auto_adjust=False)
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    return df


def _first_hit(plan: Plan, df: pd.DataFrame) -> Level | None:
    f = plan.fields
    for _, row in df.iterrows():
        if f.sl is not None and row["Low"] <= f.sl:
            return Level.SL  # same-day touch of both counts as the stop: the conservative reading
        if f.tp is not None and row["High"] >= f.tp:
            return Level.TP
    return None


def score(plan: Plan, df: pd.DataFrame, today: date) -> tuple[Level | None, list[float | None]]:
    start = plan.created_at.date()
    f = plan.fields
    ref = (f.entry_low + f.entry_high) / 2 if f.entry_low and f.entry_high else float(df["Close"].iloc[0])
    rets: list[float | None] = []
    for w in WEEKS:
        target = start + timedelta(weeks=w)
        later = df[df.index >= pd.Timestamp(target)]
        rets.append(float(later["Close"].iloc[0]) / ref - 1 if target <= today and not later.empty else None)
    return _first_hit(plan, df), rets


def update_outcomes(store: Store, history: HistoryFn = yf_history, today: date | None = None) -> int:
    today = today or date.today()
    updated = 0
    for plan in store.all_plans():
        if plan.id is None or plan.fields.tp is None or plan.fields.sl is None:
            continue
        start = plan.created_at.date()
        if today - start < timedelta(weeks=4):
            continue
        existing = store.outcome(plan.id)
        if existing and existing["ret_26w"] is not None:
            continue
        try:
            df = history(plan.code, start, today)
        except Exception as exc:
            log.info("history failed for %s: %s", plan.code, exc)
            continue
        if df is None or df.empty:
            continue
        hit, (r4, r12, r26) = score(plan, df, today)
        store.save_outcome(plan.id, hit, r4, r12, r26)
        updated += 1
    return updated
