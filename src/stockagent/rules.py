from datetime import datetime

from .models import Alert, Level, Plan, PlanState
from .store import Store


class RuleEngine:
    """Turns price ticks into level alerts. Each level fires at most once per plan."""

    def __init__(self, store: Store):
        self.store = store

    def watched_codes(self) -> set[str]:
        return {p.code for p in self.store.active_plans()}

    def on_price(self, code: str, price: float, now: datetime) -> list[Alert]:
        plan = self.store.active_plan(code)
        if plan is None:
            return []
        alerts = self._held(plan, price) if plan.state == PlanState.HELD else self._pending(plan, price)
        if alerts:
            self.store.update_plan(plan)
        return alerts

    @staticmethod
    def _alert(plan: Plan, kind, price: float) -> Alert:
        return Alert(code=plan.code, kind=kind, plan_id=plan.id, price=price)

    def _pending(self, plan: Plan, price: float) -> list[Alert]:
        f = plan.fields
        if f.sl is not None and price <= f.sl:
            plan.state = PlanState.EXPIRED
            plan.fired.add(Level.SL)
            return [self._alert(plan, "expired", price)]
        if (plan.state == PlanState.OPEN and f.entry_low is not None and f.entry_high is not None
                and f.entry_low <= price <= f.entry_high and Level.ENTRY not in plan.fired):
            plan.state = PlanState.TRIGGERED
            plan.fired.add(Level.ENTRY)
            return [self._alert(plan, "entry", price)]
        return []

    def _held(self, plan: Plan, price: float) -> list[Alert]:
        f = plan.fields
        out: list[Alert] = []
        if f.sl is not None and price <= f.sl and Level.SL not in plan.fired:
            plan.fired.add(Level.SL)
            out.append(self._alert(plan, "sl", price))
        if f.partial_tp is not None and price >= f.partial_tp and Level.PARTIAL_TP not in plan.fired:
            plan.fired.add(Level.PARTIAL_TP)
            out.append(self._alert(plan, "partial_tp", price))
        if f.tp is not None and price >= f.tp and Level.TP not in plan.fired:
            plan.fired.add(Level.TP)
            out.append(self._alert(plan, "tp", price))
        return out
