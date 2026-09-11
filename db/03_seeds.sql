-- db/03_seeds.sql

-- 1. Assets (PRD Section 4.1)
INSERT INTO assets (code, display_name, asset_type, role, material, capacity_l) VALUES
  ('R1', 'Reactor 1 — Synthesis',    'Reactor', 'Runs the chemical reaction under nitrogen, with jacket heating and cooling',                         'Glass-lined steel',   5000),
  ('R2', 'Reactor 2 — Workup',       'Reactor', 'Neutralises the reaction mixture by reagent dosing to a target pH, separates phases, swaps solvent', 'Stainless steel 316L', 5000),
  ('R3', 'Reactor 3 — Crystalliser', 'Reactor', 'Dissolves the product then cools it under control to form crystals',                                 'Glass-lined steel',   3000);

-- 2. Tags (PRD Section 4.3)
INSERT INTO tags (
  name, asset_id, parameter, description, point_type, units,
  range_min, range_max, alarm_low, alarm_high, alarm_state_int,
  display_digits, is_cpp
)
SELECT
  t.name,
  a.id,
  t.parameter,
  t.description,
  t.point_type,
  t.units,
  t.range_min,
  t.range_max,
  t.alarm_low,
  t.alarm_high,
  t.alarm_state_int,
  t.display_digits,
  t.is_cpp
FROM (VALUES
  -- R1 Tags (8 tags)
  ('R1.TEMP',       'R1', 'TEMP',       'Product temperature',           'float',            'degC',   -20::numeric, 150::numeric, -10::numeric, 105::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R1.JKT_TEMP',   'R1', 'JKT_TEMP',   'Jacket inlet temperature',      'float',            'degC',   -25::numeric, 160::numeric, NULL::numeric, 120::numeric, NULL::smallint, 1::smallint, FALSE),
  ('R1.PRES',       'R1', 'PRES',       'Vessel pressure',               'float',            'bar g',   -1::numeric,   6::numeric, NULL::numeric, 4.5::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R1.AGIT',       'R1', 'AGIT',       'Agitator speed',                'float',            'rpm',      0::numeric, 200::numeric, NULL::numeric, 180::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R1.VOL',        'R1', 'VOL',        'Liquid volume',                 'float',            'L',        0::numeric,5000::numeric, NULL::numeric,4800::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R1.AGIT_RUN',   'R1', 'AGIT_RUN',   'Agitator state',                'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R1.JKT_MODE',   'R1', 'JKT_MODE',   'Jacket mode',                   'integer',          NULL,       0::numeric,   2::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R1.N2_BLANKET', 'R1', 'N2_BLANKET', 'Nitrogen blanket',              'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric,    0::smallint, 0::smallint, TRUE),

  -- R2 Tags (8 tags)
  ('R2.PH',         'R2', 'PH',         'Product pH',                    'float',            'pH',       0::numeric,  14::numeric, 1.5::numeric, 9.5::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R2.TEMP',       'R2', 'TEMP',       'Product temperature',           'float',            'degC',   -10::numeric, 120::numeric, NULL::numeric,  90::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R2.DOSE_FLOW',  'R2', 'DOSE_FLOW',  'Reagent dosing flow',           'float',            'L/h',      0::numeric, 500::numeric, NULL::numeric, 400::numeric, NULL::smallint, 1::smallint, FALSE),
  ('R2.DOSE_TOTAL', 'R2', 'DOSE_TOTAL', 'Reagent dosed this batch',      'float_calculated', 'L',        0::numeric,2000::numeric, NULL::numeric,1500::numeric, NULL::smallint, 1::smallint, TRUE),
  ('R2.VOL',        'R2', 'VOL',        'Liquid volume',                 'float',            'L',        0::numeric,5000::numeric, NULL::numeric,4800::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R2.AGIT_RUN',   'R2', 'AGIT_RUN',   'Agitator state',                'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R2.DOSE_PUMP',  'R2', 'DOSE_PUMP',  'Dosing pump',                   'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R2.N2_BLANKET', 'R2', 'N2_BLANKET', 'Nitrogen blanket',              'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),

  -- R3 Tags (8 tags)
  ('R3.TEMP',       'R3', 'TEMP',       'Product temperature',           'float',            'degC',   -20::numeric, 120::numeric, -15::numeric, 90::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R3.COOL_RATE',  'R3', 'COOL_RATE',  'Cooling rate (d TEMP / dt)',    'float_calculated', 'degC/h', -30::numeric,  30::numeric, -25::numeric,NULL::numeric, NULL::smallint, 1::smallint, TRUE),
  ('R3.AGIT',       'R3', 'AGIT',       'Agitator speed',                'float',            'rpm',      0::numeric, 150::numeric, NULL::numeric, 140::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R3.TURB',       'R3', 'TURB',       'Turbidity',                     'float',            'NTU',      0::numeric,1000::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R3.VOL',        'R3', 'VOL',        'Liquid volume',                 'float',            'L',        0::numeric,3000::numeric, NULL::numeric,2850::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R3.AGIT_RUN',   'R3', 'AGIT_RUN',   'Agitator state',                'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R3.COOL_RAMP',  'R3', 'COOL_RAMP',  'Cooling ramp',                  'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE),
  ('R3.SEEDED',     'R3', 'SEEDED',     'Seed crystals added',           'integer',          NULL,       0::numeric,   1::numeric, NULL::numeric, NULL::numeric, NULL::smallint, 0::smallint, FALSE)
) AS t(name, asset_code, parameter, description, point_type, units, range_min, range_max, alarm_low, alarm_high, alarm_state_int, display_digits, is_cpp)
JOIN assets a ON a.code = t.asset_code;

-- 2b. Tag State Labels (Normalized 3NF table for integer status tag states)
INSERT INTO tag_state_labels (tag_id, state_value, label)
SELECT t.id, s.state_value, s.label
FROM tags t
JOIN (VALUES
  ('R1.AGIT_RUN',   0::smallint, 'Stopped'),
  ('R1.AGIT_RUN',   1::smallint, 'Running'),
  ('R1.JKT_MODE',   0::smallint, 'Idle'),
  ('R1.JKT_MODE',   1::smallint, 'Heating'),
  ('R1.JKT_MODE',   2::smallint, 'Cooling'),
  ('R1.N2_BLANKET', 0::smallint, 'Lost'),
  ('R1.N2_BLANKET', 1::smallint, 'OK'),
  ('R2.AGIT_RUN',   0::smallint, 'Stopped'),
  ('R2.AGIT_RUN',   1::smallint, 'Running'),
  ('R2.DOSE_PUMP',  0::smallint, 'Off'),
  ('R2.DOSE_PUMP',  1::smallint, 'On'),
  ('R2.N2_BLANKET', 0::smallint, 'Lost'),
  ('R2.N2_BLANKET', 1::smallint, 'OK'),
  ('R3.AGIT_RUN',   0::smallint, 'Stopped'),
  ('R3.AGIT_RUN',   1::smallint, 'Running'),
  ('R3.COOL_RAMP',  0::smallint, 'Hold'),
  ('R3.COOL_RAMP',  1::smallint, 'Ramping'),
  ('R3.SEEDED',     0::smallint, 'No'),
  ('R3.SEEDED',     1::smallint, 'Yes')
) AS s(tag_name, state_value, label) ON t.name = s.tag_name;

-- 3. Snapshots (Initialize with offline/bad defaults)
INSERT INTO snapshots (tag_id, ts, value, quality)
SELECT id, now(), NULL, 2 FROM tags;