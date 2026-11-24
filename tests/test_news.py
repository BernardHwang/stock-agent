import pytest

from stockagent.news import is_major, parse_yf_news, poll_news
from stockagent.store import Store

NAME = {"US.NVDA": "NVIDIA Corporation", "US.MDB": "MongoDB, Inc."}.get


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
    store.kv_set("news_init:US.NVDA", "1")
    items = {"US.NVDA": [{"id": "1", "title": "Nvidia misses earnings", "link": "u"},
                         {"id": "2", "title": "Top 10 tech picks", "link": "u"}]}
    first = poll_news(store, ["US.NVDA"], items.get, NAME)
    assert [(c, i["id"]) for c, i in first] == [("US.NVDA", "1")]
    assert poll_news(store, ["US.NVDA"], items.get, NAME) == []


def test_poll_survives_fetch_error(store):
    def boom(code):
        raise RuntimeError("x")
    assert poll_news(store, ["US.NVDA"], boom, NAME) == []


def test_parse_yf_news_both_shapes():
    raw = [{"id": "a", "content": {"title": "T1", "canonicalUrl": {"url": "http://x"}}},
           {"uuid": "b", "title": "T2", "link": "http://y"}]
    assert parse_yf_news(raw) == [{"id": "a", "title": "T1", "link": "http://x"},
                                  {"id": "b", "title": "T2", "link": "http://y"}]


def test_first_poll_for_a_stock_only_marks_existing_headlines(store):
    items = {"US.NVDA": [{"id": "1", "title": "Nvidia misses earnings", "link": "u"}]}
    assert poll_news(store, ["US.NVDA"], items.get, NAME) == []
    items["US.NVDA"].append({"id": "2", "title": "Nvidia cuts guidance", "link": "u"})
    assert [i["id"] for _, i in poll_news(store, ["US.NVDA"], items.get, NAME)] == ["2"]


def test_parse_keeps_publish_time():
    raw = [{"id": "1", "content": {"title": "MDB misses earnings", "pubDate": "2026-11-05T10:00:00Z"}},
           {"id": "2", "title": "Old style", "providerPublishTime": 1793872800}]
    items = parse_yf_news(raw)
    assert items[0]["published"].startswith("2026-11-05T10:00")
    assert items[1]["published"].startswith("2026-")


def test_headline_must_name_the_company(store):
    store.kv_set("news_init:US.NVDA", "1")
    items = {"US.NVDA": [{"id": "1", "title": "Central Garden & Pet Q4 Earnings Call Highlights", "link": "u"},
                         {"id": "2", "title": "Jensen Huang back as Nvidia CEO", "link": "u"},
                         {"id": "3", "title": "NVDA beats estimates", "link": "u"}]}
    assert [i["id"] for _, i in poll_news(store, ["US.NVDA"], items.get, NAME)] == ["2", "3"]


def test_unknown_company_name_does_not_filter(store):
    store.kv_set("news_init:US.MDB", "1")
    items = {"US.MDB": [{"id": "1", "title": "Database maker misses earnings", "link": "u"}]}
    assert len(poll_news(store, ["US.MDB"], items.get, lambda c: None)) == 1


def test_name_prefix_matches_brand(store):
    store.kv_set("news_init:US.SPCX", "1")
    items = {"US.SPCX": [{"id": "1", "title": "SpaceX prices share offering", "link": "u"}]}
    assert len(poll_news(store, ["US.SPCX"], items.get, lambda c: "Space Exploration Technologies ")) == 1
