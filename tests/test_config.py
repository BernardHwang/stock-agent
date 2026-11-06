from stockagent.config import Settings, load_screener_rules, load_universe


def _env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "secret-token-x")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")


def test_settings_defaults(monkeypatch):
    _env(monkeypatch)
    s = Settings(_env_file=None)
    assert s.max_candidates == 5
    assert s.tz == "Asia/Kuala_Lumpur"
    assert s.markets == ["US"]
    assert s.moomoo_security_firm == "FUTUMY"
    assert s.max_debate_rounds == 1 and s.max_runs_per_day == 6
    assert "secret-token-x" not in repr(s)


def test_markets_from_env(monkeypatch):
    _env(monkeypatch)
    monkeypatch.setenv("MARKETS", '["US","MY"]')
    assert Settings(_env_file=None).markets == ["US", "MY"]


def test_load_universe_and_rules():
    uni = load_universe("config/universe.yaml")
    assert "US.NVDA" in uni["US"] and len(uni["US"]) >= 100
    rules = load_screener_rules("config/screener.yaml")
    assert rules.min_revenue_growth == 0.10
