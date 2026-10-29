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
  -- R1 Tags (9 tags)
  ('R1.TEMP',       'R1', 'TEMP',       'Product temperature',           'float',            'degC',   -20::numeric, 170::numeric, 0::numeric, 145::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R1.JKT_TEMP',   'R1', 'JKT_TEMP',   'Jacket inlet temperature',      'float',            'degC',   -25::numeric, 180::numeric, NULL::numeric, 165::numeric, NULL::smallint, 1::smallint, FALSE),
  ('R1.PRES',       'R1', 'PRES',       'Vessel pressure',               'float',            'bar g',   -1::numeric,   6::numeric, NULL::numeric, 4.5::numeric, NULL::smallint, 2::smallint, TRUE),
  ('R1.FILTER_DP',  'R1', 'FILTER_DP',  'Filter pressure drop',          'float',            'bar',       0::numeric,   3::numeric, NULL::numeric, 1.5::numeric, NULL::smallint, 2::smallint, TRUE),
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
  ('R3.COOL_RATE',  'R3', 'COOL_RATE',  'Cooling rate (d TEMP / dt)',    'float_calculated', 'degC/h', -30::numeric,  30::numeric, -20::numeric,NULL::numeric, NULL::smallint, 1::smallint, TRUE),
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

-- 4. Simulation Control Plane (Default to active at 1x real-time speed in continuous mode)
INSERT INTO simulation_control (id, running, speed, mode)
VALUES (1, true, 1, 'continuous')
ON CONFLICT (id) DO UPDATE SET speed = 1;

-- 5. Default Predefined Instruction Templates (Layer-1 Batch-Start Schedulers)
INSERT INTO predefined_instruction_templates (
  name, instruction_id, instruction_description, 
  ref_instruction, event_type, ref_event, ref_type, 
  ref_element, ref_time, ref_start_time, ref_end_time, 
  expected_result, is_active
) VALUES
  ('R1 Charging Start Time', '1', 'Schedule the charging event time fetching [SCHEDULE]', 'CGST', 2, 'Charging', 'StartTime', NULL, NULL, NULL, NULL, NULL, TRUE),
  ('R1 Charging End Time (CGET)', '2', 'Schedule the charging event time fetching [SCHEDULE]', 'CGET', 2, 'Charging', 'EndTime', NULL, NULL, NULL, NULL, NULL, TRUE)
ON CONFLICT (ref_instruction) DO NOTHING;

-- 6. Default Step-Triggered Instruction Templates (Layer-2 On-Demand Step Schedulers)
--
-- Column Definitions & Possible Values:
--   1.  name                    TEXT NOT NULL      - Descriptive template label (e.g. 'Pressure curves of filter')
--   2.  trigger_instruction_id  TEXT NOT NULL      - BatchLine instruction that fires this trigger (e.g. 'CGET', 'HMI', 'STEP_PREHEAT_COMPLETE')
--   3.  time_source             TEXT NOT NULL      - Sourcing strategy: 'HISTORIAN_EVENT' | 'PAYLOAD' | 'STATIC'
--   4.  instruction_id          TEXT NULL          - Synthesized instruction ID to return (defaults to ref_instruction if NULL)
--   5.  instruction_description TEXT NOT NULL      - Directive/mode flags:
--                                                      '[RECORD]'                     -> Time-range continuous profile curve
--                                                      '[RECORD: START=.., STOP=..]'  -> Wave rise/fall search
--                                                      '[PREVBATCH]'                  -> Previous batch lookup
--                                                      '[TIME: VALUE=130]'            -> Milestone crossing point
--                                                      '[INTERPRET: 1=RUN, 0=STOP]'   -> Discrete state label mapping
--                                                      '[SCHEDULE]'                   -> Phase timestamp scheduler
--   6.  ref_instruction         TEXT NOT NULL      - Target instruction code to update in BatchLine (e.g. 'PRESS', 'PREVB', 'AGIT_STATE')
--   7.  event_type              INTEGER NOT NULL   - Case category:
--                                                      1 = Case 1 (Point-in-time / milestone / prev batch / interpret)
--                                                      2 = Case 2 (Phase StartTime / EndTime timestamp fetching)
--                                                      3 = Case 3 (Time range / profile curve / aggregates MIN, MAX, AVG)
--   8.  ref_event               TEXT NULL          - Recipe phase or event name (e.g. 'Charging', 'PreHeat', 'Heating')
--   9.  ref_type                TEXT NULL          - Aggregate or type specifier: 'MAX' | 'MIN' | 'AVG' | 'PROFILE' | 'StartTime' | 'EndTime' | NULL
--   10. ref_element             TEXT NULL          - Historian sensor tag name (e.g. 'R1.TEMP', 'R1.FILTER_DP', 'R1.AGIT_RUN')
--   11. ref_time                TEXT NULL          - Static point-in-time string (used if time_source = 'STATIC' for Case 1)
--   12. ref_start_time          TEXT NULL          - Static window start string (used if time_source = 'STATIC' for Case 3)
--   13. ref_end_time            TEXT NULL          - Static window end string (used if time_source = 'STATIC' for Case 3)
--   14. expected_result         TEXT NULL          - Expected value or setpoint criteria (e.g. '130', NULL)
--   15. is_active               BOOLEAN NOT NULL   - TRUE (active & evaluated) | FALSE (inactive/disabled)
--   16. ref_start_event         TEXT NULL          - For HISTORIAN_EVENT: phase name for start time (e.g. 'Charging', 'PreHeat')
--   17. ref_start_type          TEXT DEFAULT       - For HISTORIAN_EVENT: 'StartTime' (started_at) | 'EndTime' (ended_at)
--   18. ref_end_event           TEXT NULL          - For HISTORIAN_EVENT: phase name for end time (defaults to ref_start_event if NULL)
--   19. ref_end_type            TEXT NULL          - For HISTORIAN_EVENT: 'StartTime' | 'EndTime' | NULL (NULL for open-ended or point-in-time)
--   20. payload_start_field     TEXT DEFAULT       - For PAYLOAD: field to read start timestamp ('ActualResult' | 'ExecutedDate' | 'RefStartTime')
--   21. payload_end_field       TEXT NULL          - For PAYLOAD: field to read end timestamp ('RefEndTime' | 'ActualResult[1]' | NULL)
--   22. offset_duration_ms      INTEGER DEFAULT 0  - Time window offset in ms (added to start time if payload_end_field is NULL, e.g. 0, 60000)
--
INSERT INTO step_triggered_instruction_templates (
  name, trigger_instruction_id, time_source,
  instruction_id, instruction_description, ref_instruction,
  event_type, ref_event, ref_type, ref_element,
  ref_time, ref_start_time, ref_end_time, expected_result, is_active,
  ref_start_event, ref_start_type, ref_end_event, ref_end_type,
  payload_start_field, payload_end_field, offset_duration_ms
) VALUES
  (
    'Previous batch number in current line', 'HMI', 'STATIC',
    '1', '[PREVBATCH]', 'PREVB',
    1, NULL, NULL, 'R1.TEMP',
    NULL, NULL, NULL, NULL, TRUE,
    NULL, NULL, NULL, NULL,
    NULL, NULL, 0
  ),
  (
    'Pressure curves of filter', 'CGET', 'HISTORIAN_EVENT',
    '1', '[RECORD]', 'PRESS',
    3, NULL, 'MAX', 'R1.FILTER_DP',
    NULL, NULL, NULL, NULL, TRUE,
    'Charging', 'StartTime', 'Charging', 'EndTime',
    NULL, NULL, 0
  )
ON CONFLICT (trigger_instruction_id, ref_instruction) DO NOTHING;

-- 7. Excluded Product Specifications (Skipped from automatic queue assignment)
INSERT INTO excluded_product_specifications (product_specification_id)
VALUES ('Vistin_Metformin_HCl_auto')
ON CONFLICT (product_specification_id) DO NOTHING;