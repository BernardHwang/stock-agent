"""Telegram message text (HTML parse mode). All user-visible copy lives here."""

import re
from datetime import UTC, datetime
from html import escape, unescape
from zoneinfo import ZoneInfo

from .models import Action, Alert, Plan, PlanFields, risk_reward

FOOTER = ""

_ACTION_ICON = {Action.BUY: "📈", Action.HOLD: "✋", Action.TRIM: "✂️", Action.EXIT: "🚪"}
_ACTION_HEADLINE = {
    Action.BUY: "Buy idea",
    Action.HOLD: "Hold review",
    Action.TRIM: "Trim suggestion",
    Action.EXIT: "Exit call",
}
_LEVEL_TITLE = {
    "entry": "🎯 Entered our buy zone",
    "partial_tp": "💰 First profit target hit",
    "tp": "✅ Take-profit target reached",
    "sl": "🛑 Stop loss triggered",
    "expired": "⌛ Stop level hit before entry — cancelling plan",
}
_LEVEL_GUIDANCE = {
    "entry": ("Price has pulled back into our target range. Reply if you want to sanity-check the setup or "
              "position sizing before buying."),
    "partial_tp": "Good spot to consider locking in partial gains and trailing your stop on the rest.",
    "tp": ("We've hit our full target. Worth reviewing whether to take profits here or trail a tight stop if "
           "momentum is still strong."),
    "sl": ("Support gave way. I've queued a fresh deep review so we can decide whether the thesis is broken or "
           "if it's noise."),
    "expired": "The setup broke down before we entered, so I've taken this plan off the board.",
}


TELEGRAM_CHUNK = 4000  # Telegram's hard limit is 4096 characters

_SAFE_TAG_RE = re.compile(r"&lt;(/?(?:b|i|code|u|s|blockquote))&gt;", re.IGNORECASE)
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_MD_CODE_RE = re.compile(r"`([^`\n]+)`")


_TAG_RE = re.compile(r"<[^>]+>")


def to_plain(html_text: str) -> str:
    """Telegram HTML -> plain text (tags dropped, entities decoded)."""
    return unescape(_TAG_RE.sub("", html_text))


def render_telegram_html(text: str) -> str:
    """Escape raw LLM text for Telegram HTML while preserving safe formatting tags and **bold** / `code`."""
    out = escape(text)
    out = _SAFE_TAG_RE.sub(lambda m: f"<{m.group(1).lower()}>", out)
    out = _MD_BOLD_RE.sub(r"<b>\1</b>", out)
    out = _MD_CODE_RE.sub(r"<code>\1</code>", out)
    return out


def chunk_text(text: str, limit: int = TELEGRAM_CHUNK) -> list[str]:
    """Split on line breaks into Telegram-sized messages (a single over-long line is hard-cut)."""
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > limit:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current or not chunks:
        chunks.append(current)
    return chunks


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
        lines.append(f"• 🎯 <b>Buy zone:</b> <code>{f.entry_low:.2f} – {f.entry_high:.2f}</code>")
    if f.partial_tp is not None:
        lines.append(f"• 💰 <b>Partial TP:</b> <code>{f.partial_tp:.2f}</code>{_pct(f.partial_tp, ref)}")
    if f.tp is not None:
        lines.append(f"• ✅ <b>Take-profit:</b> <code>{f.tp:.2f}</code>{_pct(f.tp, ref)}")
    if f.sl is not None:
        lines.append(f"• 🛑 <b>Stop loss:</b> <code>{f.sl:.2f}</code>{_pct(f.sl, ref)}")
    return lines


def format_plan(plan: Plan, now: datetime, tz: str) -> str:
    f = plan.fields
    rr = risk_reward(f)
    meta = [f"<b>{f.confidence}</b> conviction"]
    if rr is not None:
        meta.append(f"<b>R/R {rr:.1f}</b>")
    if f.holding_months:
        meta.append(f"~{f.holding_months}mo horizon")
    headline = _ACTION_HEADLINE.get(f.action, f.action.value)
    levels = _levels(f)
    parts = [
        f"{_ACTION_ICON[f.action]} <b>{headline}: <code>{escape(plan.code)}</code> ({f.action.value})</b>",
        f"<i>{' · '.join(meta)}</i>",
        "",
        f"<b>💡 Advisor Thesis</b>\n<blockquote>{render_telegram_html(f.reasoning)}</blockquote>",
    ]
    if levels:
        parts += ["", "<b>📐 Key Levels</b>", *levels]
    parts += [
        "",
        f"<i>{_ts(now, tz)} · plan #{plan.id} — reply to discuss or adjust</i>",
    ]
    return "\n".join(parts)


def format_no_plan(code: str, f: PlanFields) -> str:
    return (
        f"{_ACTION_ICON[f.action]} <b><code>{escape(code)}</code> — holding off on a buy plan</b>\n"
        f"<i>{f.action.value} · {f.confidence} conviction</i>\n\n"
        f"<b>💡 Advisor Thesis</b>\n<blockquote>{render_telegram_html(f.reasoning)}</blockquote>"
    )


def format_level_alert(alert: Alert, plan: Plan, now: datetime, tz: str) -> str:
    title = _LEVEL_TITLE.get(alert.kind, alert.kind)
    price = f" at <code>{alert.price:.2f}</code>" if alert.price is not None else ""
    guidance = _LEVEL_GUIDANCE.get(alert.kind)
    levels = _levels(plan.fields)
    parts = [f"<b>{title}</b>: <code>{escape(alert.code)}</code>{price}"]
    if guidance:
        parts += ["", f"<blockquote>{guidance}</blockquote>"]
    if levels:
        parts += ["", "<b>📐 Plan Levels</b>", *levels]
    if alert.text:
        parts += ["", render_telegram_html(alert.text)]
    parts += ["", f"<i>{_ts(now, tz)} · plan #{plan.id}</i>"]
    return "\n".join(parts)


def format_news_alert(code: str, title: str, link: str | None, now: datetime, tz: str,
                      review_queued: bool = True) -> str:
    link_line = f'\n🔗 <a href="{escape(link, quote=True)}">Read full article</a>' if link else ""
    review = ("🔄 <i>I've queued a fresh review to see if this changes our thesis.</i>" if review_queued
              else "💬 <i>I already ran a review earlier today — reply if you want to talk through this headline.</i>")
    return (f"📰 <b>Major News on <code>{escape(code)}</code></b>\n"
            f"<blockquote>{escape(title)}</blockquote>{link_line}\n\n"
            f"{review}\n<i>{_ts(now, tz)}</i>")


def format_info(text: str) -> str:
    return f"💬 {render_telegram_html(text)}"


def format_health(text: str) -> str:
    return f"⚠️ <b>Heads-up (system)</b>\n{escape(text)}"


def format_invalid_plan(code: str, errors: list[str]) -> str:
    return (f"🤔 <b>Analysis on <code>{escape(code)}</code> had inconsistent levels</b> (no plan saved):\n"
            + "\n".join(f"• {escape(e)}" for e in errors))


def format_status(status: dict) -> str:
    problems = status.get("problems") or []
    lines = [
        "⚙️ <b>System Status</b>",
        "",
        f"• <b>OpenD connection:</b> <code>{escape(str(status.get('opend')))}</code>",
        f"• <b>Deep analyses today:</b> <code>{status.get('ai_runs_today')}/{status.get('max_runs_per_day')}</code>",
        f"• <b>In queue:</b> <code>{status.get('queue')}</code> waiting",
        f"• <b>Last weekly screen:</b> <code>{escape(str(status.get('last_screen') or 'not yet'))}</code>",
        f"• <b>Active price watches:</b> <code>{status.get('watching', 0)}</code> tickers",
        f"• <b>Issues:</b> {', '.join(escape(p) for p in problems) if problems else 'none'}",
    ]
    return "\n".join(lines)


def format_plan_list(plans: list[Plan]) -> str:
    if not plans:
        return (
            "📋 <b>Your Active Trade Plans</b>\n\n"
            "<i>No active trade plans right now. Just ask me to look at a ticker whenever you're ready.</i>"
        )
    rows = []
    for p in plans:
        f = p.fields
        lv = " · ".join(x for x in [
            f"Entry <code>{f.entry_low:.2f}–{f.entry_high:.2f}</code>" if f.entry_low and f.entry_high else "",
            f"TP <code>{f.tp:.2f}</code>" if f.tp else "",
            f"SL <code>{f.sl:.2f}</code>" if f.sl else "",
        ] if x)
        icon = _ACTION_ICON.get(f.action, "•")
        rows.append(
            f"{icon} <b><code>{escape(p.code)}</code></b> — <b>{f.action.value}</b> "
            f"(<i>{p.state.value.lower()}</i>, plan #{p.id})\n   {lv}"
        )
    return "📋 <b>Your Active Trade Plans</b>\n\n" + "\n\n".join(rows)


def format_weekly_summary(rows: list[dict]) -> str:
    if not rows:
        return "📊 <b>Weekly Portfolio & Plan Check-In</b>\n\n<i>No past plans to score yet.</i>"
    lines = [
        "📊 <b>Weekly Portfolio & Plan Check-In</b>",
        "<i>Here's how our recent trade plans have played out:</i>",
        "",
    ]
    for r in rows:
        bits = [f"<b><code>{escape(r['code'])}</code></b> ({r['action']}, <i>{r['state'].lower()}</i>) [#{r['id']}]"]
        if r.get("first_hit"):
            bits.append(f"first hit: <b>{escape(str(r['first_hit']))}</b>")
        for k, label in (("ret_4w", "4w"), ("ret_12w", "12w"), ("ret_26w", "26w")):
            if r.get(k) is not None:
                bits.append(f"{label} <code>{r[k] * 100:+.1f}%</code>")
        lines.append("• " + " · ".join(bits))
    lines.append("\n<i>Message me anytime if you want to review our holdings or rebalance.</i>")
    return "\n".join(lines)


def format_daily_summary(snapshot: dict, briefing: str | None = None) -> str:
    """Format the daily morning briefing (with structured header + AI advisor commentary or fallback)."""
    lines = ["☀️ <b>Daily Portfolio & Market Check-In</b>"]
    indices = snapshot.get("indices") or {}
    if indices:
        idx_str = " · ".join(f"<b>{escape(k)}</b> <code>{v * 100:+.1f}%</code>" for k, v in indices.items())
        lines.append(f"<b>📊 Market Close:</b> {idx_str}")
    holdings = snapshot.get("holdings") or []
    if holdings:
        lines.append("\n<b>💼 Your Holdings</b>")
        for h in holdings:
            bits = [f"<b><code>{escape(h['code'])}</code></b>"]
            if h.get("price") is not None:
                bits.append(f"<code>{h['price']:.2f}</code>")
            if h.get("day_move_pct") is not None:
                bits.append(f"day <code>{h['day_move_pct']:+.1f}%</code>")
            if h.get("pnl_pct") is not None:
                bits.append(f"P/L <code>{h['pnl_pct']:+.1f}%</code>")
            if h.get("tp") and h.get("sl"):
                bits.append(f"[TP <code>{h['tp']:.2f}</code> · SL <code>{h['sl']:.2f}</code>]")
            lines.append("• " + " · ".join(bits))
    elif not briefing:
        lines.append("\n<i>No held positions right now.</i>")
    if briefing:
        lines.append(f"\n<b>💡 Advisor Take</b>\n{render_telegram_html(briefing)}")
    queued = snapshot.get("auto_queued_reviews") or []
    if queued:
        codes_html = ", ".join(f"<code>{escape(c)}</code>" for c in queued)
        lines.append(f"\n🔄 <b>Auto-queued fresh deep plan review:</b> {codes_html}")
    lines.append("\n<i>Reply to discuss any position or adjust our plans.</i>")
    return "\n".join(lines)
