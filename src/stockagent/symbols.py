"""Mapping between moomoo codes (e.g. ``HK.00700``) and yfinance symbols (``0700.HK``)."""

import re

_SUFFIX = {"HK": ".HK", "MY": ".KL", "SG": ".SI", "JP": ".T"}
_SUFFIX_TO_MARKET = {v: k for k, v in _SUFFIX.items()}


def market_of(code: str) -> str:
    return code.split(".", 1)[0]


def to_yf(code: str) -> str:
    market, sym = code.split(".", 1)
    if market == "US":
        return sym.replace(".", "-")
    if market == "HK":
        return f"{int(sym):04d}.HK"
    if market in _SUFFIX:
        return f"{sym}{_SUFFIX[market]}"
    raise ValueError(f"unsupported market: {code}")


def from_yf(symbol: str) -> str:
    for suffix, market in _SUFFIX_TO_MARKET.items():
        if symbol.endswith(suffix):
            sym = symbol[: -len(suffix)]
            if market == "HK":
                return f"HK.{int(sym):05d}"
            return f"{market}.{sym}"
    return f"US.{symbol.replace('-', '.')}"


_CODE_RE = re.compile(r"^(US|HK|MY|SG|JP)\.[A-Z0-9.]{1,10}$")
_YF_RE = re.compile(r"^[A-Z0-9]{1,6}\.(HK|KL|SI|T)$")
_US_RE = re.compile(r"^[A-Z]{1,5}([.-][A-Z])?$")


def normalize_ticker(arg: str) -> str | None:
    """User input (NVDA, 0700.HK, HK.00700) -> moomoo code, or None if it doesn't look like a ticker."""
    a = arg.strip().upper()
    if _CODE_RE.match(a):
        if a.startswith("HK."):
            return f"HK.{int(a[3:]):05d}" if a[3:].isdigit() else None
        return a
    if _YF_RE.match(a):
        return from_yf(a)
    if _US_RE.match(a):
        return f"US.{a.replace('-', '.')}"
    return None
