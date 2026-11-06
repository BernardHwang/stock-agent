import json
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path

from .models import ACTIVE_STATES, Alert, ChatMessage, Level, Note, Plan, PlanFields, PlanState, Position, QueueItem

SCHEMA = """
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, fields TEXT NOT NULL, state TEXT NOT NULL,
  created_at TEXT NOT NULL, fired TEXT NOT NULL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS plans_code ON plans(code, state);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, code TEXT, kind TEXT, plan_id INTEGER, price REAL, text TEXT);
CREATE TABLE IF NOT EXISTS positions (at TEXT NOT NULL, code TEXT NOT NULL, qty REAL, avg_cost REAL);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, reason TEXT NOT NULL, priority INTEGER NOT NULL,
  created_at TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (at TEXT NOT NULL, code TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outcomes (
  plan_id INTEGER PRIMARY KEY, first_hit TEXT, ret_4w REAL, ret_12w REAL, ret_26w REAL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS news_seen (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, at TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, code TEXT, text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
"""

_ACTIVE = tuple(s.value for s in ACTIVE_STATES)


class Store:
    """SQLite repository. Safe to share between the event loop and the analysis worker thread."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        self._db: sqlite3.Connection | None = None

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            raise RuntimeError("Store.init() not called")
        return self._db

    def init(self) -> None:
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(SCHEMA)

    def _exec(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur

    def _query(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.db.execute(sql, args).fetchall()

    # plans
    @staticmethod
    def _row_to_plan(r: sqlite3.Row) -> Plan:
        return Plan(
            id=r["id"], code=r["code"], fields=PlanFields.model_validate_json(r["fields"]),
            state=PlanState(r["state"]), created_at=datetime.fromisoformat(r["created_at"]),
            fired={Level(x) for x in json.loads(r["fired"])}, source=r["source"],
        )

    def save_plan(self, p: Plan) -> int:
        with self._lock:
            if p.state in ACTIVE_STATES and self.active_plan(p.code) is not None:
                raise ValueError(f"{p.code} already has an active plan")
            cur = self._exec(
                "INSERT INTO plans(code, fields, state, created_at, fired, source) VALUES (?,?,?,?,?,?)",
                (p.code, p.fields.model_dump_json(), p.state.value, p.created_at.isoformat(),
                 json.dumps(sorted(x.value for x in p.fired)), p.source),
            )
            assert cur.lastrowid is not None
            p.id = cur.lastrowid
            return cur.lastrowid

    def update_plan(self, p: Plan) -> None:
        self._exec(
            "UPDATE plans SET fields=?, state=?, fired=?, source=? WHERE id=?",
            (p.fields.model_dump_json(), p.state.value, json.dumps(sorted(x.value for x in p.fired)),
             p.source, p.id),
        )

    def get_plan(self, plan_id: int) -> Plan | None:
        rows = self._query("SELECT * FROM plans WHERE id=?", (plan_id,))
        return self._row_to_plan(rows[0]) if rows else None

    def active_plan(self, code: str) -> Plan | None:
        rows = self._query(
            f"SELECT * FROM plans WHERE code=? AND state IN ({','.join('?' * len(_ACTIVE))}) "
            "ORDER BY id DESC LIMIT 1", (code, *_ACTIVE))
        return self._row_to_plan(rows[0]) if rows else None

    def plans_in(self, states: set[PlanState]) -> list[Plan]:
        vals = tuple(s.value for s in states)
        rows = self._query(f"SELECT * FROM plans WHERE state IN ({','.join('?' * len(vals))}) ORDER BY id", vals)
        return [self._row_to_plan(r) for r in rows]

    def active_plans(self) -> list[Plan]:
        return self.plans_in(set(ACTIVE_STATES))

    def plans_created_since(self, since: datetime) -> list[Plan]:
        rows = self._query("SELECT * FROM plans WHERE created_at >= ? ORDER BY id", (since.isoformat(),))
        return [self._row_to_plan(r) for r in rows]

    def all_plans(self) -> list[Plan]:
        return [self._row_to_plan(r) for r in self._query("SELECT * FROM plans ORDER BY id")]

    # alerts
    def log_alert(self, a: Alert, at: datetime) -> None:
        self._exec("INSERT INTO alerts(at, code, kind, plan_id, price, text) VALUES (?,?,?,?,?,?)",
                   (at.isoformat(), a.code, a.kind, a.plan_id, a.price, a.text))

    def alerts_since(self, since: datetime) -> list[Alert]:
        rows = self._query("SELECT * FROM alerts WHERE at >= ? ORDER BY id", (since.isoformat(),))
        return [Alert(code=r["code"], kind=r["kind"], plan_id=r["plan_id"], price=r["price"], text=r["text"])
                for r in rows]

    # positions
    def save_positions(self, positions: list[Position], at: datetime) -> None:
        with self._lock:
            self.db.execute("DELETE FROM positions")
            self.db.executemany("INSERT INTO positions(at, code, qty, avg_cost) VALUES (?,?,?,?)",
                                [(at.isoformat(), p.code, p.qty, p.avg_cost) for p in positions])
            self.db.commit()

    def last_positions(self) -> list[Position]:
        return [Position(code=r["code"], qty=r["qty"], avg_cost=r["avg_cost"])
                for r in self._query("SELECT * FROM positions ORDER BY code")]

    # analysis queue
    @staticmethod
    def _row_to_item(r: sqlite3.Row) -> QueueItem:
        return QueueItem(id=r["id"], code=r["code"], reason=r["reason"], priority=r["priority"],
                         created_at=datetime.fromisoformat(r["created_at"]), status=r["status"])

    def enqueue(self, code: str, reason: str, priority: int, now: datetime) -> int:
        """Add work; if the ticker is already pending, keep one row with the more urgent priority."""
        with self._lock:
            rows = self._query("SELECT * FROM queue WHERE code=? AND status='pending'", (code,))
            if rows:
                r = rows[0]
                if priority < r["priority"]:
                    self._exec("UPDATE queue SET priority=?, reason=? WHERE id=?", (priority, reason, r["id"]))
                return int(r["id"])
            cur = self._exec("INSERT INTO queue(code, reason, priority, created_at, status) VALUES (?,?,?,?,?)",
                             (code, reason, priority, now.isoformat(), "pending"))
            assert cur.lastrowid is not None
            return cur.lastrowid

    def is_running(self, code: str) -> bool:
        return bool(self._query("SELECT 1 FROM queue WHERE code=? AND status='running'", (code,)))

    def next_queue_item(self) -> QueueItem | None:
        with self._lock:
            rows = self._query("SELECT * FROM queue WHERE status='pending' ORDER BY priority, id LIMIT 1")
            if not rows:
                return None
            self._exec("UPDATE queue SET status='running' WHERE id=?", (rows[0]["id"],))
            item = self._row_to_item(rows[0])
            item.status = "running"
            return item

    def finish_queue_item(self, item_id: int, status: str) -> None:
        self._exec("UPDATE queue SET status=? WHERE id=?", (status, item_id))

    def requeue(self, item_id: int) -> None:
        self.finish_queue_item(item_id, "pending")

    def reset_running(self) -> None:
        """On startup, anything left 'running' by a crash goes back to pending."""
        self._exec("UPDATE queue SET status='pending' WHERE status='running'")

    def pending_count(self) -> int:
        return int(self._query("SELECT COUNT(*) AS n FROM queue WHERE status='pending'")[0]["n"])

    def pending_items(self) -> list[QueueItem]:
        return [self._row_to_item(r)
                for r in self._query("SELECT * FROM queue WHERE status='pending' ORDER BY priority, id")]

    # AI run accounting
    def record_run(self, code: str, at: datetime) -> None:
        self._exec("INSERT INTO runs(at, code) VALUES (?,?)", (at.isoformat(), code))

    def count_runs_on(self, day: date) -> int:
        return int(self._query("SELECT COUNT(*) AS n FROM runs WHERE substr(at,1,10)=?",
                               (day.isoformat(),))[0]["n"])

    # outcomes
    def save_outcome(self, plan_id: int, first_hit: Level | None, ret_4w: float | None,
                     ret_12w: float | None, ret_26w: float | None) -> None:
        self._exec("INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?)",
                   (plan_id, first_hit.value if first_hit else None, ret_4w, ret_12w, ret_26w))

    def outcome(self, plan_id: int) -> dict | None:
        rows = self._query("SELECT * FROM outcomes WHERE plan_id=?", (plan_id,))
        return dict(rows[0]) if rows else None

    # misc
    def kv_get(self, key: str) -> str | None:
        rows = self._query("SELECT value FROM kv WHERE key=?", (key,))
        return rows[0]["value"] if rows else None

    def kv_set(self, key: str, value: str) -> None:
        self._exec("INSERT OR REPLACE INTO kv(key, value) VALUES (?,?)", (key, value))

    def seen_news(self, news_id: str) -> bool:
        return bool(self._query("SELECT 1 FROM news_seen WHERE id=?", (news_id,)))

    def mark_news(self, news_id: str) -> None:
        self._exec("INSERT OR IGNORE INTO news_seen(id) VALUES (?)", (news_id,))

    # chat memory
    def log_message(self, role: str, text: str, at: datetime) -> None:
        self._exec("INSERT INTO messages(at, role, text) VALUES (?,?,?)", (at.isoformat(), role, text))

    def recent_messages(self, limit: int) -> list[ChatMessage]:
        rows = self._query("SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,))
        return [ChatMessage(at=datetime.fromisoformat(r["at"]), role=r["role"], text=r["text"])
                for r in reversed(rows)]

    def add_note(self, code: str | None, text: str, at: datetime) -> int:
        cur = self._exec("INSERT INTO notes(at, code, text) VALUES (?,?,?)", (at.isoformat(), code, text))
        assert cur.lastrowid is not None
        return cur.lastrowid

    def notes(self, code: str | None, include_inactive: bool = False) -> list[Note]:
        where = "code IS NULL" if code is None else "code = ?"
        args: tuple = () if code is None else (code,)
        if not include_inactive:
            where += " AND active = 1"
        rows = self._query(f"SELECT * FROM notes WHERE {where} ORDER BY id", args)
        return [Note(id=r["id"], at=datetime.fromisoformat(r["at"]), code=r["code"], text=r["text"],
                     active=bool(r["active"])) for r in rows]

    def set_note_active(self, note_id: int, active: bool) -> bool:
        return self._exec("UPDATE notes SET active=? WHERE id=?", (int(active), note_id)).rowcount > 0

    def count_chat_call(self, day: date) -> int:
        with self._lock:
            n = self.chat_calls_on(day) + 1
            self.kv_set(f"chat_calls:{day.isoformat()}", str(n))
            return n

    def chat_calls_on(self, day: date) -> int:
        return int(self.kv_get(f"chat_calls:{day.isoformat()}") or 0)
