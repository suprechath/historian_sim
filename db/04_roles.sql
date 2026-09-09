-- db/04_roles.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'grafana_reader') THEN
    CREATE USER grafana_reader WITH PASSWORD 'GrafanaReader123!';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE reactor TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
GRANT USAGE ON SCHEMA timescaledb_information TO grafana_reader;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA timescaledb_information TO grafana_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_reader;