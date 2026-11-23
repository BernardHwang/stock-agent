from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    moomoo_host: str = "127.0.0.1"
    moomoo_port: int = 11111
    moomoo_security_firm: str = "FUTUMY"
    # OpenD's RSA private key; required when OpenD is not on 127.0.0.1 (e.g. the Docker setup), else positions fail
    moomoo_rsa_key_path: str | None = None
    markets: list[str] = ["US"]

    # Provider names follow TradingAgents: "google", "anthropic", "openai", "openrouter", "cloudflare", ...
    llm_provider: str = "google"
    deep_model: str = "gemini-3.8-flash"
    quick_model: str = "gemini-3.5-flash-lite"
    # Optional override for Telegram chat (defaults to deep_model on cloudflare, else quick_model)
    chat_model: str | None = None
    google_api_key: SecretStr | None = None
    cloudflare_account_id: str | None = None
    cloudflare_api_token: SecretStr | None = None
    openai_base_url: str | None = None

    @property
    def effective_chat_model(self) -> str:
        if self.chat_model:
            return self.chat_model
        if self.llm_provider.lower() == "cloudflare":
            return self.deep_model
        return self.quick_model

    telegram_bot_token: SecretStr
    telegram_chat_id: int

    db_path: str = "data/stockagent.db"
    universe_path: str = "config/universe.yaml"
    screener_path: str = "config/screener.yaml"

    max_debate_rounds: int = 1
    max_risk_discuss_rounds: int = 1
    max_candidates: int = 5
    max_runs_per_day: int = 6

    chat_max_per_day: int = 1000  # counts chat model calls, a safety cap against runaway loops
    chat_history: int = 20
    deep_stale_days: int = 7
    deep_move_pct: float = 0.08
    daily_move_pct: float = 0.05  # 1-day move on a held stock that triggers a plan re-review in the daily summary

    price_source: Literal["moomoo", "poll"] = "moomoo"
    poll_interval_s: int = 300
    tz: str = "Asia/Kuala_Lumpur"


class ScreenerRules(BaseModel):
    min_revenue_growth: float = 0.10
    min_earnings_growth: float = 0.10
    max_peg: float = 2.5
    max_forward_pe: float = 60
    pullback_min: float = 0.10
    pullback_max: float = 0.25


def load_universe(path: str | Path) -> dict[str, list[str]]:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    return {market: list(codes or []) for market, codes in data.items()}


def load_screener_rules(path: str | Path) -> ScreenerRules:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    return ScreenerRules(**data)
