export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const markitMigrations: Migration[] = [
  {
    version: 1,
    name: 'initial_markit_schema',
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  current_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  viewport_json TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  runtime_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  viewport_json TEXT NOT NULL,
  scroll_x REAL NOT NULL,
  scroll_y REAL NOT NULL,
  mode TEXT NOT NULL,
  screenshot_path TEXT NOT NULL,
  dom_targets_path TEXT NOT NULL,
  image_width REAL NOT NULL,
  image_height REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  geometry_json TEXT NOT NULL,
  target_json TEXT,
  note TEXT NOT NULL DEFAULT '',
  color_role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  actual TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  source_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  primary_capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  export_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bug_annotations (
  bug_id TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (bug_id, annotation_id)
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bug_id TEXT REFERENCES bugs(id) ON DELETE SET NULL,
  capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  trace_path TEXT NOT NULL,
  latency_ms INTEGER,
  schema_valid INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_captures_session_id ON captures(session_id);
CREATE INDEX IF NOT EXISTS idx_annotations_capture_id ON annotations(capture_id);
CREATE INDEX IF NOT EXISTS idx_bugs_session_id ON bugs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_session_id ON ai_jobs(session_id);
`
  }
];
