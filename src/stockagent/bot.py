import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from html import escape
from typing import Any

from telegram import BotCommand
from telegram.constants import ParseMode
from telegram.ext import Application, ApplicationBuilder, CommandHandler, filters

from .analysis import is_rate_limit, load_report
from .messages import FOOTER, chunk_text, format_plan_list, format_status
from .models import Position
from .store import Store
from .symbols import from_yf

AskFn = Callable[[str, str, str, str, Position | None], Awaitable[str]]

PRIORITY_PLAN_CMD = 1
PRIORITY_CANDIDATE = 3

_CODE_RE = re.compile(r"^(US|HK|MY|SG|JP)\.[A-Z0-9.]{1,10}$")
_YF_RE = re.compile(r"^[A-Z0-9]{1,6}\.(HK|KL|SI|T)$")
_US_RE = re.compile(r"^[A-Z]{1,5}([.-][A-Z])?$")

# Shown in Telegram's "/" menu (registered at startup) and in /help.
BOT_COMMANDS = [
    ("plan", "Analyse a stock now, e.g. /plan NVDA"),
    ("why", "Why the agent said what it said, e.g. /why MDB"),
    ("ask", "Ask about a stock's analysis, e.g. /ask MDB why not sell?"),
    ("plans", "Active plans"),
    ("holdings", "Your moomoo positions and their levels"),
    ("watch", "Add a ticker to the weekly analysis"),
    ("unwatch", "Remove a ticker from the weekly analysis"),
    ("status", "Service health and AI usage"),
    ("help", "List commands"),
]

HELP = """<b>Commands</b>
/plan TICKER: analyse a stock now (e.g. /plan NVDA, /plan 0700.HK, /plan 0166.KL)
/why TICKER: the reasoning behind the latest analysis
/ask TICKER question: ask about the latest analysis (e.g. /ask MDB why not sell everything?)
/plans: active plans
/holdings: your moomoo positions and their levels
/watch TICKER, /unwatch TICKER: extra tickers for the weekly analysis
/status: service health and AI usage"""


def normalize_ticker(arg: str) -> str | None:
    a = arg.strip().upper()
    if _CODE_RE.match(a):
        if a.startswith("HK."):
            return f"HK.{int(a[3:]):05d}" if a[3:].isdigit() else None
        return a
    if _YF_RE.match(a):
        return from_yf(a)
    if _US_RE.match(a):
        return f"US.{a.replace('-', '.')}"
    return None


class BotCommands:
    def __init__(self, owner_chat_id: int, store: Store, status_fn: Callable[[], dict],
                 kick_queue: Callable[[], Awaitable[None]],
                 now: Callable[[], datetime] = lambda: datetime.now(UTC).replace(tzinfo=None),
                 ask_fn: AskFn | None = None):
        self.owner, self.store, self.status_fn, self.kick_queue, self.now = (
            owner_chat_id, store, status_fn, kick_queue, now)
        self.ask_fn = ask_fn

    def _is_owner(self, update: Any) -> bool:
        return update.effective_chat is not None and update.effective_chat.id == self.owner

    @staticmethod
    async def _reply(update: Any, text: str) -> None:
        for chunk in chunk_text(text):
            await update.message.reply_text(chunk, parse_mode=ParseMode.HTML, disable_web_page_preview=True)

    async def _ticker_arg(self, update: Any, context: Any, usage: str) -> str | None:
        if not context.args:
            await self._reply(update, f"Usage: {usage}")
            return None
        code = normalize_ticker(context.args[0])
        if code is None:
            await self._reply(update, f"I don't recognise the ticker {escape(context.args[0])}. "
                                      "Try NVDA, 0700.HK or 0166.KL.")
        return code

    def watchlist(self) -> list[str]:
        return json.loads(self.store.kv_get("watchlist") or "[]")

    def _set_watchlist(self, codes: list[str]) -> None:
        self.store.kv_set("watchlist", json.dumps(sorted(set(codes))))

    async def plan(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        code = await self._ticker_arg(update, context, "/plan TICKER")
        if code is None:
            return
        self.store.enqueue(code, "plan_cmd", PRIORITY_PLAN_CMD, self.now())
        position = next(i for i, it in enumerate(self.store.pending_items(), 1) if it.code == code)
        await self._reply(update, f"Queued {escape(code)} (#{position} in line). The plan will arrive here when "
                                  "the analysis finishes, usually within a few minutes.")
        await self.kick_queue()

    @staticmethod
    def _no_report(context: Any) -> str:
        return (f"There's no analysis saved for that stock yet. Send /plan {escape(context.args[0].upper())} "
                "first, then ask again.")

    async def why(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        code = await self._ticker_arg(update, context, "/why TICKER")
        if code is None:
            return
        saved = load_report(self.store, code)
        if saved is None:
            await self._reply(update, self._no_report(context))
            return
        at, report = saved
        plan = self.store.active_plan(code)
        parts = [f"<b>Why: {escape(code)}</b> (analysis from {escape(at)} UTC)"]
        if plan:
            parts.append(f"Plan #{plan.id}: {plan.fields.action.value}, {escape(plan.fields.reasoning)}")
        parts += ["", escape(_section(report, "Final decision") or report[:3500]), "",
                  f"Ask a follow-up with /ask {escape(context.args[0].upper())} your question", FOOTER]
        await self._reply(update, "\n".join(parts))

    async def ask(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        if len(context.args or []) < 2:
            await self._reply(update, "Usage: /ask TICKER your question (e.g. /ask MDB why not sell everything?)")
            return
        code = await self._ticker_arg(update, context, "/ask TICKER question")
        if code is None:
            return
        saved = load_report(self.store, code)
        if saved is None or self.ask_fn is None:
            await self._reply(update, self._no_report(context))
            return
        question = " ".join(context.args[1:])
        held = next((p for p in self.store.last_positions() if p.code == code), None)
        await self._reply(update, "Thinking…")
        try:
            answer = await self.ask_fn(code, question, saved[1], saved[0], held)
        except Exception as exc:
            if is_rate_limit(exc):
                await self._reply(update, "AI quota reached for now. Try again later.")
            else:
                await self._reply(update, f"Couldn't answer that ({type(exc).__name__}).")
            return
        await self._reply(update, f"<b>{escape(code)}</b>\n{escape(answer)}\n\n{FOOTER}")

    async def watch(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        code = await self._ticker_arg(update, context, "/watch TICKER")
        if code:
            self._set_watchlist([*self.watchlist(), code])
            await self._reply(update, f"Added {escape(code)} to the weekly analysis.")

    async def unwatch(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        code = await self._ticker_arg(update, context, "/unwatch TICKER")
        if code:
            self._set_watchlist([c for c in self.watchlist() if c != code])
            await self._reply(update, f"Removed {escape(code)}.")

    async def plans(self, update: Any, context: Any) -> None:
        if self._is_owner(update):
            await self._reply(update, format_plan_list(self.store.active_plans()))

    async def holdings(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        positions = self.store.last_positions()
        if not positions:
            await self._reply(update, "No positions found in moomoo (or not synced yet).")
            return
        lines = ["<b>Holdings</b>"]
        for p in positions:
            plan = self.store.active_plan(p.code)
            if plan and plan.fields.tp and plan.fields.sl:
                lv = f"TP {plan.fields.tp:.2f} · SL {plan.fields.sl:.2f}"
            else:
                lv = "no plan yet"
            lines.append(f"{escape(p.code)}: {p.qty:g} @ {p.avg_cost:.2f} · {lv}")
        await self._reply(update, "\n".join(lines))

    async def status(self, update: Any, context: Any) -> None:
        if self._is_owner(update):
            await self._reply(update, format_status(self.status_fn()))

    async def help(self, update: Any, context: Any) -> None:
        if self._is_owner(update):
            await self._reply(update, HELP)


def _section(report: str, title: str) -> str | None:
    """Text of a '## title' section from the saved report."""
    match = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", report, re.S | re.M)
    return match.group(1).strip() if match else None


async def register_commands(app: Any) -> None:
    """Fill Telegram's "/" command menu."""
    await app.bot.set_my_commands([BotCommand(name, desc) for name, desc in BOT_COMMANDS])


def build_bot(token: str, commands: BotCommands) -> Application:
    app = ApplicationBuilder().token(token).post_init(register_commands).build()
    owner_only = filters.Chat(chat_id=commands.owner)
    for name, _ in BOT_COMMANDS:
        app.add_handler(CommandHandler(name, getattr(commands, name), filters=owner_only))
    app.add_handler(CommandHandler("start", commands.help, filters=owner_only))
    return app


async def send(app: Application, chat_id: int, text: str) -> None:
    for chunk in chunk_text(text):
        await app.bot.send_message(chat_id=chat_id, text=chunk, parse_mode=ParseMode.HTML,
                                   disable_web_page_preview=True)
