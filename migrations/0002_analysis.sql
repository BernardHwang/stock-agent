CREATE TABLE queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX queue_status ON queue (status, priority, created_at);
CREATE TABLE runs (code TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX runs_at ON runs (at);
CREATE TABLE reports (code TEXT PRIMARY KEY, at TEXT NOT NULL, price REAL, text TEXT NOT NULL);
