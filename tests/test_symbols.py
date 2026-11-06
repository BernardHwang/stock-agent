import pytest

from stockagent.symbols import from_yf, market_of, to_yf


@pytest.mark.parametrize(
    "code,yf",
    [("US.NVDA", "NVDA"), ("US.BRK.B", "BRK-B"), ("HK.00700", "0700.HK"), ("HK.09988", "9988.HK"),
     ("MY.0166", "0166.KL")],
)
def test_roundtrip(code, yf):
    assert to_yf(code) == yf
    assert from_yf(yf) == code


def test_market_of():
    assert market_of("HK.00700") == "HK"
    assert market_of("US.NVDA") == "US"


def test_unknown_market_rejected():
    with pytest.raises(ValueError):
        to_yf("XX.ABC")
