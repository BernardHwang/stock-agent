from datetime import datetime

from stockagent.messages import (
    FOOTER,
    format_invalid_plan,
    format_level_alert,
    format_plan,
    format_status,
    format_weekly_summary,
)
from stockagent.models import Alert, Plan, PlanFields, PlanState

NOW = datetime(2026, 11, 6, 2, 0)  # naive = UTC
TZ = "Asia/Kuala_Lumpur"


def plan(**kw):
    base = {"action": "BUY", "entry_low": 100, "entry_high": 105, "tp": 130, "sl": 90,
            "confidence": "medium", "holding_months": 6, "reasoning": "Strong AI demand"}
    return Plan(id=1, code="US.NVDA", fields=PlanFields(**(base | kw)), state=PlanState.OPEN, created_at=NOW,
                source="weekly")


def test_plan_contains_all_fields():
    text = format_plan(plan(), NOW, TZ)
    for part in ["US.NVDA", "BUY", "100.00", "105.00", "130.00", "90.00", "medium", "R/R 2.2", "~6 months",
                 "Strong AI demand", "2026-11-06 10:00 MYT"]:
        assert part in text, part
    assert text.endswith(FOOTER)


def test_footer_exact_copy():
    assert FOOTER == "ℹ️ Informational only, not financial advice. You decide and place every trade."


def test_level_alert_ends_with_footer():
    text = format_level_alert(Alert(code="US.NVDA", kind="sl", plan_id=1, price=89.5), plan(), NOW, TZ)
    assert "Stop loss" in text and "89.50" in text and text.endswith(FOOTER)


def test_html_escaped():
    text = format_plan(plan(reasoning="<b>x</b>"), NOW, TZ)
    assert "&lt;b&gt;x&lt;/b&gt;" in text


def test_invalid_plan_message():
    assert "no valid plan" in format_invalid_plan("US.NVDA", ["sl must be below the entry zone"])


def test_status_and_summary_render():
    assert "OpenD" in format_status({"opend": "connected", "ai_runs_today": 2, "max_runs_per_day": 6,
                                     "queue": 3, "last_screen": None, "problems": []})
    assert "No plans" in format_weekly_summary([])
