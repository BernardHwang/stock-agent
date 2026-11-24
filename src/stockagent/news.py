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


def yf_company_name(code: str) -> str | None:
    info = yf.Ticker(to_yf(code)).info or {}
    return info.get("shortName") or info.get("longName")


_NAME_SUFFIX = re.compile(r"[,.]|\b(inc|corp|corporation|co|ltd|plc|holdings|group|class [a-z])\b", re.IGNORECASE)


def _company_words(store: Store, code: str, name_of: Callable[[str], str | None]) -> list[str] | None:
    """Ticker plus the company's short name, cached. None when the name is unknown (then nothing is filtered)."""
    key = f"company_name:{code}"
    name = store.kv_get(key)
    if not name:
        try:
            name = name_of(code)
        except Exception as exc:
            log.info("company name lookup failed for %s: %s", code, exc)
            return None
        if not name:
            return None
        store.kv_set(key, name)
    words = [code.split(".", 1)[-1]]
    short = " ".join(_NAME_SUFFIX.sub(" ", name).split())
    if short:
        words += [short, short.split()[0]]
    return words


def _mentions(title: str, words: list[str]) -> bool:
    # Prefix match: "Space Exploration Technologies" is "SpaceX" in headlines.
    return any(re.search(r"\b" + re.escape(w), title, re.IGNORECASE) for w in words)


def about_company(store: Store, code: str, title: str,
                  name_of: Callable[[str], str | None] = yf_company_name) -> bool:
    """Yahoo's feed for a ticker mixes in other companies' stories; keep the ones naming this company."""
    words = _company_words(store, code, name_of)
    return words is None or _mentions(title, words)


def poll_news(store: Store, codes: list[str], fetch: FetchFn = yf_news,
              name_of: Callable[[str], str | None] = yf_company_name) -> list[tuple[str, NewsItem]]:
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
            if first_poll or not is_major(item["title"]):
                continue
            if about_company(store, code, item["title"], name_of):
                hits.append((code, item))
        if first_poll:
            store.kv_set(f"news_init:{code}", "1")
    return hits
