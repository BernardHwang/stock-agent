from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, field_validator

REASONING_MAX = 600


class Action(StrEnum):
    BUY = "BUY"
    HOLD = "HOLD"
    TRIM = "TRIM"
    EXIT = "EXIT"


class PlanState(StrEnum):
    OPEN = "OPEN"
    TRIGGERED = "TRIGGERED"
    HELD = "HELD"
    EXPIRED = "EXPIRED"
    CLOSED = "CLOSED"


ACTIVE_STATES = {PlanState.OPEN, PlanState.TRIGGERED, PlanState.HELD}


class Level(StrEnum):
    ENTRY = "ENTRY"
    PARTIAL_TP = "PARTIAL_TP"
    TP = "TP"
    SL = "SL"


class PlanFields(BaseModel):
    """Structured trade plan produced by the extractor from a TradingAgents report."""

    action: Action
    entry_low: float | None = Field(None, description="Bottom of the buy zone (BUY only)")
    entry_high: float | None = Field(None, description="Top of the buy zone (BUY only)")
    partial_tp: float | None = Field(None, description="Optional first take-profit level")
    tp: float | None = Field(None, description="Final take-profit level")
    sl: float | None = Field(None, description="Stop-loss level")
    confidence: Literal["low", "medium", "high"]
    holding_months: int = Field(description="Expected holding period in months")
    reasoning: str = Field(description=f"Why, in at most {REASONING_MAX} characters")

    @field_validator("reasoning")
    @classmethod
    def _truncate(cls, v: str) -> str:
        return v if len(v) <= REASONING_MAX else v[: REASONING_MAX - 1] + "…"

    def levels(self) -> tuple[float | None, ...]:
        return (self.entry_low, self.entry_high, self.partial_tp, self.tp, self.sl)


def validate_fields(f: PlanFields) -> list[str]:
    errors: list[str] = []
    for name in ("entry_low", "entry_high", "partial_tp", "tp", "sl"):
        v = getattr(f, name)
        if v is not None and v <= 0:
            errors.append(f"{name} must be positive")
    if errors:
        return errors

    if f.action == Action.BUY:
        if None in (f.entry_low, f.entry_high, f.tp, f.sl):
            return ["BUY needs entry_low, entry_high, tp and sl"]
        assert f.entry_low is not None and f.entry_high is not None and f.tp is not None and f.sl is not None
        if not f.sl < f.entry_low:
            errors.append("sl must be below the entry zone")
        if not f.entry_low <= f.entry_high:
            errors.append("entry_low must not exceed entry_high")
        if not f.entry_high < f.tp:
            errors.append("tp must be above the entry zone")
        if f.partial_tp is not None and not f.entry_high < f.partial_tp < f.tp:
            errors.append("partial_tp must be between the entry zone and tp")
    elif f.action in (Action.HOLD, Action.TRIM):
        if f.tp is None or f.sl is None:
            return [f"{f.action} needs tp and sl"]
        if not f.sl < f.tp:
            errors.append("sl must be below tp")
        if f.partial_tp is not None and not f.sl < f.partial_tp < f.tp:
            errors.append("partial_tp must be between sl and tp")
    return errors


def validate_against_price(f: PlanFields, price: float | None) -> list[str]:
    """The report is based on the last close; reject levels the live price has already crossed."""
    if price is None or f.sl is None:
        return []
    if f.sl >= price:
        return [f"stop loss {f.sl:.2f} is at or above the current price {price:.2f}"]
    return []


def risk_reward(f: PlanFields) -> float | None:
    if f.action != Action.BUY or None in (f.entry_low, f.entry_high, f.tp, f.sl):
        return None
    assert f.entry_low is not None and f.entry_high is not None and f.tp is not None and f.sl is not None
    mid = (f.entry_low + f.entry_high) / 2
    risk = mid - f.sl
    return (f.tp - mid) / risk if risk > 0 else None


class Plan(BaseModel):
    id: int | None = None
    code: str
    fields: PlanFields
    state: PlanState
    created_at: datetime
    fired: set[Level] = Field(default_factory=set)
    source: str


class Position(BaseModel):
    code: str
    qty: float
    avg_cost: float


AlertKind = Literal["plan", "entry", "partial_tp", "tp", "sl", "news", "expired", "health", "info"]


class Alert(BaseModel):
    code: str
    kind: AlertKind
    plan_id: int | None = None
    price: float | None = None
    text: str = ""


class QueueItem(BaseModel):
    id: int
    code: str
    reason: str
    priority: int
    created_at: datetime
    status: Literal["pending", "running", "done", "failed"]
