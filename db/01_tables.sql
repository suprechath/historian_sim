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

-- 4b. Batch Exceptions (Dedicated Out-of-Limit Process Deviations Table)
CREATE TABLE batch_exceptions (
  id             SERIAL PRIMARY KEY,
  batch_pk       INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  asset_id       INTEGER NOT NULL REFERENCES assets(id),
  tag_id         INTEGER NOT NULL REFERENCES tags(id),
  phase_name     TEXT,
  exception_type TEXT NOT NULL CHECK (exception_type IN ('HIGH_LIMIT', 'LOW_LIMIT', 'STATE_ALARM')),
  limit_value    NUMERIC(12,4) NOT NULL,
  peak_value     NUMERIC(12,4) NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  duration_sec   INTEGER,
  details        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_batch_exceptions_batch    ON batch_exceptions (batch_pk);
CREATE INDEX idx_batch_exceptions_asset_ts ON batch_exceptions (asset_id, started_at DESC);
CREATE INDEX idx_batch_exceptions_tag      ON batch_exceptions (tag_id);

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
  process_skip_asset TEXT,
  mode              TEXT NOT NULL DEFAULT 'continuous' CHECK (mode IN ('continuous', 'single')),
  assigned_batch_id TEXT,
  batch_command     TEXT,
  single_batch_status TEXT DEFAULT 'idle',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 13. Batch Queue (Single-Batch Sequential Train)
CREATE TABLE IF NOT EXISTS batch_queue (
  id SERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_queue',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_batch_queue_status ON batch_queue(status);

-- 14. Excluded Product Specifications (Skipped from Automatic Batch Queue)
CREATE TABLE IF NOT EXISTS excluded_product_specifications (
  product_specification_id TEXT PRIMARY KEY,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15. Integration Health Checks (On-Demand & 24/7 Heartbeat Audits)
CREATE TABLE IF NOT EXISTS integration_health_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type      TEXT NOT NULL CHECK (check_type IN ('on_demand', 'heartbeat')),
  batch_id        TEXT,
  instruction_id  TEXT,
  status          TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'degraded')),
  message         TEXT,
  latency_ms      INTEGER,
  details         JSONB,
  acknowledged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_checks_created_at ON integration_health_checks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_checks_type_created ON integration_health_checks (check_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_checks_batch_ack ON integration_health_checks (batch_id, check_type, acknowledged_at);

-- 16. Predefined Instruction Templates (Automated Batch Dispatch on Health Check Pass)
CREATE TABLE IF NOT EXISTS predefined_instruction_templates (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  instruction_id          TEXT,
  instruction_description TEXT NOT NULL,
  ref_instruction         TEXT NOT NULL,
  event_type              INTEGER NOT NULL CHECK (event_type IN (1, 2, 3)),
  ref_event               TEXT,
  ref_type                TEXT,
  ref_element             TEXT,
  ref_time                TEXT,
  ref_start_time          TEXT,
  ref_end_time            TEXT,
  expected_result         TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ref_instruction)
);
CREATE INDEX IF NOT EXISTS idx_predefined_templates_active ON predefined_instruction_templates (is_active);
CREATE INDEX IF NOT EXISTS idx_predefined_templates_ref ON predefined_instruction_templates (ref_instruction);

-- 11. Step-Triggered Instruction Templates (Layer-2 On-Demand Execution / Schedulers)
CREATE TABLE IF NOT EXISTS step_triggered_instruction_templates (
  id                          SERIAL PRIMARY KEY,
  name                        TEXT NOT NULL,                                              -- Descriptive name of the template
  trigger_instruction_id      TEXT NOT NULL,                                              -- BatchLine instruction ID/Ref that fires this trigger (e.g. 'CGET', 'HMI')
  time_source                 TEXT NOT NULL CHECK (time_source IN ('HISTORIAN_EVENT', 'PAYLOAD', 'STATIC')), -- Time sourcing mode

  -- Synthesized instruction attributes (returned to BatchLine)
  instruction_id              TEXT,                                                       -- Instruction ID (defaults to ref_instruction if NULL)
  instruction_description     TEXT NOT NULL,                                              -- Directives: '[RECORD]', '[PREVBATCH]', '[TIME: VALUE=130]', '[INTERPRET: ...]'
  ref_instruction             TEXT NOT NULL,                                              -- BatchLine target instruction code to update (e.g. 'PRESS', 'PREVB')
  event_type                  INTEGER NOT NULL CHECK (event_type IN (1, 2, 3)),           -- Case category: 1=PointInTime/PrevBatch, 2=PhaseTimestamp, 3=TimeRange/Profile
  ref_event                   TEXT,                                                       -- Recipe phase/event name (e.g. 'Charging', 'PreHeat')
  ref_type                    TEXT,                                                       -- Sub-type/aggregate: 'MAX', 'MIN', 'AVG', 'PROFILE', 'StartTime', 'EndTime'
  ref_element                 TEXT,                                                       -- Historian sensor/tag name (e.g. 'R1.TEMP', 'R1.FILTER_DP')
  ref_time                    TEXT,                                                       -- Static point-in-time timestamp (used if time_source = 'STATIC' for Case 1)
  ref_start_time              TEXT,                                                       -- Static window start timestamp (used if time_source = 'STATIC' for Case 3)
  ref_end_time                TEXT,                                                       -- Static window end timestamp (used if time_source = 'STATIC' for Case 3)
  expected_result             TEXT,                                                       -- Expected setpoint value or criteria
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,                              -- TRUE to enable evaluation, FALSE to disable

  -- Dynamic Historian Event Sourcing (time_source = 'HISTORIAN_EVENT')
  ref_start_event             TEXT,                                                       -- Phase name in 'events' table for start time (e.g. 'Charging')
  ref_start_type              TEXT DEFAULT 'StartTime' CHECK (ref_start_type IN ('StartTime', 'EndTime')), -- 'StartTime' (started_at) or 'EndTime' (ended_at)
  ref_end_event               TEXT,                                                       -- Phase name in 'events' table for end time (defaults to ref_start_event if NULL)
  ref_end_type                TEXT CHECK (ref_end_type IS NULL OR ref_end_type IN ('StartTime', 'EndTime')), -- 'StartTime', 'EndTime', or NULL

  -- Dynamic Webhook Payload Sourcing (time_source = 'PAYLOAD')
  payload_start_field         TEXT DEFAULT 'ActualResult',                                -- Field to read start timestamp ('ActualResult', 'ExecutedDate', 'RefStartTime')
  payload_end_field           TEXT,                                                       -- Field to read end timestamp ('RefEndTime', 'ActualResult[1]', or NULL)
  offset_duration_ms          INTEGER DEFAULT 0,                                          -- Offset in ms added to start time if payload_end_field is NULL

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trigger_instruction_id, ref_instruction)
);
CREATE INDEX IF NOT EXISTS idx_step_templates_trigger ON step_triggered_instruction_templates (trigger_instruction_id, is_active);
CREATE INDEX IF NOT EXISTS idx_step_templates_ref ON step_triggered_instruction_templates (ref_instruction);
