CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Assets
CREATE TABLE assets (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  asset_type    TEXT NOT NULL DEFAULT 'Reactor',
  capacity_l    NUMERIC(10,1),
  parent_id     INTEGER REFERENCES assets(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tags
CREATE TABLE tags (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  asset_id       INTEGER NOT NULL REFERENCES assets(id),
  parameter      TEXT NOT NULL,
  description    TEXT NOT NULL,
  units          TEXT NOT NULL,
  range_min      NUMERIC(12,4) NOT NULL,
  range_max      NUMERIC(12,4) NOT NULL,
  alarm_low      NUMERIC(12,4),
  alarm_high     NUMERIC(12,4),
  display_digits SMALLINT NOT NULL DEFAULT 2,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, parameter)
);

-- Batches
CREATE TABLE batches (
  id          SERIAL PRIMARY KEY,
  batch_id    TEXT NOT NULL UNIQUE,
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'Running'
              CHECK (status IN ('Running','Completed','Aborted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_batches_asset_time ON batches (asset_id, started_at DESC);

-- Events
CREATE TABLE events (
  id          SERIAL PRIMARY KEY,
  batch_pk    INTEGER REFERENCES batches(id),
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  parent_id   INTEGER REFERENCES events(id),
  name        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'Phase'
              CHECK (level IN ('Batch','Operation','Phase','Step')),
  occurrence  SMALLINT NOT NULL DEFAULT 1,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  UNIQUE (batch_pk, name, occurrence)
);
CREATE INDEX idx_events_batch    ON events (batch_pk);
CREATE INDEX idx_events_asset_ts ON events (asset_id, started_at DESC);
CREATE INDEX idx_events_lookup   ON events (batch_pk, name);

-- Raw Readings
CREATE TABLE readings (
  tag_id   INTEGER NOT NULL REFERENCES tags(id),
  ts       TIMESTAMPTZ NOT NULL,
  value    DOUBLE PRECISION,
  quality  SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, ts)
);

-- Snapshots (Current Value Cache)
CREATE TABLE snapshots (
  tag_id   INTEGER PRIMARY KEY REFERENCES tags(id),
  ts       TIMESTAMPTZ NOT NULL,
  value    DOUBLE PRECISION,
  quality  SMALLINT NOT NULL DEFAULT 0
);

-- Monitoring Jobs & Outbox
CREATE TABLE monitoring_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      TEXT NOT NULL REFERENCES batches(batch_id),
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  tag_names     TEXT[] NOT NULL,
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

-- Injected Faults & API Keys
CREATE TABLE injected_faults (
  id          SERIAL PRIMARY KEY,
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  kind        TEXT NOT NULL CHECK (kind IN ('stuck','drift','dropout','spike')),
  magnitude   DOUBLE PRECISION,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at  TIMESTAMPTZ
);
CREATE INDEX idx_faults_active ON injected_faults (tag_id) WHERE cleared_at IS NULL;

CREATE TABLE api_keys (
  id            SERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

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