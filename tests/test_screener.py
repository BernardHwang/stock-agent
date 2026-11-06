from stockagent.config import ScreenerRules
from stockagent.screener import Fundamentals, passes, screen

RULES = ScreenerRules()


def f(**kw):
    base = {"revenue_growth": 0.2, "earnings_growth": 0.2, "forward_pe": 30, "peg": 1.5, "price": 110,
            "sma50": 100, "sma200": 90, "high_52w": 115}
    return Fundamentals(**(base | kw))


def test_filters_by_growth():
    assert passes(f(), RULES)
    assert not passes(f(revenue_growth=0.05), RULES)
    assert not passes(f(earnings_growth=None), RULES)


def test_valuation_limits():
    assert not passes(f(forward_pe=80), RULES)
    assert not passes(f(peg=3.0), RULES)


def test_missing_peg_not_disqualifying():
    assert passes(f(peg=None), RULES)


def test_trend_or_pullback_passes():
    assert passes(f(price=95, sma50=100, sma200=90, high_52w=115), RULES)  # ~17% pullback, above 200d


def test_below_sma50_without_pullback_fails():
    assert not passes(f(price=95, sma50=100, sma200=90, high_52w=98), RULES)


def test_below_sma200_fails():
    assert not passes(f(price=85, sma200=90), RULES)


def test_rank_limit_exclude_and_markets():
    data = {f"US.T{i}": f(revenue_growth=0.1 + i / 100) for i in range(10)}
    data["HK.00700"] = f(revenue_growth=0.9)
    data["US.BAD"] = None
    uni = {"US": [*data.keys() - {"HK.00700"}], "HK": ["HK.00700"]}
    out = screen(uni, ["US"], RULES, fetch=data.get, limit=5, exclude={"US.T9"})
    assert out == ["US.T8", "US.T7", "US.T6", "US.T5", "US.T4"]
