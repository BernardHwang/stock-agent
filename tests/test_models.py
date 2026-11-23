import pytest

from stockagent.models import PlanFields, risk_reward, validate_against_price, validate_fields


def buy(**kw):
    base = {"action": "BUY", "entry_low": 100, "entry_high": 105, "tp": 130, "sl": 90,
            "confidence": "medium", "holding_months": 6, "reasoning": "r"}
    return PlanFields(**(base | kw))


def test_valid_buy():
    assert validate_fields(buy()) == []


def test_sl_above_entry_rejected():
    assert validate_fields(buy(sl=101))


def test_tp_below_entry_rejected():
    assert validate_fields(buy(tp=104))


def test_missing_levels_rejected():
    assert validate_fields(buy(tp=None))


def test_partial_tp_must_be_between():
    assert validate_fields(buy(partial_tp=140))
    assert validate_fields(buy(partial_tp=104))
    assert validate_fields(buy(partial_tp=118)) == []


def test_entry_low_le_high():
    assert validate_fields(buy(entry_low=110))


def test_non_positive_prices_rejected():
    assert validate_fields(buy(sl=0))


def test_hold_needs_sl_lt_tp():
    f = PlanFields(action="HOLD", tp=100, sl=120, confidence="low", holding_months=3, reasoning="r")
    assert validate_fields(f)


def test_exit_needs_no_levels():
    f = PlanFields(action="EXIT", confidence="high", holding_months=0, reasoning="r")
    assert validate_fields(f) == []


def test_risk_reward():
    assert risk_reward(buy()) == pytest.approx((130 - 102.5) / (102.5 - 90))


def test_risk_reward_none_for_exit():
    f = PlanFields(action="EXIT", confidence="high", holding_months=0, reasoning="r")
    assert risk_reward(f) is None


def test_reasoning_truncated():
    assert len(buy(reasoning="x" * 2000).reasoning) <= 600


def _buy(**kw):
    base = {"action": "BUY", "entry_low": 420, "entry_high": 450, "tp": 580, "sl": 380,
            "confidence": "high", "holding_months": 6, "reasoning": "r"}
    return PlanFields(**(base | kw))


def test_buy_zone_far_above_live_price_rejected():
    # Real case: MDB at ~316, model proposed buying 420-450 from stale memory.
    errors = validate_against_price(_buy(sl=300), 316.0)
    assert any("buy zone" in e for e in errors)


def test_buy_zone_far_below_live_price_rejected():
    errors = validate_against_price(_buy(entry_low=200, entry_high=220, sl=180, tp=380), 316.0)
    assert any("buy zone" in e for e in errors)


def test_buy_zone_near_live_price_accepted():
    assert validate_against_price(_buy(entry_low=295, entry_high=320, sl=270, tp=400), 316.0) == []


def test_buy_take_profit_at_or_below_live_price_rejected():
    errors = validate_against_price(_buy(entry_low=290, entry_high=300, sl=270, tp=310), 316.0)
    assert any("take-profit" in e for e in errors)


def test_trim_with_target_already_reached_accepted():
    # A held winner at 316 with target 300 reached: "TRIM now" is valid advice; the TP alert fires on the next tick.
    trim = PlanFields(action="TRIM", tp=300, sl=250, confidence="medium", holding_months=6, reasoning="r")
    assert validate_against_price(trim, 316.0) == []


def test_no_live_price_skips_checks():
    assert validate_against_price(_buy(), None) == []
