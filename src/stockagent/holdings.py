from datetime import datetime

from .models import Alert, PlanState, Position
from .store import Store

PRIORITY_NEW_HOLDING = 1


def sync_holdings(store: Store, positions: list[Position], now: datetime) -> list[Alert]:
    """Reconcile plans with what the owner actually holds in moomoo (read-only snapshot)."""
    previous = {p.code for p in store.last_positions()}
    current = {p.code for p in positions}
    alerts: list[Alert] = []

    for code in sorted(current - previous):
        plan = store.active_plan(code)
        if plan is not None and plan.state in (PlanState.OPEN, PlanState.TRIGGERED):
            plan.state = PlanState.HELD
            store.update_plan(plan)
            alerts.append(Alert(code=code, kind="info", plan_id=plan.id,
                                text=f"Bought {code}. Now watching its take-profit and stop loss (plan #{plan.id})."))
        elif plan is None:
            store.enqueue(code, "new_holding", PRIORITY_NEW_HOLDING, now)
            alerts.append(Alert(code=code, kind="info",
                                text=f"Now tracking {code}. An analysis is queued to set its take-profit and "
                                     "stop loss."))

    for plan in store.plans_in({PlanState.HELD}):
        if plan.code not in current:
            plan.state = PlanState.CLOSED
            store.update_plan(plan)
            alerts.append(Alert(code=plan.code, kind="info", plan_id=plan.id,
                                text=f"{plan.code} no longer held. Plan #{plan.id} closed."))

    store.save_positions(positions, now)
    return alerts
