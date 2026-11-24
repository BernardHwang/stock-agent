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

from .analysis import TOOL_CALL_FILLER, is_rate_limit, langchain_provider, llm_client_kwargs
from .chat_tools import TOOL_NAMES, ChatToolbox
from .config import Settings, local_date
from .models import ChatMessage
from .store import Store

log = logging.getLogger(__name__)

TURN_TIMEOUT_S: float = 90
MAX_ROUNDS = 6

FINAL_ANSWER_PROMPT = "Stop looking things up. Answer my question now using only the data above."
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
    "get_stock_context": "Everything known about one stock: position (with P/L and portfolio weight), active plan "
                         "and levels, latest deep analysis summary and its age, live price, whether a fresh deep "
                         "analysis is recommended and why, saved notes, and look-alike tickers.",
    "get_full_report": "Full saved deep analysis report (Final decision, Trader plan, Technicals, Fundamentals) "
                       "for a stock when the owner asks why an analysis recommended something.",
    "get_news": "Latest news headlines for a stock, with publish time and whether each looks major.",
    "get_market_overview": "Today's move of the major US indices (SPY, QQQ, DIA) as fractions.",
    "list_notes": "Saved memory notes for a ticker, or the owner's own notes when ticker is omitted.",
    "add_note": "Save a short dated memory note: about a ticker, or about the owner when ticker is omitted.",
    "forget_note": "Deactivate a memory note by id (it can be restored).",
    "restore_note": "Re-activate a previously forgotten note by id.",
    "get_watchlist": "List the tickers on the owner's weekly analysis watchlist.",
    "add_to_watchlist": "Add a ticker to the weekly analysis watchlist.",
    "remove_from_watchlist": "Remove a ticker from the weekly analysis watchlist.",
    "list_active_plans": "List all active trade plans across the portfolio with their entry, TP, SL, and thesis.",
    "queue_deep_analysis": "Queue a full multi-agent analysis (~5 min) when the owner asks to analyse or plan a stock.",
    "offer_deep_analysis": "Show the owner a 'Run full analysis' button for a ticker.",
}

SYSTEM_PROMPT = """You are the owner's personal financial advisor and investment partner in Telegram.
Today is {today} (UTC). You advise and discuss strategy; the owner places every order themselves in moomoo.
You cannot execute trades.

Your persona and advisory style:
- Pragmatic, warm, candid, and direct. Speak like a sharp human financial advisor who knows the owner's
  portfolio inside out—never like a robotic template or a rigid report generator.
- Do not start every answer with a mechanical "Yes / Wait / No" header unless a quick one-word verdict
  genuinely fits. Instead, talk through the setup, the thesis, and how it fits their portfolio naturally.
- Weave key numbers (buy zone, take-profit, stop loss, average cost, P/L, portfolio weight) smoothly into
  your advice when they are relevant, rather than dumping a rigid checklist every time.
- Push back candidly when a trade looks impulsive, chases a stretched rally, catches a falling knife without
  a catalyst, or makes a single position too concentrated in their portfolio. Ask clarifying questions when
  their thesis, time horizon, or sizing intent is unclear.
- Factor in portfolio balance and risk: when they ask about buying or adding to a stock, check how much they
  already hold, their average cost, and how adding affects their concentration and downside risk.

Tool and memory rules:
- Use only numbers from tool results. Never invent prices, positions, or levels; if data is missing, say so.
- Call get_stock_context (and get_portfolio when portfolio balance or sizing matters) before giving a view on
  a stock. If deep_recommended is true, mention naturally why a fresh deep dive could help (using deep_reason)
  and call offer_deep_analysis. Call queue_deep_analysis when the owner asks for a full/deep analysis or plan.
- Manage the owner's watchlist (get_watchlist, add_to_watchlist, remove_from_watchlist) and review active
  plans (list_active_plans) directly when asked in conversation—don't tell them to run slash commands.
- If get_stock_context returns lookalike tickers and the owner may have mistyped, ask which one they meant.
- Saved plans are long-only. You may discuss shorting or hedging if asked, but never present a short as a
  saved plan.
- When the owner says they bought or sold something, call refresh_positions; if moomoo doesn't show it yet,
  let them know and don't record it as done.
- After a substantive discussion, recommendation, or decision by the owner, save a short dated note with
  add_note. Save lasting personal preferences, goals, or risk rules ("I don't short", "max 20% per stock") as
  owner notes. When asked what you remember, use list_notes; when told to forget something, use forget_note.
- Messages starting with [Bot alert] are alerts you sent earlier; replies may refer to them.
- Structure your replies so they are clean, scannable, and easy to read in Telegram:
  • Use short paragraphs, bullet points (•), and Telegram HTML tags: <b>bold</b> for section headers or key
    takeaways, <code>tickers / price levels</code> for numbers, and <i>italics</i> for nuance.
  • Never use markdown # headings or raw markdown tables; keep replies under 1500 characters.

Current portfolio snapshot (last sync):
{portfolio_snapshot}

Owner notes (standing preferences, goals & risk rules):
{owner_notes}
"""

FOLLOW_UP_PROMPT = """[The deep analysis of {code} you queued for the owner just finished.]
{result}

In two or three natural sentences, follow up with the owner as their advisor: let them know whether this deep
dive changed your view compared with your earlier conversation about {code}, and what the practical takeaway
is for their position or entry plan. Use Telegram HTML (<b>bold</b>, <code>prices/tickers</code>) for readability."""

DAILY_BRIEF_PROMPT = """[Morning Daily Briefing Data for the owner]
{snapshot}

Write a concise, well-structured morning check-in as the owner's personal financial advisor (use Telegram HTML
like <b>bold</b>, <code>tickers/prices</code>, and • bullet points; no markdown # headings, under 1200 characters):
1. Briefly summarize how the broader market (SPY/QQQ/DIA) closed and what drove the session.
2. Give a quick advisor take on how their held positions or open plans look (especially any stock close to its
   take-profit/stop-loss or with notable news/moves), and whether any plan needs adjusting.
3. If any stock is listed in `auto_queued_reviews`, mention that you've already queued a fresh deep analysis
   to re-check its plan."""

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

        llm = init_chat_model(
            self.settings.effective_chat_model,
            model_provider=langchain_provider(self.settings.llm_provider),
            **llm_client_kwargs(self.settings),
        )
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
        day = local_date(self.now(), self.settings.tz)
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
        positions = self.store.last_positions()
        total_cost = sum(p.qty * p.avg_cost for p in positions)
        if positions:
            pos_lines = []
            for p in positions:
                w = f" (~{p.qty * p.avg_cost / total_cost * 100:.0f}% by cost)" if total_cost else ""
                plan = self.store.active_plan(p.code)
                lv = ""
                if plan and (plan.fields.tp or plan.fields.sl):
                    bits = [f"TP {plan.fields.tp:.2f}" if plan.fields.tp else "",
                            f"SL {plan.fields.sl:.2f}" if plan.fields.sl else ""]
                    lv = f" [{', '.join(b for b in bits if b)}]"
                pos_lines.append(f"- {p.code}: {p.qty:g} shares @ {p.avg_cost:.2f}{w}{lv}")
            portfolio_snapshot = "\n".join(pos_lines)
        else:
            portfolio_snapshot = "- no positions synced yet"
        return SystemMessage(SYSTEM_PROMPT.format(
            today=f"{self.now():%Y-%m-%d %a}",
            portfolio_snapshot=portfolio_snapshot,
            owner_notes=owner_notes,
        ))

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
            if not ai.tool_calls:
                return _text(ai.content) or EMPTY_TEXT
            if not _text(ai.content):
                # Cloudflare Workers AI rejects (HTTP 400) an assistant tool-call message with null content.
                ai = ai.model_copy(update={"content": TOOL_CALL_FILLER})  # keeps provider metadata
            messages.append(ai)
            for call in ai.tool_calls:
                result = await self._dispatch(call["name"], call.get("args") or {})
                messages.append(ToolMessage(result, tool_call_id=call["id"]))
        # Smaller models keep calling tools; one last turn asks for an answer from what was gathered.
        self._spend()
        ai = await llm.ainvoke(messages + [HumanMessage(FINAL_ANSWER_PROMPT)])
        return (_text(ai.content) or ROUND_LIMIT_TEXT) if not ai.tool_calls else ROUND_LIMIT_TEXT

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

    async def daily_briefing(self, snapshot: dict[str, Any]) -> str | None:
        """Generate a concise advisor morning briefing from the daily market & portfolio snapshot."""
        async with self._lock:
            messages = [
                self._system(),
                HumanMessage(DAILY_BRIEF_PROMPT.format(snapshot=json.dumps(snapshot, default=str))),
            ]
            try:
                self._spend()
                ai = await asyncio.wait_for(self._model().ainvoke(messages), TURN_TIMEOUT_S)
            except _CapReached:
                return None
            except Exception:
                log.exception("daily briefing generation failed")
                return None
            return _text(ai.content) or None
