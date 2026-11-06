import math

from stockagent.pricefeed import MoomooFeed, PollingFeed, make_feed


async def test_polling_feed_emits_last_price():
    ticks = []
    feed = PollingFeed(lambda c, p: ticks.append((c, p)), 60, fetch=lambda codes: {"US.NVDA": 101.0, "US.AMD": 55.5})
    feed.set_codes({"US.NVDA", "US.AMD"})
    await feed.poll_once()
    assert sorted(ticks) == [("US.AMD", 55.5), ("US.NVDA", 101.0)]


async def test_polling_feed_skips_missing_and_nan():
    ticks = []
    feed = PollingFeed(lambda c, p: ticks.append((c, p)), 60, fetch=lambda codes: {"US.NVDA": math.nan})
    feed.set_codes({"US.NVDA", "US.ZZZZ"})
    await feed.poll_once()
    assert ticks == []


async def test_polling_feed_survives_fetch_error():
    def boom(codes):
        raise RuntimeError("network")
    feed = PollingFeed(lambda c, p: None, 60, fetch=boom)
    feed.set_codes({"US.NVDA"})
    await feed.poll_once()  # no exception


async def test_no_codes_no_fetch():
    called = []
    feed = PollingFeed(lambda c, p: None, 60, fetch=lambda codes: called.append(codes) or {})
    await feed.poll_once()
    assert called == []


class FakeGw:
    def __init__(self):
        self.codes = None

    def subscribe(self, codes):
        self.codes = codes


def test_make_feed_selects_by_setting():
    gw = FakeGw()
    assert isinstance(make_feed("moomoo", gw, lambda c, p: None, 60), MoomooFeed)
    assert isinstance(make_feed("poll", gw, lambda c, p: None, 60), PollingFeed)


def test_moomoo_feed_subscribes():
    gw = FakeGw()
    MoomooFeed(gw).set_codes({"US.NVDA"})
    assert gw.codes == {"US.NVDA"}
