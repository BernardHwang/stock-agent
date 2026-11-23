"""Wires the components into one long-running asyncio service."""

import asyncio
import html
import logging
from collections.abc import Awaitable, Callable, Coroutine
from datetime import UTC, datetime, timedelta
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.base import BaseTrigger
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .analysis import AnalysisWorker, patch_openai_tool_call_content
from .bot import PRIORITY_CANDIDATE, PRIORITY_PLAN_CMD, BotCommands, build_bot, send, start_bot
from .chat import ChatEngine
from .chat_tools import ChatDeps, ChatToolbox
from .config import Settings, load_screener_rules, load_universe
from .health import Health
from .holdings import sync_holdings
from .lifecycle import expire_stale
from .messages import (
    format_daily_summary,
    format_health,
    format_info,
    format_level_alert,
    format_news_alert,
    format_weekly_summary,
    to_plain,
)
from .models import Alert, PlanState
from .moomoo_gw import MoomooGateway
from .news import is_major, poll_news, yf_news
from .outcomes import update_outcomes
from .pricefeed import PriceFeed, make_feed, yf_day_moves, yf_index_moves, yf_last_prices
from .rules import RuleEngine
from .screener import screen, yf_fetch
from .store import Store

log = logging.getLogger(__name__)

PRIORITY_URGENT = 0
PRIORITY_REVIEW = 2
LEVEL_KINDS = {"entry", "partial_tp", "tp", "sl", "expired"}


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class App:
    def __init__(self, settings: Settings, store: Store | None = None, gateway: Any = None,
                 feed: PriceFeed | None = None, sender: Callable[[str], Awaitable[None]] | None = None,
                 now: Callable[[], datetime] = _utcnow):
        self.settings, self.now = settings, now
        self.store = store or Store(settings.db_path)
        self.health = Health()
        self.rules = RuleEngine(self.store)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.gateway = gateway or MoomooGateway(settings.moomoo_host, settings.moomoo_port,
                                                settings.moomoo_security_firm, settings.markets, self.on_tick)
        self.feed = feed or make_feed(settings.price_source, self.gateway, self.on_tick, settings.poll_interval_s)
        self._sender = sender
        self._tasks: set[asyncio.Task] = set()
        self.worker = AnalysisWorker(settings, self.store, self.health, self.notify, now=now,
                                     price_fn=self.current_price, on_result=self.on_analysis_result)
        deps = ChatDeps(prices=self.prices, news=yf_news, market=yf_index_moves, sync_positions=self.holdings_sync,
                        queue_deep=self.queue_deep)
        self.chat = ChatEngine(settings, self.store, ChatToolbox(settings, self.store, deps, now), now=now)
        self.commands = BotCommands(settings.telegram_chat_id, self.store, self.status, self.kick_queue, now=now,
                                    chat=self.chat, queue_deep=self.queue_deep)

    # messaging
    async def notify(self, text: str) -> None:
        if self._sender is None:
            log.warning("no sender configured; dropping message")
            return
        try:
            await self._sender(text)
        except Exception:
            log.exception("failed to send Telegram message")
            return
        # Alerts join the chat history so the owner can reply "why?" to them.
        self.store.log_message("alert", to_plain(text), self.now())

    # chat
    def prices(self, codes: list[str]) -> dict[str, float]:
        """Blocking; live prices from moomoo, falling back to yfinance."""
        try:
            return self.gateway.snapshot(codes)
        except Exception:
            return yf_last_prices(codes)

    async def queue_deep(self, code: str) -> int:
        """Queue a chat-requested deep analysis; returns its queue position, or 0 if it is already running."""
        # Flagged separately because an existing queue row may keep its original reason (e.g. /plan).
        self.store.kv_set(f"chat_followup:{code}", "1")
        if self.store.is_running(code):
            return 0
        self.store.enqueue(code, "chat", PRIORITY_PLAN_CMD, self.now())
        position = next((i for i, it in enumerate(self.store.pending_items(), 1) if it.code == code), 1)
        await self.kick_queue()
        return position

    async def on_analysis_result(self, code: str, reason: str, text: str) -> None:
        key = f"chat_followup:{code}"
        if reason != "chat" and not self.store.kv_get(key):
            return
        self.store.kv_set(key, "")
        note = await self.chat.follow_up(code, text)
        if note:
            await self.notify(format_info(f"Update on {html.escape(code)}: {html.escape(note)}"))

    async def handle_alerts(self, alerts: list[Alert]) -> None:
        now = self.now()
        for a in alerts:
            self.store.log_alert(a, now)
            if a.kind in LEVEL_KINDS and a.plan_id is not None:
                plan = self.store.get_plan(a.plan_id)
                if plan is not None:
                    await self.notify(format_level_alert(a, plan, now, self.settings.tz))
                if a.kind == "sl":
                    self._enqueue_once_per_day(a.code, "sl", f"sl_review:{a.plan_id}")
            elif a.kind == "health":
                await self.notify(format_health(a.text))
            else:
                await self.notify(format_info(a.text))
        if alerts:
            await self.refresh_watch()

    def _enqueue_once_per_day(self, code: str, reason: str, key: str) -> bool:
        """Urgent re-reviews are capped at one per key per day so a flapping level can't burn the AI quota."""
        day_key = f"{key}:{self.now().date().isoformat()}"
        if self.store.kv_get(day_key):
            return False
        self.store.kv_set(day_key, "1")
        self.store.enqueue(code, reason, PRIORITY_URGENT, self.now())
        return True

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> None:
        assert self.loop is not None
        task = self.loop.create_task(coro)
        self._tasks.add(task)  # asyncio keeps only weak references to tasks
        task.add_done_callback(self._tasks.discard)

    # prices
    async def refresh_watch(self) -> None:
        try:
            failed = await asyncio.to_thread(self.feed.set_codes, self.rules.watched_codes())
        except Exception:
            log.exception("could not update price subscriptions")
            failed = {"(all)"}
        if failed:
            alert = self.health.problem("subscribe", "No live prices for " + ", ".join(sorted(failed))
                                        + ". Their alerts won't fire. Check quote permissions or switch "
                                          "PRICE_SOURCE=poll.")
            if alert:
                await self.notify(format_health(alert.text))
        elif self.health.resolved("subscribe"):
            await self.notify(format_info("Live prices are working for every watched ticker again."))

    def current_price(self, code: str) -> float | None:
        """Blocking; used by the analysis worker thread to sanity-check new levels."""
        try:
            return self.gateway.snapshot([code]).get(code)
        except Exception:
            return yf_last_prices([code]).get(code)

    def on_tick(self, code: str, price: float) -> None:
        """Called from the moomoo SDK thread."""
        loop = self.loop
        if loop is not None:
            loop.call_soon_threadsafe(self._spawn, self._tick(code, price))

    async def _tick(self, code: str, price: float) -> None:
        async def handle() -> None:
            alerts = self.rules.on_price(code, price, self.now())
            if alerts:
                await self.handle_alerts(alerts)
                if any(a.kind == "sl" for a in alerts):
                    await self.kick_queue()

        await self.run_job("price_alerts", handle)

    # jobs
    async def run_job(self, name: str, fn: Callable[[], Awaitable[Any]]) -> None:
        try:
            await fn()
        except Exception as exc:
            log.exception("job %s failed", name)
            alert = self.health.problem(f"job:{name}", f"Scheduled job {name} failed: {type(exc).__name__}")
            if alert:
                await self.notify(format_health(alert.text))
        else:
            self.health.resolved(f"job:{name}")

    async def kick_queue(self) -> None:
        if self.loop is not None:
            self._spawn(self.run_job("drain_queue", self.drain_queue))
        else:
            await self.run_job("drain_queue", self.drain_queue)

    async def drain_queue(self) -> None:
        await self.worker.drain()
        await self.refresh_watch()

    async def weekly_screen(self) -> None:
        s, now = self.settings, self.now()
        universe = load_universe(s.universe_path)
        exclude = {p.code for p in self.store.active_plans()}
        codes = await asyncio.to_thread(screen, universe, s.markets, load_screener_rules(s.screener_path),
                                        yf_fetch, s.max_candidates, exclude)
        for code in [*codes, *self.commands.watchlist()]:
            self.store.enqueue(code, "weekly", PRIORITY_CANDIDATE, now)
        self.store.kv_set("last_screen", now.isoformat(timespec="minutes"))
        await self.notify(format_info(f"Weekly screen picked {len(codes)} candidate(s): "
                                      f"{', '.join(codes) or 'none'}. Analyses are running now."))
        await self.kick_queue()

    async def holdings_review(self) -> None:
        for plan in self.store.plans_in({PlanState.HELD}):
            self.store.enqueue(plan.code, "review", PRIORITY_REVIEW, self.now())
        # Holdings whose first analysis failed or was invalid still have no plan: retry them weekly.
        for pos in self.store.last_positions():
            if self.store.active_plan(pos.code) is None:
                self.store.enqueue(pos.code, "new_holding", PRIORITY_REVIEW, self.now())
        await self.kick_queue()

    async def holdings_sync(self) -> None:
        try:
            positions = await asyncio.to_thread(self.gateway.positions)
        except Exception as exc:
            log.exception("reading moomoo positions failed")
            reason = str(exc)[:200] or type(exc).__name__
            alert = self.health.problem("holdings", f"Could not read moomoo positions: {reason}")
            if alert:
                await self.notify(format_health(alert.text))
            return
        if self.health.resolved("holdings"):
            await self.notify(format_info("Reading moomoo positions works again."))
        await self.handle_alerts(sync_holdings(self.store, positions, self.now()))
        await self.refresh_watch()
        if self.store.pending_count():
            await self.kick_queue()

    async def news_poll(self) -> None:
        held = [p.code for p in self.store.plans_in({PlanState.HELD})]
        if not held:
            return
        hits = await asyncio.to_thread(poll_news, self.store, held)
        for code, item in hits:
            queued = self._enqueue_once_per_day(code, "news", f"news_review:{code}")
            await self.notify(format_news_alert(code, item["title"], item.get("link"), self.now(), self.settings.tz,
                                                review_queued=queued))
        if hits:
            await self.kick_queue()

    async def expire_stale(self) -> None:
        for p in expire_stale(self.store, self.now()):
            await self.notify(format_info(f"Plan #{p.id} for {p.code} expired after 60 days without a buy."))
        await self.refresh_watch()

    async def outcomes(self) -> None:
        await asyncio.to_thread(update_outcomes, self.store)

    async def weekly_summary(self) -> None:
        since = self.now() - timedelta(weeks=26)
        rows = []
        for p in self.store.plans_created_since(since):
            assert p.id is not None
            o = self.store.outcome(p.id) or {}
            rows.append({"id": p.id, "code": p.code, "action": p.fields.action.value, "state": p.state.value,
                         "first_hit": o.get("first_hit"), "ret_4w": o.get("ret_4w"), "ret_12w": o.get("ret_12w"),
                         "ret_26w": o.get("ret_26w")})
        await self.notify(format_weekly_summary(rows))

    async def daily_summary(self) -> None:
        """Morning briefing after US market close: recap holdings/plans & auto-queue reviews on big moves."""
        positions = self.store.last_positions()
        plans = self.store.active_plans()
        codes = sorted({p.code for p in positions} | {p.code for p in plans})
        try:
            indices = await asyncio.to_thread(yf_index_moves)
        except Exception:
            indices = {}
        try:
            prices = await asyncio.to_thread(self.prices, codes) if codes else {}
        except Exception:
            prices = {}
        try:
            day_moves = await asyncio.to_thread(yf_day_moves, codes) if codes else {}
        except Exception:
            day_moves = {}

        auto_queued: list[str] = []
        holdings_rows: list[dict[str, Any]] = []
        for pos in positions:
            price = prices.get(pos.code)
            day_move = day_moves.get(pos.code)
            plan = self.store.active_plan(pos.code)
            try:
                news_items = await asyncio.to_thread(yf_news, pos.code)
            except Exception:
                news_items = []
            headlines = [i["title"] for i in news_items[:3]]
            has_major_news = any(is_major(t) for t in headlines)
            big_move = day_move is not None and abs(day_move) >= self.settings.daily_move_pct
            if (big_move or has_major_news) and self._enqueue_once_per_day(
                pos.code, "daily_move", f"daily_review:{pos.code}"
            ):
                auto_queued.append(pos.code)
            holdings_rows.append({
                "code": pos.code,
                "qty": pos.qty,
                "avg_cost": pos.avg_cost,
                "price": price,
                "day_move_pct": round(day_move * 100, 1) if day_move is not None else None,
                "pnl_pct": round((price / pos.avg_cost - 1) * 100, 1) if price and pos.avg_cost else None,
                "tp": plan.fields.tp if plan else None,
                "sl": plan.fields.sl if plan else None,
                "headlines": headlines,
            })

        open_plans = [
            {
                "code": p.code,
                "state": p.state.value,
                "price": prices.get(p.code),
                "day_move_pct": round(day_moves[p.code] * 100, 1) if p.code in day_moves else None,
                "entry_low": p.fields.entry_low,
                "entry_high": p.fields.entry_high,
                "tp": p.fields.tp,
                "sl": p.fields.sl,
            }
            for p in plans
            if p.state != PlanState.HELD
        ]
        snapshot: dict[str, Any] = {
            "indices": indices,
            "holdings": holdings_rows,
            "open_plans": open_plans,
            "watchlist": self.commands.watchlist(),
            "auto_queued_reviews": auto_queued,
        }
        briefing = await self.chat.daily_briefing(snapshot)
        await self.notify(format_daily_summary(snapshot, briefing))
        if auto_queued:
            await self.kick_queue()

    async def opend_health(self) -> None:
        reason = await asyncio.to_thread(self.gateway.health_check)
        if reason:
            alert = self.health.problem("opend", reason)
            if alert:
                await self.notify(format_health(alert.text + " Live prices and holdings sync are paused."))
        else:
            recovered = self.health.resolved("opend")
            if recovered:
                await self.notify(format_info(recovered.text))
                await self.refresh_watch()

    def status(self) -> dict:
        problems = self.health.snapshot()
        return {
            "opend": "problem" if any(p.startswith("opend") for p in problems) else "ok",
            "ai_runs_today": self.store.count_runs_on(self.now().date()),
            "max_runs_per_day": self.settings.max_runs_per_day,
            "queue": self.store.pending_count(),
            "last_screen": self.store.kv_get("last_screen"),
            "watching": len(self.rules.watched_codes()),
            "problems": problems,
        }

    def jobs(self) -> list[tuple[str, BaseTrigger]]:
        tz = self.settings.tz
        return [
            ("weekly_screen", CronTrigger(day_of_week="sun", hour=10, timezone=tz)),
            ("holdings_review", CronTrigger(day_of_week="mon", hour=20, timezone=tz)),
            ("daily_summary", CronTrigger(day_of_week="tue-sat", hour=8, minute=30, timezone=tz)),
            ("drain_queue", IntervalTrigger(minutes=30, timezone=tz)),
            ("holdings_sync", IntervalTrigger(minutes=15, timezone=tz)),
            ("news_poll", IntervalTrigger(minutes=30, timezone=tz)),
            ("expire_stale", CronTrigger(hour=7, timezone=tz)),
            ("outcomes", CronTrigger(hour=7, minute=30, timezone=tz)),
            ("weekly_summary", CronTrigger(day_of_week="sun", hour=21, timezone=tz)),
            ("opend_health", IntervalTrigger(minutes=5, timezone=tz)),
        ]

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.store.init()
        self.store.reset_running()
        tg = build_bot(self.settings.telegram_bot_token.get_secret_value(), self.commands)
        self._sender = lambda text: send(tg, self.settings.telegram_chat_id, text)

        if hasattr(self.gateway, "connect"):
            try:
                await asyncio.to_thread(self.gateway.connect)
            except Exception as exc:
                log.exception("OpenD connect failed")
                self.health.problem("opend", f"Cannot connect to OpenD ({type(exc).__name__})")

        scheduler = AsyncIOScheduler(timezone=self.settings.tz)
        for name, trigger in self.jobs():
            scheduler.add_job(self.run_job, trigger, args=[name, getattr(self, name)], id=name,
                              max_instances=1, coalesce=True, misfire_grace_time=3600)

        async with tg:
            await start_bot(tg)
            await self.feed.start()
            scheduler.start()
            await self.notify(format_info("Stock agent started. Send /help for commands."))
            await self.run_job("opend_health", self.opend_health)
            await self.run_job("holdings_sync", self.holdings_sync)
            await self.refresh_watch()
            try:
                await asyncio.Event().wait()
            finally:
                scheduler.shutdown(wait=False)
                await self.feed.stop()
                await tg.updater.stop()
                await tg.stop()
                if hasattr(self.gateway, "close"):
                    self.gateway.close()


def main() -> None:
    from dotenv import load_dotenv

    load_dotenv()  # also exports provider API keys (GOOGLE_API_KEY, ...) for TradingAgents
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # its request lines include the bot token
    settings = Settings()
    patch_openai_tool_call_content()
    try:
        asyncio.run(App(settings).run())
    except KeyboardInterrupt:
        pass
