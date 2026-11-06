"""Mapping between moomoo codes (e.g. ``HK.00700``) and yfinance symbols (``0700.HK``)."""

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
