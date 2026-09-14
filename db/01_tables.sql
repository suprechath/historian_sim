CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. Assets (Plant Equipment)
CREATE TABLE assets (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  asset_type    TEXT NOT NULL DEFAULT 'Reactor',
  role          TEXT NOT NULL,
  material      TEXT NOT NULL,
  capacity_l    NUMERIC(10,1),
  parent_id     INTEGER REFERENCES assets(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Tags (Sensor & Instrument Definitions)
CREATE TABLE tags (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  asset_id        INTEGER NOT NULL REFERENCES assets(id),
  parameter       TEXT NOT NULL,
  description     TEXT NOT NULL,
  point_type      TEXT NOT NULL DEFAULT 'float'
                  CHECK (point_type IN ('float', 'float_calculated', 'integer')),
  units           TEXT,
  range_min       NUMERIC(12,4),
  range_max       NUMERIC(12,4),
  alarm_low       NUMERIC(12,4),
  alarm_high      NUMERIC(12,4),
  alarm_state_int SMALLINT,
  display_digits  SMALLINT NOT NULL DEFAULT 2,
  is_cpp          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, parameter)
);

-- 2b. Tag State Labels (Normalized 1:N discrete state enumeration for integer tags)
CREATE TABLE tag_state_labels (
  tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  state_value  SMALLINT NOT NULL,
  label        TEXT NOT NULL,
  PRIMARY KEY (tag_id, state_value)
);

-- 3. Batches (ISA-88 Batch Execution Header)
CREATE TABLE batches (
  id               SERIAL PRIMARY KEY,
  batch_id         TEXT NOT NULL UNIQUE,
  product_code     TEXT NOT NULL DEFAULT 'API-7734',
  recipe_version   TEXT NOT NULL DEFAULT 'v2.1',
  current_asset_id INTEGER REFERENCES assets(id),
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'Running'
                   CHECK (status IN ('Running','Completed','Aborted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_batches_time ON batches (started_at DESC);
CREATE INDEX idx_batches_current_asset ON batches (current_asset_id, status);

-- 4. Events (ISA-88 Unit Procedures, Phases, Alarms, and State Changes)
CREATE TABLE events (
  id          SERIAL PRIMARY KEY,
  batch_pk    INTEGER REFERENCES batches(id) ON DELETE CASCADE,
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  parent_id   INTEGER REFERENCES events(id) ON DELETE CASCADE,
  tag_id      INTEGER REFERENCES tags(id),
  name        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'Phase'
              CHECK (level IN ('Batch','Unit Procedure','Phase','Step','Alarm','StateChange','QualityChange')),
  occurrence  SMALLINT NOT NULL DEFAULT 1,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  details     JSONB
);
CREATE INDEX idx_events_batch    ON events (batch_pk);
CREATE INDEX idx_events_asset_ts ON events (asset_id, started_at DESC);
CREATE INDEX idx_events_lookup   ON events (batch_pk, name);
CREATE INDEX idx_events_parent   ON events (parent_id);
CREATE INDEX idx_events_tag      ON events (tag_id);

-- 5. Raw Readings (Time-series archive partitioned by TimescaleDB)
CREATE TABLE readings (
  tag_id   INTEGER NOT NULL REFERENCES tags(id),
  ts       TIMESTAMPTZ NOT NULL,
  value    DOUBLE PRECISION,
  quality  SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, ts)
);

-- 6. Snapshots (Current Value Cache)
CREATE TABLE snapshots (
  tag_id   INTEGER PRIMARY KEY REFERENCES tags(id),
  ts       TIMESTAMPTZ NOT NULL,
  value    DOUBLE PRECISION,
  quality  SMALLINT NOT NULL DEFAULT 0
);

-- 7. Monitoring Jobs (Outbound Periodic Sampling Jobs)
CREATE TABLE monitoring_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_pk      INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  interval_sec  INTEGER NOT NULL CHECK (interval_sec >= 5),
  kind          TEXT NOT NULL CHECK (kind IN ('fixed','manual')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_at        TIMESTAMPTZ,
  max_samples   INTEGER,
  next_fire_at  TIMESTAMPTZ NOT NULL,
  sequence      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'active'
                CHECK (state IN ('active','completed','cancelled','expired')),
  callback_ref  TEXT NOT NULL,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_due ON monitoring_jobs (next_fire_at) WHERE state = 'active';

-- 7b. Monitoring Job Tags (Normalized Many-to-Many junction table for 3NF compliance)
CREATE TABLE monitoring_job_tags (
  job_id   UUID NOT NULL REFERENCES monitoring_jobs(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, tag_id)
);

-- 8. Monitoring Outbox (Transactional Webhook Queue)
CREATE TABLE monitoring_outbox (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES monitoring_jobs(id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  sampled_at    TIMESTAMPTZ NOT NULL,
  payload       JSONB NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_status   INTEGER,
  last_error    TEXT,
  delivered_at  TIMESTAMPTZ,
  UNIQUE (job_id, sequence)
);
CREATE INDEX idx_outbox_pending ON monitoring_outbox (job_id, sequence) WHERE delivered_at IS NULL;

-- 9. Injected Faults (Simulation Chaos Engine)
CREATE TABLE injected_faults (
  id          SERIAL PRIMARY KEY,
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  kind        TEXT NOT NULL CHECK (kind IN ('stuck','drift','dropout','spike','quality','override')),
  magnitude   DOUBLE PRECISION,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at  TIMESTAMPTZ
);
CREATE INDEX idx_faults_active ON injected_faults (tag_id) WHERE cleared_at IS NULL;

-- 10. API Keys (Authentication)
CREATE TABLE api_keys (
  id            SERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

-- 11. Request Log (API Traffic Audit)
CREATE TABLE request_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_id   INTEGER REFERENCES api_keys(id),
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  query        TEXT,
  status       INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL
);
CREATE INDEX idx_request_log_ts ON request_log (ts DESC);

-- 12. Simulation Control Plane (Live Play/Pause & Speed Multiplier)
CREATE TABLE IF NOT EXISTS simulation_control (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  running           BOOLEAN NOT NULL DEFAULT true,
  speed             INTEGER NOT NULL DEFAULT 1 CHECK (speed >= 1 AND speed <= 3600),
  phase_skip_asset  TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);