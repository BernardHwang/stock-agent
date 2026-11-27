CREATE TABLE consensus (code TEXT PRIMARY KEY, rating REAL, average REAL, at TEXT NOT NULL);
CREATE TABLE outcomes (plan_id INTEGER PRIMARY KEY, first_hit TEXT, ret_4w REAL, ret_12w REAL, ret_26w REAL, at TEXT NOT NULL);
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  plan_id INTEGER NOT NULL UNIQUE,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX lessons_code ON lessons (code, id);
