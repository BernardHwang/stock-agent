from datetime import datetime, timedelta

from stockagent.analysis import SavedReport
from stockagent.deep_rule import deep_reason

NOW = datetime(2026, 11, 6, 2, 0)


def report(days_ago: float, price: float | None = 100.0) -> SavedReport:
    return SavedReport(at=NOW - timedelta(days=days_ago), text="t", price=price)


def news(title: str, days_ago: float) -> dict[str, str]:
    return {"id": title, "title": title, "link": "", "published": (NOW - timedelta(days=days_ago)).isoformat()}


def test_never_analysed():
    assert deep_reason(None, 100, [], NOW, 7, 0.08) == "never analysed"


def test_stale():
    assert "8 days" in deep_reason(report(8), 100, [], NOW, 7, 0.08)


def test_moved():
    assert "9%" in deep_reason(report(2), 91, [], NOW, 7, 0.08)


def test_old_report_without_price_skips_move_rule():
    assert deep_reason(report(2, price=None), 50, [], NOW, 7, 0.08) is None


def test_major_news_after_report():
    assert "misses earnings" in deep_reason(report(2), 100, [news("MDB misses earnings", 1)], NOW, 7, 0.08)
    assert deep_reason(report(2), 100, [news("MDB misses earnings", 3)], NOW, 7, 0.08) is None


def test_fresh():
    assert deep_reason(report(1), 103, [], NOW, 7, 0.08) is None
