from pathlib import Path

FORBIDDEN = [
    "unlock_trade", "place_order", "modify_order", "cancel_order", "cancel_all_order", "change_order",
]


def test_no_trade_write_calls_in_source():
    root = Path(__file__).resolve().parents[1]
    paths = list((root / "src").rglob("*.py")) + list((root / "scripts").rglob("*.py"))
    src = "\n".join(p.read_text(encoding="utf-8") for p in paths)
    for name in FORBIDDEN:
        assert name not in src, name
