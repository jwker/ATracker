-- ATracker 数据库结构。迁移只往前加，不改历史文件。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- 服务和 CLI 可能同时写库。拿不到写锁时等 5 秒再报错，不要一碰就失败。
PRAGMA busy_timeout = 5000;

-- 用量明细。只追加，修正靠同一个 event_id 覆盖。
CREATE TABLE IF NOT EXISTS usage_event (
  event_id         TEXT PRIMARY KEY,
  agent            TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  parent_session_id TEXT,
  is_child         INTEGER NOT NULL DEFAULT 0,
  ts               INTEGER NOT NULL,
  local_day        TEXT NOT NULL,
  local_month      TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  model            TEXT NOT NULL,
  provider         TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny         REAL,
  cost_usd         REAL,
  cost_source      TEXT NOT NULL,
  thinking_level   TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_day    ON usage_event(local_day, agent);
CREATE INDEX IF NOT EXISTS idx_usage_month  ON usage_event(local_month);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_event(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts     ON usage_event(ts);

-- 每个源文件的解析进度和指纹。
CREATE TABLE IF NOT EXISTS file_cursor (
  path          TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  inode         INTEGER NOT NULL,
  offset        INTEGER NOT NULL DEFAULT 0,
  complete      INTEGER NOT NULL DEFAULT 0,
  last_scan_at  INTEGER NOT NULL,
  last_error    TEXT
);

-- 目录配色。颜色跟随实体，分配一次不再变。
CREATE TABLE IF NOT EXISTS dir_color (
  path        TEXT PRIMARY KEY,
  color       TEXT NOT NULL,
  assigned_at INTEGER NOT NULL
);

-- 会话元信息。标题各来源都有，字段位置不同。
CREATE TABLE IF NOT EXISTS session_title (
  agent      TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title      TEXT,
  cwd        TEXT,
  first_ts   INTEGER,
  last_ts    INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id)
);

-- 一次扫描一个批次。
CREATE TABLE IF NOT EXISTS scan_batch (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  files_total   INTEGER NOT NULL DEFAULT 0,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  events_read   INTEGER NOT NULL DEFAULT 0,
  events_written INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  trigger       TEXT NOT NULL
);

-- 日志行，保留最近 5000 条。
CREATE TABLE IF NOT EXISTS scan_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  level    TEXT NOT NULL,
  source   TEXT NOT NULL,
  message  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_log_batch ON scan_log(batch_id);
CREATE INDEX IF NOT EXISTS idx_scan_log_at    ON scan_log(at DESC);

-- 物化聚合。查询这些表，不扫明细。
CREATE TABLE IF NOT EXISTS agg_day_agent (
  day TEXT NOT NULL, agent TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_cny REAL, cost_usd REAL,
  PRIMARY KEY (day, agent)
);
CREATE TABLE IF NOT EXISTS agg_day_dir (
  day TEXT NOT NULL, dir TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_cny REAL, cost_usd REAL,
  PRIMARY KEY (day, dir)
);
CREATE TABLE IF NOT EXISTS agg_day_model (
  day TEXT NOT NULL, model TEXT NOT NULL, vendor TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_cny REAL, cost_usd REAL,
  PRIMARY KEY (day, model)
);
CREATE TABLE IF NOT EXISTS agg_day_agent_model (
  day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, vendor TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_cny REAL, cost_usd REAL,
  PRIMARY KEY (day, agent, model)
);

-- 累计一行。
CREATE TABLE IF NOT EXISTS agg_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_cny REAL, cost_usd REAL,
  unpriced_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
