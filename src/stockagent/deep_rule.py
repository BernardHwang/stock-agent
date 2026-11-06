"""When a quick chat answer should offer a fresh deep analysis."""

from datetime import datetime

from .analysis import SavedReport
from .news import NewsItem, is_major


def deep_reason(report: SavedReport | None, price: float | None, news: list[NewsItem], now: datetime,
                stale_days: int, move_pct: float) -> str | None:
    """Short reason a deep analysis is recommended, or None if the latest one is still good enough."""
    if report is None:
        return "never analysed"
    age = (now - report.at).days
    if age > stale_days:
        return f"last full analysis {age} days ago"
    if price is not None and report.price:
        move = price / report.price - 1
        if abs(move) > move_pct:
            return f"price moved {move:+.0%} since the last analysis"
    for item in news:
        published = item.get("published")
        if published and is_major(item["title"]) and datetime.fromisoformat(published) > report.at:
            return f"major news since the last analysis: {item['title']}"
    return None
