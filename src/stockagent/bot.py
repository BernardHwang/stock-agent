import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from html import escape
from typing import Any

from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ChatAction, ParseMode
from telegram.error import BadRequest
from telegram.ext import Application, ApplicationBuilder, CallbackQueryHandler, CommandHandler, MessageHandler, filters

from .chat import ChatEngine, ChatReply
from .messages import FOOTER, chunk_text, format_plan_list, format_status, render_telegram_html, to_plain
from .store import Store
from .symbols import normalize_ticker

__all__ = ["BotCommands", "build_bot", "normalize_ticker", "send", "start_bot"]

log = logging.getLogger(__name__)

PRIORITY_PLAN_CMD = 1
PRIORITY_CANDIDATE = 3


# Shown in Telegram's "/" menu (registered at startup) and in /help.
# Only quick-check commands live in "/" — analysis, reasoning, and watchlist management happen in natural chat.
BOT_COMMANDS = [
    ("holdings", "Your moomoo positions and their target levels"),
    ("plans", "Active trade plans"),
    ("status", "Service health and AI usage"),
    ("help", "How to talk to your advisor & quick commands"),
]

HELP = """Talk to me in plain words like your personal financial advisor:
• "Market dropped today, is it a good time to add MDB?"
• "Run a full deep analysis on NVDA"
• "Why did the latest analysis say to hold AMD?"
• "Add TSM to my weekly watchlist"
• "How is my portfolio balanced right now?"
Reply to any alert or daily briefing to discuss it.

<b>Quick-check commands</b>
/holdings: your moomoo positions and their target levels
/plans: active trade plans
/status: service health and AI usage
/help: show this guide"""


class BotCommands:
    def __init__(self, owner_chat_id: int, store: Store, status_fn: Callable[[], dict],
                 kick_queue: Callable[[], Awaitable[None]],
                 now: Callable[[], datetime] = lambda: datetime.now(UTC).replace(tzinfo=None),
                 chat: ChatEngine | None = None, queue_deep: Callable[[str], Awaitable[int]] | None = None):
        self.owner, self.store, self.status_fn, self.kick_queue, self.now = (
            owner_chat_id, store, status_fn, kick_queue, now)
        self.chat, self.queue_deep = chat, queue_deep

    def _is_owner(self, update: Any) -> bool:
        if update.effective_chat is None or update.effective_chat.id != self.owner:
            return False
        user = getattr(update, "effective_user", None)
        return user is None or user.id == self.owner

    @staticmethod
    async def _reply(update: Any, text: str, reply_markup: Any = None) -> None:
        chunks = chunk_text(text)
        for i, chunk in enumerate(chunks):
            markup = reply_markup if i == len(chunks) - 1 else None

            async def reply(body: str, mode: str | None, markup: Any = markup) -> Any:
                return await update.message.reply_text(body, parse_mode=mode, disable_web_page_preview=True,
                                                       reply_markup=markup)

            await _html_or_plain(reply, chunk)

    async def _chat(self, update: Any, context: Any, text: str, quoted: str | None = None) -> None:
        if self.chat is None:
            await self._reply(update, "Chat is not available right now.")
            return
        bot = getattr(context, "bot", None)
        if bot is not None:
            try:
                await bot.send_chat_action(chat_id=self.owner, action=ChatAction.TYPING)
            except Exception:
                pass  # cosmetic only
        result: ChatReply = await self.chat.reply(text, quoted)
        markup = None
        if result.offer_deep:
            markup = InlineKeyboardMarkup([[InlineKeyboardButton(f"Run full analysis on {code} (~5 min)",
                                                                 callback_data=f"deep:{code}")]
                                           for code in result.offer_deep])
        rendered = render_telegram_html(result.text)
        body = f"{rendered}\n\n{FOOTER}" if FOOTER else rendered
        await self._reply(update, body, reply_markup=markup)

    async def text(self, update: Any, context: Any) -> None:
        if not self._is_owner(update) or update.message is None or not update.message.text:
            return
        quoted = update.message.reply_to_message.text if update.message.reply_to_message else None
        await self._chat(update, context, update.message.text, quoted)

    async def button(self, update: Any, context: Any) -> None:
        query = update.callback_query
        if query is None or query.from_user is None or query.from_user.id != self.owner:
            return
        code = (query.data or "").removeprefix("deep:")
        await query.answer()
        if normalize_ticker(code) != code or self.queue_deep is None:
            return
        position = await self.queue_deep(code)
        status = f"Already analysing {escape(code)}." if position == 0 else \
            f"Queued {escape(code)} (#{position} in line)."
        await query.message.reply_text(f"{status} I'll follow up here when it's done.", parse_mode=ParseMode.HTML)

    def watchlist(self) -> list[str]:
        return json.loads(self.store.kv_get("watchlist") or "[]")

    async def plans(self, update: Any, context: Any) -> None:
        if self._is_owner(update):
            await self._reply(update, format_plan_list(self.store.active_plans()))

    async def holdings(self, update: Any, context: Any) -> None:
        if not self._is_owner(update):
            return
        positions = self.store.last_positions()
        if not positions:
            await self._reply(
                update, "💼 <b>Your Holdings</b>\n\n<i>No positions found in moomoo (or not synced yet).</i>"
            )
            return
        lines = ["💼 <b>Your Holdings</b>", ""]
        for p in positions:
            plan = self.store.active_plan(p.code)
            if plan and plan.fields.tp and plan.fields.sl:
                lv = f"TP <code>{plan.fields.tp:.2f}</code> · SL <code>{plan.fields.sl:.2f}</code>"
            else:
                lv = "<i>no plan yet</i>"
            lines.append(
                f"• <b><code>{escape(p.code)}</code></b>: <code>{p.qty:g}</code> shares @ "
                f"<code>{p.avg_cost:.2f}</code>\n   {lv}"
            )
        await self._reply(update, "\n".join(lines))

    async def status(self, update: Any, context: Any) -> None:
        if self._is_owner(update):
            await self._reply(update, format_status(self.status_fn()))

    async def help(self, update: Any, context: Any) -> None:
        if self._is_owner(update):
            await self._reply(update, HELP)

    async def unknown(self, update: Any, context: Any) -> None:
        """Commands that are not (or no longer) in the menu, e.g. /plan from an old menu."""
        if not self._is_owner(update) or update.message is None:
            return
        cmd = escape(update.message.text.split()[0]) if update.message.text else "that command"
        quick = " ".join(f"/{name}" for name, _ in BOT_COMMANDS)
        await self._reply(update, f"I don't have {cmd}. Just ask me in plain words instead, e.g. "
                                  f"\"run a full analysis on NVDA\".\nQuick commands: {quick}")


async def register_commands(app: Any) -> None:
    """Fill Telegram's "/" command menu."""
    await app.bot.set_my_commands([BotCommand(name, desc) for name, desc in BOT_COMMANDS])


async def start_bot(app: Any) -> None:
    """Start polling and refresh the "/" menu. post_init would not run: it only fires from run_polling()."""
    await app.start()
    assert app.updater is not None
    await app.updater.start_polling(drop_pending_updates=True)
    try:
        await register_commands(app)
    except Exception:
        log.exception("could not register the Telegram command menu")


def build_bot(token: str, commands: BotCommands) -> Application:
    app = ApplicationBuilder().token(token).build()
    owner_only = filters.Chat(chat_id=commands.owner) & filters.User(user_id=commands.owner)
    for name, _ in BOT_COMMANDS:
        app.add_handler(CommandHandler(name, getattr(commands, name), filters=owner_only))
    app.add_handler(CommandHandler("start", commands.help, filters=owner_only))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND & owner_only, commands.text))
    app.add_handler(CallbackQueryHandler(commands.button, pattern=r"^deep:"))
    app.add_handler(MessageHandler(filters.COMMAND & owner_only, commands.unknown))  # after the known commands
    return app


async def send(app: Application, chat_id: int, text: str) -> None:
    for chunk in chunk_text(text):
        await _html_or_plain(
            lambda body, mode: app.bot.send_message(chat_id=chat_id, text=body, parse_mode=mode,
                                                    disable_web_page_preview=True),
            chunk)


async def _html_or_plain(send_fn: Callable[[str, str | None], Awaitable[Any]], chunk: str) -> None:
    """Send as HTML; if Telegram rejects the markup (e.g. unbalanced tags from the AI), resend as plain text."""
    try:
        await send_fn(chunk, ParseMode.HTML)
    except BadRequest as exc:
        if "parse entities" not in str(exc).lower():
            raise
        log.warning("Telegram rejected HTML, sending as plain text: %s", exc)
        await send_fn(to_plain(chunk), None)
