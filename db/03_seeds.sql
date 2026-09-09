INSERT INTO assets (code, display_name, capacity_l) VALUES
  ('R1', 'Reactor 1 — Primary synthesis',   5000),
  ('R2', 'Reactor 2 — Secondary synthesis', 5000),
  ('R3', 'Reactor 3 — Crystalliser',        3000);

INSERT INTO tags (name, asset_id, parameter, description, units,
                  range_min, range_max, alarm_low, alarm_high, display_digits)
SELECT
  a.code || '.' || p.parameter,
  a.id,
  p.parameter,
  p.description,
  p.units,
  p.range_min,
  CASE WHEN p.parameter = 'VOL' THEN a.capacity_l ELSE p.range_max END,
  p.alarm_low,
  CASE WHEN p.parameter = 'VOL' THEN a.capacity_l * 0.96 ELSE p.alarm_high END,
  p.display_digits
FROM assets a
CROSS JOIN (VALUES
  ('TEMP', 'Temperature',     'degC',  0,  150,  5::numeric, 105::numeric, 2),
  ('PRES', 'Pressure',        'barg',  0,   10, NULL::numeric, 7.5::numeric, 2),
  ('AGIT', 'Agitation speed', 'rpm',   0,  300, NULL::numeric, 250::numeric, 0),
  ('VOL',  'Liquid volume',   'L',     0, 5000, NULL::numeric, 4800::numeric, 0)
) AS p(parameter, description, units, range_min, range_max, alarm_low, alarm_high, display_digits);

-- Initialize snapshots table with offline/bad defaults
INSERT INTO snapshots (tag_id, ts, value, quality)
SELECT id, now(), NULL, 2 FROM tags;