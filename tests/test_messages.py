from datetime import datetime

from stockagent.messages import (
    FOOTER,
    format_daily_summary,
    format_invalid_plan,
    format_level_alert,
    format_plan,
    format_status,
    format_weekly_summary,
    render_telegram_html,
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
    for part in ["US.NVDA", "BUY", "100.00", "105.00", "130.00", "90.00", "medium", "R/R 2.2", "~6mo horizon",
                 "Strong AI demand", "2026-11-06 10:00 MYT"]:
        assert part in text, part
    assert "Informational only" not in text


def test_footer_is_empty():
    assert FOOTER == ""


def test_level_alert_includes_advisor_guidance_and_no_footer():
    text = format_level_alert(Alert(code="US.NVDA", kind="sl", plan_id=1, price=89.5), plan(), NOW, TZ)
    assert "Stop loss" in text and "89.50" in text and "Support gave way" in text
    assert "Informational only" not in text


def test_html_escaped():
    text = format_plan(plan(reasoning="<script>x</script>"), NOW, TZ)
    assert "&lt;script&gt;x&lt;/script&gt;" in text
    assert "<b>bold</b> and <code>120.00</code>" == render_telegram_html("<b>bold</b> and `120.00`")
    assert "<b>markdown</b>" == render_telegram_html("**markdown**")


def test_invalid_plan_message():
    assert "inconsistent levels" in format_invalid_plan("US.NVDA", ["sl must be below the entry zone"])


def test_status_and_summary_render():
    assert "OpenD" in format_status({"opend": "connected", "ai_runs_today": 2, "max_runs_per_day": 6,
                                     "queue": 3, "last_screen": None, "problems": []})
    assert "No past plans" in format_weekly_summary([])
    snap = {"indices": {"SPY": 0.012}, "holdings": [{"code": "US.NVDA", "price": 120.0, "day_move_pct": -5.5,
            "pnl_pct": 20.0, "tp": 140.0, "sl": 100.0}], "auto_queued_reviews": ["US.NVDA"]}
    fallback = format_daily_summary(snap, None)
    assert "US.NVDA" in fallback and "-5.5%" in fallback and "Auto-queued" in fallback
    with_ai = format_daily_summary(snap, "Good morning, <b>NVDA</b> pulled back <code>5.5%</code>.")
    assert "Good morning, <b>NVDA</b> pulled back <code>5.5%</code>." in with_ai


def test_chunk_text_respects_telegram_limit():
    from stockagent.messages import chunk_text
    text = "\n".join(f"line {i} " + "x" * 50 for i in range(300))
    chunks = chunk_text(text)
    assert len(chunks) > 1 and all(len(c) <= 4000 for c in chunks)
    assert "\n".join(chunks) == text
