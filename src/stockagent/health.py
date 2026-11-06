from .models import Alert


class Health:
    """Tracks open problems so each one alerts once when it starts and once when it clears."""

    def __init__(self) -> None:
        self._problems: dict[str, str] = {}

    def problem(self, key: str, text: str) -> Alert | None:
        if key in self._problems:
            self._problems[key] = text
            return None
        self._problems[key] = text
        return Alert(code="", kind="health", text=text)

    def resolved(self, key: str) -> Alert | None:
        if self._problems.pop(key, None) is None:
            return None
        return Alert(code="", kind="info", text=f"Recovered: {key}")

    def snapshot(self) -> list[str]:
        return [f"{k}: {v}" for k, v in sorted(self._problems.items())]
