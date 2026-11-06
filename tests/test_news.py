import pytest

from stockagent.news import is_major, parse_yf_news, poll_news
from stockagent.store import Store


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.init()
    return s


@pytest.mark.parametrize("title,major", [
    ("Nvidia cuts guidance for Q4", True),
    ("SEC opens investigation into accounting", True),
    ("AMD to acquire chip startup", True),
    ("5 stocks to watch this week", False),
    ("Why investors love AI", False),
])
def test_is_major(title, major):
    assert is_major(title) is major


def test_news_seen_not_repeated(store):
    items = {"US.NVDA": [{"id": "1", "title": "Nvidia misses earnings", "link": "u"},
                         {"id": "2", "title": "Top 10 tech picks", "link": "u"}]}
    first = poll_news(store, ["US.NVDA"], items.get)
    assert [(c, i["id"]) for c, i in first] == [("US.NVDA", "1")]
    assert poll_news(store, ["US.NVDA"], items.get) == []


def test_poll_survives_fetch_error(store):
    def boom(code):
        raise RuntimeError("x")
    assert poll_news(store, ["US.NVDA"], boom) == []


def test_parse_yf_news_both_shapes():
    raw = [{"id": "a", "content": {"title": "T1", "canonicalUrl": {"url": "http://x"}}},
           {"uuid": "b", "title": "T2", "link": "http://y"}]
    assert parse_yf_news(raw) == [{"id": "a", "title": "T1", "link": "http://x"},
                                  {"id": "b", "title": "T2", "link": "http://y"}]
