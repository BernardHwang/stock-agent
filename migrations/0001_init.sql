CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE once_keys (key TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE positions (code TEXT PRIMARY KEY, name TEXT NOT NULL, qty REAL NOT NULL, avg_cost REAL, updated_at TEXT NOT NULL);
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  state TEXT NOT NULL,
  action TEXT NOT NULL,
  entry_low REAL,
  entry_high REAL,
  partial_tp REAL,
  tp REAL,
  sl REAL,
  confidence TEXT NOT NULL,
  holding_months INTEGER NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fired TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX plans_state ON plans (state);
