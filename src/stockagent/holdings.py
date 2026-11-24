from datetime import datetime

from .models import Action, Alert, Plan, PlanState, Position
from .store import Store

PRIORITY_NEW_HOLDING = 1
EMPTY_READ_KEY = "positions_empty_read"
COST_MATCH_TOLERANCE = 0.15  # a position bought further from the plan's buy zone wasn't bought on that plan


def _bought_elsewhere(plan: Plan, avg_cost: float) -> bool:
    f = plan.fields
    if plan.state == PlanState.TRIGGERED or f.action != Action.BUY or f.entry_low is None or f.entry_high is None:
        return False
    return not f.entry_low * (1 - COST_MATCH_TOLERANCE) <= avg_cost <= f.entry_high * (1 + COST_MATCH_TOLERANCE)


def sync_holdings(store: Store, positions: list[Position], now: datetime) -> list[Alert]:
    """Reconcile plans with what the owner actually holds in moomoo (read-only snapshot)."""
    previous = {p.code for p in store.last_positions()}
    current = {p.code for p in positions}
    alerts: list[Alert] = []

    # OpenD can briefly report no positions (restart, re-login). Trust "everything sold" only on a second read,
    # otherwise every held plan would close and be re-analysed as a new holding on the next good read.
    if not current and previous and not store.kv_get(EMPTY_READ_KEY):
        store.kv_set(EMPTY_READ_KEY, "1")
        return alerts
    if store.kv_get(EMPTY_READ_KEY):
        store.kv_set(EMPTY_READ_KEY, "")

    costs = {p.code: p.avg_cost for p in positions}
    # A BUY plan's targets mean nothing for shares bought at a very different price (e.g. the first good read of
    # an existing portfolio): retire it and analyse the holding as it is.
    for plan in store.plans_in({PlanState.OPEN, PlanState.HELD}):
        if plan.code in costs and _bought_elsewhere(plan, costs[plan.code]):
            plan.state = PlanState.CLOSED
            store.update_plan(plan)
            store.enqueue(plan.code, "new_holding", PRIORITY_NEW_HOLDING, now)
            alerts.append(Alert(code=plan.code, kind="info", plan_id=plan.id,
                                text=f"Your {plan.code} cost ({costs[plan.code]:.2f}) is far from plan #{plan.id}'s "
                                     "buy zone, so I've retired that plan and queued a fresh analysis of the "
                                     "position."))

    for code in sorted(current - previous):
        plan = store.active_plan(code)
        if plan is None and any(a.code == code for a in alerts):
            continue
        if plan is not None and plan.state in (PlanState.OPEN, PlanState.TRIGGERED):
            plan.state = PlanState.HELD
            store.update_plan(plan)
            alerts.append(Alert(code=code, kind="info", plan_id=plan.id,
                                text=f"I see you picked up {code} in moomoo. I've linked it to plan #{plan.id} "
                                     "and I'm watching your take-profit and stop-loss levels."))
        elif plan is None:
            store.enqueue(code, "new_holding", PRIORITY_NEW_HOLDING, now)
            alerts.append(Alert(code=code, kind="info",
                                text=f"Now tracking your new position in {code}. I've queued a deep analysis to "
                                     "set up our target and stop-loss levels."))

    for plan in store.plans_in({PlanState.HELD}):
        if plan.code not in current:
            plan.state = PlanState.CLOSED
            store.update_plan(plan)
            alerts.append(Alert(code=plan.code, kind="info", plan_id=plan.id,
                                text=f"Looks like you closed out {plan.code} ({plan.code} no longer held), so "
                                     f"I've wrapped up plan #{plan.id}."))

    store.save_positions(positions, now)
    return alerts
