"""Telegram message text (HTML parse mode). All user-visible copy lives here."""

from datetime import UTC, datetime
from html import escape
from zoneinfo import ZoneInfo

from .models import Action, Alert, Plan, PlanFields, risk_reward

FOOTER = "ℹ️ Informational only, not financial advice. You decide and place every trade."

_ACTION_ICON = {Action.BUY: "📈", Action.HOLD: "✋", Action.TRIM: "✂️", Action.EXIT: "🚪"}
_LEVEL_TITLE = {
    "entry": "🎯 Price is in the buy zone",
    "partial_tp": "💰 Partial take-profit reached",
    "tp": "✅ Take-profit reached",
    "sl": "🛑 Stop loss hit",
    "expired": "⌛ Stop level hit before you bought: plan cancelled",
}


def _ts(now: datetime, tz: str) -> str:
    """Internal datetimes are naive UTC; show them in the owner's time zone."""
    local = (now if now.tzinfo else now.replace(tzinfo=UTC)).astimezone(ZoneInfo(tz))
    label = "MYT" if tz == "Asia/Kuala_Lumpur" else local.strftime("%Z")
    return f"{local:%Y-%m-%d %H:%M} {label}"


def _pct(level: float, ref: float | None) -> str:
    return f" ({(level / ref - 1) * 100:+.1f}%)" if ref else ""


def _levels(f: PlanFields) -> list[str]:
    ref = (f.entry_low + f.entry_high) / 2 if f.entry_low and f.entry_high else None
    lines = []
    if f.entry_low is not None and f.entry_high is not None:
        lines.append(f"Buy zone: {f.entry_low:.2f} – {f.entry_high:.2f}")
    if f.partial_tp is not None:
        lines.append(f"Partial take-profit: {f.partial_tp:.2f}{_pct(f.partial_tp, ref)}")
    if f.tp is not None:
        lines.append(f"Take-profit: {f.tp:.2f}{_pct(f.tp, ref)}")
    if f.sl is not None:
        lines.append(f"Stop loss: {f.sl:.2f}{_pct(f.sl, ref)}")
    return lines


def format_plan(plan: Plan, now: datetime, tz: str) -> str:
    f = plan.fields
    rr = risk_reward(f)
    meta = [f"confidence {f.confidence}"]
    if rr is not None:
        meta.append(f"R/R {rr:.1f}")
    if f.holding_months:
        meta.append(f"hold ~{f.holding_months} months")
    parts = [
        f"{_ACTION_ICON[f.action]} <b>{f.action.value} {escape(plan.code)}</b>",
        *_levels(f),
        " · ".join(meta),
        "",
        escape(f.reasoning),
        "",
        f"<i>{_ts(now, tz)} · plan #{plan.id}</i>",
        FOOTER,
    ]
    return "\n".join(parts)


def format_no_plan(code: str, f: PlanFields) -> str:
    return (f"{_ACTION_ICON[f.action]} <b>{escape(code)}: no buy plan right now</b> "
            f"(analysis says {f.action.value}, confidence {f.confidence})\n\n{escape(f.reasoning)}\n{FOOTER}")


def format_level_alert(alert: Alert, plan: Plan, now: datetime, tz: str) -> str:
    title = _LEVEL_TITLE.get(alert.kind, alert.kind)
    price = f" at {alert.price:.2f}" if alert.price is not None else ""
    parts = [f"<b>{title}</b>: {escape(alert.code)}{price}", *_levels(plan.fields)]
    if alert.text:
        parts += ["", escape(alert.text)]
    parts += ["", f"<i>{_ts(now, tz)} · plan #{plan.id}</i>", FOOTER]
    return "\n".join(parts)


def format_news_alert(code: str, title: str, link: str | None, now: datetime, tz: str) -> str:
    link_line = f'\n<a href="{escape(link, quote=True)}">Read more</a>' if link else ""
    return (f"📰 <b>Major news on {escape(code)}</b>\n{escape(title)}{link_line}\n\n"
            f"A fresh hold-or-exit review has been queued.\n<i>{_ts(now, tz)}</i>\n{FOOTER}")


def format_info(text: str) -> str:
    return f"ℹ️ {escape(text)}"


def format_health(text: str) -> str:
    return f"⚠️ <b>Service problem</b>\n{escape(text)}"


def format_invalid_plan(code: str, errors: list[str]) -> str:
    return (f"🤔 Analysis for {escape(code)} produced no valid plan, so nothing was sent.\n"
            + "\n".join(f"• {escape(e)}" for e in errors))


def format_status(status: dict) -> str:
    problems = status.get("problems") or []
    lines = [
        "<b>Status</b>",
        f"OpenD: {escape(str(status.get('opend')))}",
        f"AI runs today: {status.get('ai_runs_today')}/{status.get('max_runs_per_day')}",
        f"Analyses waiting: {status.get('queue')}",
        f"Last weekly screen: {escape(str(status.get('last_screen') or 'not yet'))}",
        f"Watching: {status.get('watching', 0)} tickers",
    ]
    lines.append("Problems: " + (", ".join(escape(p) for p in problems) if problems else "none"))
    return "\n".join(lines)


def format_plan_list(plans: list[Plan]) -> str:
    if not plans:
        return "No active plans."
    rows = []
    for p in plans:
        f = p.fields
        lv = " ".join(x for x in [f"TP {f.tp:.2f}" if f.tp else "", f"SL {f.sl:.2f}" if f.sl else ""] if x)
        rows.append(f"#{p.id} {escape(p.code)} {f.action.value} [{p.state.value}] {lv}")
    return "<b>Active plans</b>\n" + "\n".join(rows)


def format_weekly_summary(rows: list[dict]) -> str:
    if not rows:
        return "<b>Weekly summary</b>\nNo plans to report yet."
    lines = ["<b>Weekly summary</b>"]
    for r in rows:
        bits = [f"#{r['id']} {escape(r['code'])} {r['action']} [{r['state']}]"]
        if r.get("first_hit"):
            bits.append(f"first hit: {r['first_hit']}")
        for k, label in (("ret_4w", "4w"), ("ret_12w", "12w"), ("ret_26w", "26w")):
            if r.get(k) is not None:
                bits.append(f"{label} {r[k] * 100:+.1f}%")
        lines.append(" · ".join(bits))
    return "\n".join(lines)
