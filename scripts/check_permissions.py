"""Show what your moomoo account can do through the API (read-only).

Run with OpenD running and logged in:  uv run python scripts/check_permissions.py
"""

import json
import sys

from stockagent.config import Settings
from stockagent.moomoo_gw import MoomooGateway

SAMPLES = {"US": "US.NVDA", "HK": "HK.00700", "MY": "MY.0166"}


def main() -> int:
    # Only the MOOMOO_* settings matter here; Telegram values are placeholders so .env needn't be complete.
    s = Settings(telegram_bot_token="unused", telegram_chat_id=0)
    gw = MoomooGateway(s.moomoo_host, s.moomoo_port, s.moomoo_security_firm, list(SAMPLES),
                       on_tick=lambda c, p: None, rsa_key_path=s.moomoo_rsa_key_path)
    try:
        gw.connect()
        report = gw.permission_report(SAMPLES)
    except Exception as exc:
        print(f"Could not reach OpenD at {s.moomoo_host}:{s.moomoo_port}: {type(exc).__name__}: {exc}")
        return 1
    finally:
        gw.close()
    print(f"Login: {report['login']}")
    for market, row in report["markets"].items():
        print(f"\n[{market}]")
        for k, v in row.items():
            print(f"  {k:15} {v}")
    print("\nSubscription quota:", json.dumps(report["subscription_quota"], default=str))
    print("\nIf US live_subscribe is not ok, set PRICE_SOURCE=poll in .env.")
    print("Enable MY/HK in MARKETS only where snapshot and live_subscribe are ok.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
