CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer TEXT NOT NULL, item TEXT NOT NULL,
  amount REAL NOT NULL, status TEXT NOT NULL, city TEXT NOT NULL, created_at TEXT NOT NULL,
  latitude REAL, longitude REAL, location_updated_at TEXT, status_updated_at TEXT
);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, component TEXT NOT NULL, problem TEXT NOT NULL,
  stage TEXT NOT NULL, action TEXT NOT NULL, detected_at TEXT NOT NULL, recovered_at TEXT,
  injected_at TEXT, diagnosed_at TEXT, action_taken_at TEXT, detection_ms INTEGER,
  recovery_ms INTEGER, mechanism TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL,
  stage TEXT NOT NULL, occurred_at TEXT NOT NULL, details TEXT NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id)
);
