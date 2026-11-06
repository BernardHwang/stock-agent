from datetime import datetime, timedelta

from .models import Action, Plan, PlanFields, PlanState
from .store import Store

PLAN_TTL = timedelta(days=60)


def apply_new_analysis(store: Store, code: str, fields: PlanFields, source: str, now: datetime) -> Plan:
    """Fold a fresh analysis into the ticker's plan. Returns a plan with ``id=None`` when nothing was saved."""
    active = store.active_plan(code)

    if active is not None and active.state == PlanState.HELD:
        if fields.action == Action.BUY:
            # Already owned: "buy" means keep holding with these levels.
            fields = fields.model_copy(update={"action": Action.HOLD})
        if _exit_levels(fields) != _exit_levels(active.fields):
            active.fired = set()
        active.fields, active.source = fields, source
        store.update_plan(active)
        return active

    if active is not None:
        active.state = PlanState.EXPIRED
        store.update_plan(active)

    plan = Plan(code=code, fields=fields, state=PlanState.OPEN, created_at=now, source=source)
    if fields.action == Action.BUY:
        store.save_plan(plan)
    return plan


def _exit_levels(f: PlanFields) -> tuple[float | None, ...]:
    return (f.partial_tp, f.tp, f.sl)


def expire_stale(store: Store, now: datetime) -> list[Plan]:
    expired = []
    for p in store.plans_in({PlanState.OPEN, PlanState.TRIGGERED}):
        if now - p.created_at > PLAN_TTL:
            p.state = PlanState.EXPIRED
            store.update_plan(p)
            expired.append(p)
    return expired
