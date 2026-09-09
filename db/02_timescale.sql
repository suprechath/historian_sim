-- Convert readings to Hypertable (7-day chunks)
SELECT create_hypertable('readings', 'ts', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX idx_readings_tag_ts ON readings (tag_id, ts DESC);

-- 1-Minute Continuous Aggregate
CREATE MATERIALIZED VIEW readings_1min
WITH (timescaledb.continuous) AS
SELECT
  tag_id,
  time_bucket(INTERVAL '1 minute', ts) AS bucket,
  avg(value)                           AS avg_value,
  min(value)                           AS min_value,
  max(value)                           AS max_value,
  count(*)                             AS sample_count,
  count(*) FILTER (WHERE quality = 0)  AS good_count
FROM readings
GROUP BY tag_id, bucket
WITH NO DATA;

-- Aggregation Refresh Policy
SELECT add_continuous_aggregate_policy('readings_1min',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- Compression & Retention Policies
ALTER TABLE readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'tag_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('readings', INTERVAL '7 days');
SELECT add_retention_policy('readings',      INTERVAL '90 days');
SELECT add_retention_policy('readings_1min', INTERVAL '2 years');