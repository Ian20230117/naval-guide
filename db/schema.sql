PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS readers(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thoughts(
  id INTEGER PRIMARY KEY, reader TEXT NOT NULL REFERENCES readers(id),
  excerpt_id TEXT NOT NULL, excerpt_json TEXT NOT NULL,
  created_at TEXT NOT NULL, day TEXT NOT NULL, daily INTEGER NOT NULL DEFAULT 0,
  request_key TEXT NOT NULL, UNIQUE(reader,excerpt_id), UNIQUE(reader,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_thought ON thoughts(reader,day) WHERE daily=1;
CREATE INDEX IF NOT EXISTS idx_thought_history ON thoughts(reader,day,id);
CREATE TABLE IF NOT EXISTS actions(
  id INTEGER PRIMARY KEY, thought_id INTEGER NOT NULL REFERENCES thoughts(id),
  reader TEXT NOT NULL REFERENCES readers(id), created_at TEXT NOT NULL,
  day TEXT NOT NULL, content_json TEXT NOT NULL, request_key TEXT NOT NULL,
  UNIQUE(reader,request_key)
);
CREATE INDEX IF NOT EXISTS idx_action_history ON actions(reader,day,id);
PRAGMA optimize;
