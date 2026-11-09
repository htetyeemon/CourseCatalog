CREATE TABLE courses (
  id TEXT PRIMARY KEY CHECK (id GLOB 'crs_*'),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
  department TEXT NOT NULL CHECK (length(department) BETWEEN 1 AND 120),
  level TEXT NOT NULL CHECK (level IN ('introductory', 'intermediate', 'advanced')),
  credits INTEGER NOT NULL CHECK (credits BETWEEN 0 AND 30),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  summary TEXT CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 2000),
  tags TEXT CHECK (tags IS NULL OR json_valid(tags)),
  enrichment_source TEXT CHECK (enrichment_source IN ('ai', 'fallback')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE instructors (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ins_*'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  email TEXT NOT NULL UNIQUE,
  department TEXT NOT NULL CHECK (length(department) BETWEEN 1 AND 120),
  bio TEXT CHECK (bio IS NULL OR length(bio) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE course_instructors (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  instructor_id TEXT NOT NULL REFERENCES instructors(id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (course_id, instructor_id)
);

CREATE TABLE prerequisites (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  prerequisite_course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
  minimum_grade REAL CHECK (minimum_grade IS NULL OR minimum_grade BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (course_id, prerequisite_course_id),
  CHECK (course_id <> prerequisite_course_id)
);

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY CHECK (id GLOB 'whs_*'),
  url TEXT NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 2048),
  secret TEXT NOT NULL CHECK (length(secret) BETWEEN 32 AND 256),
  events TEXT NOT NULL CHECK (json_valid(events) AND json_array_length(events) >= 1),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY CHECK (id GLOB 'whd_*'),
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id TEXT NOT NULL CHECK (event_id GLOB 'evt_*'),
  event_type TEXT NOT NULL DEFAULT 'course.published' CHECK (event_type IN ('course.published')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  max_attempts INTEGER NOT NULL DEFAULT 6 CHECK (max_attempts = 6),
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (subscription_id, event_id)
);

CREATE VIRTUAL TABLE courses_fts USING fts5(
  title,
  description,
  tags,
  code,
  content = 'courses',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER courses_fts_ai AFTER INSERT ON courses BEGIN
  INSERT INTO courses_fts(rowid, title, description, tags, code)
  VALUES (new.rowid, new.title, new.description, new.tags, new.code);
END;

CREATE TRIGGER courses_fts_ad AFTER DELETE ON courses BEGIN
  INSERT INTO courses_fts(courses_fts, rowid, title, description, tags, code)
  VALUES ('delete', old.rowid, old.title, old.description, old.tags, old.code);
END;

CREATE TRIGGER courses_fts_au AFTER UPDATE ON courses BEGIN
  INSERT INTO courses_fts(courses_fts, rowid, title, description, tags, code)
  VALUES ('delete', old.rowid, old.title, old.description, old.tags, old.code);
  INSERT INTO courses_fts(rowid, title, description, tags, code)
  VALUES (new.rowid, new.title, new.description, new.tags, new.code);
END;

CREATE INDEX idx_courses_status ON courses(status);
CREATE INDEX idx_courses_department ON courses(department);
CREATE INDEX idx_courses_level ON courses(level);
CREATE INDEX idx_courses_title ON courses(title);
CREATE INDEX idx_courses_created_at ON courses(created_at);
CREATE INDEX idx_courses_updated_at ON courses(updated_at);
CREATE INDEX idx_courses_status_department_level ON courses(status, department, level);

CREATE INDEX idx_instructors_department ON instructors(department);
CREATE INDEX idx_instructors_display_name ON instructors(display_name);

CREATE INDEX idx_course_instructors_instructor_id ON course_instructors(instructor_id);

CREATE INDEX idx_prerequisites_prerequisite_course_id ON prerequisites(prerequisite_course_id);

CREATE INDEX idx_webhook_subscriptions_active ON webhook_subscriptions(active);

CREATE INDEX idx_webhook_deliveries_subscription_id ON webhook_deliveries(subscription_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX idx_webhook_deliveries_next_attempt_at ON webhook_deliveries(next_attempt_at);
CREATE INDEX idx_webhook_deliveries_event_id ON webhook_deliveries(event_id);
