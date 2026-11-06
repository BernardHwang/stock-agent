"""Conservative 'major news' watcher for held stocks. Prefers silence over noise."""

import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime

import yfinance as yf

from .store import Store
from .symbols import to_yf

log = logging.getLogger(__name__)

MAJOR_KEYWORDS = [
    "earnings", "guidance", "downgrade", "upgrade", "lawsuit", "sues", "sued", "SEC", "investigation", "probe",
    "acquire", "acquisition", "merger", "CEO", "CFO", "resigns", "steps down", "recall", "bankruptcy", "delist",
    "offering", "dilution", "misses", "beats", "fraud", "antitrust", "export ban", "sanction",
]
_MAJOR_RE = re.compile(r"\b(" + "|".join(re.escape(k) for k in MAJOR_KEYWORDS) + r")\b", re.IGNORECASE)

NewsItem = dict[str, str]
FetchFn = Callable[[str], list[NewsItem] | None]


def is_major(title: str) -> bool:
    return bool(_MAJOR_RE.search(title))


def _published(value: object) -> str | None:
    """Naive-UTC ISO timestamp from an ISO string or epoch seconds."""
    try:
        if isinstance(value, (int, float)):
            dt = datetime.fromtimestamp(value, UTC)
        elif isinstance(value, str) and value:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            return None
    except (ValueError, OverflowError, OSError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt.isoformat()


def parse_yf_news(raw: list[dict]) -> list[NewsItem]:
    out = []
    for r in raw:
        c = r.get("content") or {}
        news_id = r.get("id") or r.get("uuid") or c.get("id")
        title = c.get("title") or r.get("title")
        link = (c.get("canonicalUrl") or {}).get("url") or (c.get("clickThroughUrl") or {}).get("url") \
            or r.get("link") or ""
        if news_id and title:
            item = {"id": str(news_id), "title": str(title), "link": str(link)}
            published = _published(c.get("pubDate") or r.get("providerPublishTime"))
            if published:
                item["published"] = published
            out.append(item)
    return out


def yf_news(code: str) -> list[NewsItem]:
    return parse_yf_news(yf.Ticker(to_yf(code)).news or [])


def poll_news(store: Store, codes: list[str], fetch: FetchFn = yf_news) -> list[tuple[str, NewsItem]]:
    hits: list[tuple[str, NewsItem]] = []
    for code in codes:
        try:
            items = fetch(code) or []
        except Exception as exc:
            log.info("news fetch failed for %s: %s", code, exc)
            continue
        # The first poll of a stock only records what is already out there, so old headlines don't alert.
        first_poll = store.kv_get(f"news_init:{code}") is None
        for item in items:
            key = f"{code}:{item['id']}"
            if store.seen_news(key):
                continue
            store.mark_news(key)
            if not first_poll and is_major(item["title"]):
                hits.append((code, item))
        if first_poll:
            store.kv_set(f"news_init:{code}", "1")
    return hits
