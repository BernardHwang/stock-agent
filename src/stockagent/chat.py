"""Plain-language chat with the owner: a tool-calling loop on the quick model, with memory."""

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool

from .analysis import is_rate_limit, langchain_provider
from .chat_tools import TOOL_NAMES, ChatToolbox
from .config import Settings
from .models import ChatMessage
from .store import Store

log = logging.getLogger(__name__)

TURN_TIMEOUT_S: float = 90
MAX_ROUNDS = 6

ROUND_LIMIT_TEXT = "I couldn't finish looking that up. Try asking more narrowly."
CAP_TEXT = "Daily chat limit reached (CHAT_MAX_PER_DAY). It resets tomorrow."
WARN_TEXT = "(Heads-up: 90% of today's chat limit is used.)"
TIMEOUT_TEXT = "That took too long, please try again."
QUOTA_TEXT = "AI quota reached for now. Try again later."
EMPTY_TEXT = "Sorry, I don't have an answer for that."

TOOL_DESCRIPTIONS = {
    "get_quotes": "Live prices for one or more tickers (e.g. ['NVDA', '0700.HK']).",
    "get_portfolio": "The owner's moomoo positions from the last sync: qty, average cost, price, P/L %, and "
                     "weight as a % of stock holdings (cash excluded).",
    "refresh_positions": "Re-read moomoo positions now (use when the owner says they bought or sold), then "
                         "return the portfolio.",
    "get_stock_context": "Everything known about one stock: position, active plan and levels, latest deep "
                         "analysis summary and its age, live price, whether a fresh deep analysis is "
                         "recommended and why, saved notes, and look-alike tickers the owner may have meant.",
    "get_news": "Latest news headlines for a stock, with publish time and whether each looks major.",
    "get_market_overview": "Today's move of the major US indices (SPY, QQQ, DIA) as fractions.",
    "list_notes": "Saved memory notes for a ticker, or the owner's own notes when ticker is omitted.",
    "add_note": "Save a short dated memory note: about a ticker, or about the owner when ticker is omitted.",
    "forget_note": "Deactivate a memory note by id (it can be restored).",
    "restore_note": "Re-activate a previously forgotten note by id.",
    "queue_deep_analysis": "Queue a full multi-agent analysis (~5 min). Only when the owner explicitly asks.",
    "offer_deep_analysis": "Show the owner a 'Run full analysis' button for a ticker.",
}

SYSTEM_PROMPT = """You are the owner's personal stock market assistant in Telegram. Today is {today} (UTC).
You only inform and suggest; the owner places every order themselves. You cannot trade.

How to answer:
- For decisions ("good time to enter X?", "buy more X?", "sell?") start with a verdict: Yes, Wait or No,
  then the reason in one or two lines, then the numbers: entry/add range, take-profit and stop loss. For
  "Wait", say what price or event would change your mind. When the owner holds the stock, use their average
  cost, P/L and portfolio weight, suggest roughly how much to add, and how the stop changes after adding.
- Use only numbers from tool results. Never invent prices, positions or levels; if data is missing, say so.
- Call get_stock_context before giving a view on a stock. If deep_recommended is true, say so up front
  (with deep_reason) and call offer_deep_analysis. Call queue_deep_analysis only when the owner explicitly
  asks for a full or deep analysis.
- If get_stock_context returns lookalike tickers and the owner may have mistyped, ask which one they meant.
- Saved plans are long-only. You may discuss shorting if asked, but never present it as a saved plan.
- When the owner says they bought or sold something, call refresh_positions; if moomoo doesn't show it, say
  so and don't record it as done.
- After a substantive suggestion or a decision by the owner, save a short dated stock note with add_note.
  Save lasting preferences the owner states ("I don't short", "max 20% per stock") as owner notes. When asked
  what you remember, use list_notes; when told to forget something, use forget_note.
- Messages starting with [Bot alert] are alerts you sent earlier; replies may refer to them.
- Plain text, no markdown headings, at most 1200 characters.

Owner notes (standing preferences):
{owner_notes}
"""

FOLLOW_UP_PROMPT = """[A full analysis of {code} you ran for the owner just finished.]
{result}

In two or three sentences, tell the owner whether your view changed compared with what you said about {code}
earlier in this chat, and what that means for them now. Plain text."""

LlmFactory = Callable[[list[BaseTool]], Any]


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _text(content: Any) -> str:
    if isinstance(content, list):  # some providers return content blocks
        content = "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    return str(content or "").strip()


@dataclass
class ChatReply:
    text: str
    offer_deep: list[str] = field(default_factory=list)


class _CapReached(Exception):
    pass


class ChatEngine:
    def __init__(self, settings: Settings, store: Store, toolbox: ChatToolbox, llm_factory: LlmFactory | None = None,
                 now: Callable[[], datetime] = _utcnow):
        self.settings, self.store, self.toolbox, self.now = settings, store, toolbox, now
        self._factory = llm_factory or self._default_factory
        self._llm: Any = None
        self._lock = asyncio.Lock()  # one turn at a time keeps history in order
        self._warn = False

    def _default_factory(self, tools: list[BaseTool]) -> Any:
        from langchain.chat_models import init_chat_model

        llm = init_chat_model(self.settings.quick_model, model_provider=langchain_provider(self.settings.llm_provider))
        return llm.bind_tools(tools)

    def _model(self) -> Any:
        if self._llm is None:
            tools: list[BaseTool] = [
                StructuredTool.from_function(coroutine=getattr(self.toolbox, name), name=name,
                                             description=TOOL_DESCRIPTIONS[name])
                for name in TOOL_NAMES]
            self._llm = self._factory(tools)
        return self._llm

    def _spend(self) -> None:
        """Count one model call against the daily cap; raise when the cap is reached."""
        day = self.now().date()
        cap = self.settings.chat_max_per_day
        if self.store.chat_calls_on(day) >= cap:
            raise _CapReached
        n = self.store.count_chat_call(day)
        warned_key = f"chat_warned:{day.isoformat()}"
        if n >= int(0.9 * cap) and not self.store.kv_get(warned_key):
            self.store.kv_set(warned_key, "1")
            self._warn = True

    def _system(self) -> SystemMessage:
        notes = self.store.notes(None)
        owner_notes = "\n".join(f"- ({n.at:%Y-%m-%d}) {n.text}" for n in notes) or "- none yet"
        return SystemMessage(SYSTEM_PROMPT.format(today=f"{self.now():%Y-%m-%d %a}", owner_notes=owner_notes))

    @staticmethod
    def _history(messages: list[ChatMessage]) -> list[BaseMessage]:
        out: list[BaseMessage] = []
        # Some providers reject a conversation whose first turn is the assistant's.
        while messages and messages[0].role == "bot":
            messages = messages[1:]
        for m in messages:
            if m.role == "bot":
                out.append(AIMessage(m.text))
            elif m.role == "alert":
                out.append(HumanMessage(f"[Bot alert] {m.text}"))
            else:
                out.append(HumanMessage(m.text))
        return out

    async def _dispatch(self, name: str, args: dict[str, Any]) -> str:
        if name not in TOOL_NAMES:
            return json.dumps({"error": "unknown tool"})
        try:
            result: str = await getattr(self.toolbox, name)(**args)
            return result
        except TypeError as exc:  # wrong or missing arguments from the model
            return json.dumps({"error": f"bad arguments for {name}: {exc}"})

    async def _loop(self, messages: list[BaseMessage]) -> str:
        llm = self._model()
        for _ in range(MAX_ROUNDS):
            self._spend()
            ai = await llm.ainvoke(messages)
            messages.append(ai)
            if not ai.tool_calls:
                return _text(ai.content) or EMPTY_TEXT
            for call in ai.tool_calls:
                result = await self._dispatch(call["name"], call.get("args") or {})
                messages.append(ToolMessage(result, tool_call_id=call["id"]))
        return ROUND_LIMIT_TEXT

    async def reply(self, text: str, quoted: str | None = None) -> ChatReply:
        async with self._lock:
            self._warn = False
            self.toolbox.offers.clear()
            content = f"[Replying to: {quoted}]\n{text}" if quoted else text
            history = self.store.recent_messages(self.settings.chat_history)
            self.store.log_message("owner", content, self.now())
            messages = [self._system(), *self._history(history), HumanMessage(content)]
            try:
                answer = await asyncio.wait_for(self._loop(messages), TURN_TIMEOUT_S)
            except _CapReached:
                answer = CAP_TEXT
            except TimeoutError:
                answer = TIMEOUT_TEXT
            except Exception as exc:
                log.exception("chat turn failed")
                answer = QUOTA_TEXT if is_rate_limit(exc) else f"Couldn't answer that ({type(exc).__name__})."
            if self._warn:
                answer = f"{answer}\n\n{WARN_TEXT}"
            self.store.log_message("bot", answer, self.now())
            offers = list(dict.fromkeys(self.toolbox.offers))
            self.toolbox.offers.clear()
            return ChatReply(answer, offers)

    async def follow_up(self, code: str, result_text: str) -> str | None:
        """After a chat-requested deep analysis: one short note on whether the view changed."""
        async with self._lock:
            history = self._history(self.store.recent_messages(self.settings.chat_history))
            messages = [self._system(), *history,
                        HumanMessage(FOLLOW_UP_PROMPT.format(code=code, result=result_text))]
            try:
                self._spend()
                ai = await asyncio.wait_for(self._model().ainvoke(messages), TURN_TIMEOUT_S)
            except _CapReached:
                return None
            except Exception:
                log.exception("chat follow-up failed for %s", code)
                return None
            return _text(ai.content) or None
