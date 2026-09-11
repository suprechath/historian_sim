# Product requirements: Reactor process historian simulator

**Version** 0.2 (draft for UI design — API manufacturing revision)
**Date** 11 September 2026
**Supersedes** v0.1, 8 September 2026
**Purpose of this document** Provide enough product and data context for a designer to produce screen mockups. Backend implementation detail is deliberately summarised. Appendix B lists what changed from v0.1.

---

## 1. Summary

A simulated manufacturing process historian, modelled on AVEVA PI System, covering the three reactor vessels of one synthesis stage in a small-molecule API (active pharmaceutical ingredient) plant. The system generates synthetic process data continuously, stores it as a time-series archive, presents it on a monitoring dashboard, and exposes it to external systems through a REST API.

It is **not** connected to physical equipment. All values are produced by a simulation engine. The product exists so that integration teams can build and validate against a PI-like data source without needing access to a real plant or a real PI installation, and so that the product can be demonstrated to pharmaceutical customers with a credible plant-floor story.

The primary external consumer is **BatchLine**, an electronic batch record (EBR) system that pulls process values into batch documentation.

---

## 2. Users

| User | Goal | Primary screens |
|---|---|---|
| **Integration developer** | Build and debug BatchLine's connection to the historian. Needs to see what data exists, call endpoints, and inspect what was returned. | API explorer, tag browser, batch history |
| **Validation / QA engineer** | Confirm that a value pulled into a batch record matches the archive. Needs traceability from an EBR field back to a timestamped reading. | Batch history, trend explorer, monitoring log |
| **Demo presenter** | Show a convincing live plant-floor monitoring view to pharmaceutical stakeholders. | Plant overview, reactor detail |
| **Simulation operator** | Drive the simulator into specific conditions for testing: force an alarm, inject a sensor fault, reseed history. | Simulation control |

The integration developer is the primary user. The dashboard needs to look credible to a pharma audience, but its job is diagnostic rather than operational.

---

## 3. Scope

### Process scope

The simulator represents the **final synthesis stage** of a small-molecule API, from chemical reaction through workup to crystallisation. A real API route consists of several such stages (typically 3 to 8), each following the same pattern; upstream stages and the downstream isolation train (centrifuge, dryer, mill) are out of scope. This framing should appear on the Plant overview so that a pharmaceutical reviewer immediately understands what is and is not represented.

```
        ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
        │  R1          │     │  R2          │     │  R3          │      centrifuge
 ──────▶│  Synthesis   │────▶│  Workup      │────▶│  Crystalliser│─ ─ ─▶ dryer      (out of scope)
        │  5,000 L     │     │  5,000 L     │     │  3,000 L     │      mill
        └──────────────┘     └──────────────┘     └──────────────┘
```

### In scope
- Three specialised reactor vessels with reactor-specific tag sets: 25 tags total (16 numeric values, 9 integer status tags)
- One batch flowing through the train R1 → R2 → R3, modelled as one batch with three nested unit procedures
- Continuous simulation with reactor-specific phase progression
- Time-series archive with configurable retention
- Live dashboard with reactor selection and trend charts
- Batch and event browser
- REST API for external data extraction
- Outbound periodic sampling to a configured callback
- Fault injection and history reseeding

### Out of scope
- Any connection to real instrumentation, PLCs, or SCADA
- User accounts, roles, or permissions (single trusted operator assumed)
- Compliance features: audit trail, electronic signatures, reason-for-change, alarm acknowledgement workflows, or operator sign-off. These are deferred beyond the MVP; nothing in the current design should preclude adding them later.
- Control actions (the dashboard is read-only; setpoints are driven by the simulation, not the user)
- Upstream synthesis stages and downstream isolation and drying equipment
- Mobile-first layouts (desktop 1440px is the design target; tablet is a nice-to-have)
- General-purpose BI, ad-hoc charting, or SQL console features. A separate Grafana instance and a read-only database role cover these needs.

---

## 4. Domain model

### 4.1 Assets

Three reactors, each with a distinct role, construction, and tag set.

| Asset | Display name | Role | Material | Capacity |
|---|---|---|---|---|
| `R1` | Reactor 1 — Synthesis | Runs the chemical reaction under nitrogen, with jacket heating and cooling | Glass-lined steel | 5,000 L |
| `R2` | Reactor 2 — Workup | Neutralises the reaction mixture by reagent dosing to a target pH, separates phases, swaps solvent | Stainless steel 316L | 5,000 L |
| `R3` | Reactor 3 — Crystalliser | Dissolves the product then cools it under control to form crystals | Glass-lined steel | 3,000 L |

### 4.2 Tag model

Tag names follow `{asset}.{parameter}`. There are two point types. The UI must treat them differently everywhere they appear.

| Point type | Storage | Archiving | Alarms | Rendering |
|---|---|---|---|---|
| **Float** | Numeric, fixed display digits | Every archive tick (5 s) | Low and/or high limit | Line chart, sparkline, numeric tile |
| **Float, calculated** | As Float, but derived from other tags each simulation tick rather than simulated as a sensor | Every archive tick | Low and/or high limit | As Float, with a small "calculated" marker |
| **Integer (enumerated)** | Integer state index, 0 display digits, no units | On change of state only | Optional: a designated alarm state | Step line or state band, text label on tiles |

All tags, including status tags, are stored and returned by the API as numbers. Labels for integer states are UI metadata only (see 4.4); the archive, API responses, and CSV export return the integer.

Every tag carries a **CPP flag** (Critical Process Parameter). CPP tags are those a pharmaceutical batch record would extract as evidence that the batch was run correctly. The flag is metadata: it drives a badge on tiles and a filter on the Batch detail summary and tag tree, and has no effect on simulation or alarming.

### 4.3 Tags

**R1 — Synthesis** (9 tags: 6 float, 3 integer)

| Tag | Description | Type | Units | Range | Typical | Alarm lo | Alarm hi | Digits | CPP |
|---|---|---|---|---|---|---|---|---|---|
| `R1.TEMP` | Product temperature | Float | °C | −20 – 150 | 20 – 95 | −10 | 105 | 2 | Yes |
| `R1.TEMP_SP` | Product temperature setpoint | Float | °C | −20 – 150 | 20 – 95 | — | — | 2 | Yes |
| `R1.JKT_TEMP` | Jacket inlet temperature | Float | °C | −25 – 160 | 10 – 110 | — | 120 | 1 | — |
| `R1.PRES` | Vessel pressure | Float | bar g | −1 – 6 | −0.9 – 3.5 | — | 4.5 | 2 | Yes |
| `R1.AGIT` | Agitator speed | Float | rpm | 0 – 200 | 0 – 150 | — | 180 | 0 | — |
| `R1.VOL` | Liquid volume | Float | L | 0 – 5,000 | 0 – 4,200 | — | 4,800 | 0 | — |
| `R1.AGIT_RUN` | Agitator state | Integer | — | 0 – 1 | | | | 0 | — |
| `R1.JKT_MODE` | Jacket mode | Integer | — | 0 – 2 | | | | 0 | — |
| `R1.N2_BLANKET` | Nitrogen blanket | Integer | — | 0 – 1 | | alarm when 0 | | 0 | Yes |

**R2 — Workup** (8 tags: 5 float, 3 integer)

| Tag | Description | Type | Units | Range | Typical | Alarm lo | Alarm hi | Digits | CPP |
|---|---|---|---|---|---|---|---|---|---|
| `R2.PH` | Product pH | Float | pH | 0 – 14 | 2 – 9 | 1.5 | 9.5 | 2 | Yes |
| `R2.TEMP` | Product temperature | Float | °C | −10 – 120 | 15 – 80 | — | 90 | 2 | Yes |
| `R2.DOSE_FLOW` | Reagent dosing flow | Float | L/h | 0 – 500 | 0 – 300 | — | 400 | 1 | — |
| `R2.DOSE_TOTAL` | Reagent dosed this batch | Float, calculated | L | 0 – 2,000 | 0 – 1,200 | — | 1,500 | 1 | Yes |
| `R2.VOL` | Liquid volume | Float | L | 0 – 5,000 | 0 – 4,500 | — | 4,800 | 0 | — |
| `R2.AGIT_RUN` | Agitator state | Integer | — | 0 – 1 | | | | 0 | — |
| `R2.DOSE_PUMP` | Dosing pump | Integer | — | 0 – 1 | | | | 0 | — |
| `R2.N2_BLANKET` | Nitrogen blanket | Integer | — | 0 – 1 | | | | 0 | — |

**R3 — Crystalliser** (8 tags: 5 float, 3 integer)

| Tag | Description | Type | Units | Range | Typical | Alarm lo | Alarm hi | Digits | CPP |
|---|---|---|---|---|---|---|---|---|---|
| `R3.TEMP` | Product temperature | Float | °C | −20 – 120 | 0 – 80 | −15 | 90 | 2 | Yes |
| `R3.COOL_RATE` | Cooling rate (d TEMP / dt) | Float, calculated | °C/h | −30 – 30 | −20 – 0 | −25 | — | 1 | Yes |
| `R3.AGIT` | Agitator speed | Float | rpm | 0 – 150 | 40 – 120 | — | 140 | 0 | — |
| `R3.TURB` | Turbidity | Float | NTU | 0 – 1,000 | 0 – 800 | — | — | 0 | — |
| `R3.VOL` | Liquid volume | Float | L | 0 – 3,000 | 0 – 2,600 | — | 2,850 | 0 | — |
| `R3.AGIT_RUN` | Agitator state | Integer | — | 0 – 1 | | | | 0 | — |
| `R3.COOL_RAMP` | Cooling ramp | Integer | — | 0 – 1 | | | | 0 | — |
| `R3.SEEDED` | Seed crystals added | Integer | — | 0 – 1 | | | | 0 | — |

`TEMP`, `VOL`, and `AGIT_RUN` exist on every reactor so that the overview cards and vessel illustrations are structurally consistent. The remaining tags give each reactor its character.

### 4.4 Integer state labels

Convention: **1 always means the active or healthy state, 0 the inactive or failed state.** `JKT_MODE` is the only three-state tag.

| Tag | 0 | 1 | 2 |
|---|---|---|---|
| `R1.AGIT_RUN`, `R2.AGIT_RUN`, `R3.AGIT_RUN` | Stopped | Running | |
| `R1.JKT_MODE` | Idle | Heating | Cooling |
| `R1.N2_BLANKET`, `R2.N2_BLANKET` | Lost | OK | |
| `R2.DOSE_PUMP` | Off | On | |
| `R3.COOL_RAMP` | Hold | Ramping | |
| `R3.SEEDED` | No | Yes | |

The UI shows the label wherever a human reads the value (tiles, timelines, event feed, tooltips) and the integer wherever the value is being verified against the API (Trend explorer data table, CSV export, API explorer).

### 4.5 Alarms

Float tags alarm when the value crosses a configured low or high limit and return to normal when it crosses back. Integer tags do not have limits; a tag may designate one state as its alarm state. In this version only `R1.N2_BLANKET` does so (alarm when value = 0, i.e. nitrogen blanket lost during synthesis). Each alarm activation and clearance is an event (see 4.7).

### 4.6 Quality

Every reading carries a quality flag. The UI must distinguish these visually — this is not decoration, it determines whether a value may be used in a batch record.

| Quality | Meaning | Suggested treatment |
|---|---|---|
| `Good` | Normal | Default styling |
| `Questionable` | Value present but suspect (drift detected) | Amber marker, value still shown |
| `Bad` | Sensor fault, value not trustworthy | Value replaced with an em dash, red marker |
| `Substituted` | Value manually overridden | Value shown with a distinguishing marker |

Quality applies to integer tags as well: a stuck or dropped-out status sensor produces `Bad` quality, and the state band on charts must show a gap rather than the last known state.

### 4.7 Batches, unit procedures, phases, and events

**One batch flows through the whole train.** A batch begins when material is charged to R1 and ends when the crystallised slurry is transferred out of R3. Within the batch, each reactor's work is a **unit procedure**, and each unit procedure consists of **phases**. This is the ISA-88 hierarchy that EBR systems use, and it maps onto the three-level event nesting already required by the screens.

```
Batch B-2026-0142  (product API-7734, recipe v2.1)
├── Unit procedure R1 — Synthesis
│   ├── Charging
│   ├── Heating
│   ├── Reaction hold
│   ├── Cooling
│   └── Transfer
├── Unit procedure R2 — Workup
│   ├── Receive
│   ├── pH adjust
│   ├── Settle & separate
│   ├── Solvent swap
│   └── Transfer
└── Unit procedure R3 — Crystallisation
    ├── Receive
    ├── Heat to dissolve
    ├── Cooling ramp
    ├── Age
    └── Transfer
```

**Batch header fields** batch ID (`B-2026-0142`: year, then sequence), product code, recipe version, status (`Running` / `Completed` / `Aborted`), start, end, duration. Product code and recipe version are constant across the seeded history unless campaigns are later introduced (see open questions).

**Staggering.** R1 starts the next batch as soon as it has transferred, cleaned, and idled, while R2 is still working on the previous batch and R3 on the one before that. At any moment the three reactors are therefore typically on three consecutive batch IDs, and the overview always shows a mix of states. A reactor's `Transfer` phase and the downstream reactor's `Receive` phase are the same time window seen from two vessels.

**Events.** Every unit procedure start/end, phase start/end, alarm activation/clearance, integer-tag state change, and quality change is an event with a start time and an end time (`null` while running). Phase events nest under unit procedures, which nest under the batch.

### 4.8 Reactor-specific phases

All three reactors share `Idle` and `Clean` between batches. `Charging` (R1) and `Receive` (R2, R3) are equivalent entry phases; `Transfer` is the shared exit phase. Each reactor has one signature phase in the middle (Reaction hold, pH adjust, Cooling ramp). Phase colours should be identical for the shared phases across reactors.

**R1 — Synthesis**

| Phase | Typical duration | Behaviour |
|---|---|---|
| `Idle` | 5 – 120 min | Everything at rest. `VOL` 0, `AGIT_RUN` 0, `JKT_MODE` 0, `TEMP` drifting to ambient (~22 °C). `N2_BLANKET` 1. |
| `Charging` | 20 – 40 min | `VOL` ramps to 3,600 – 4,200 L. `AGIT_RUN` → 1 once `VOL` > 800 L; `AGIT` 60 – 80 rpm. |
| `Heating` | 45 – 90 min | `TEMP_SP` steps to 80 – 90 °C. `JKT_MODE` 1, `JKT_TEMP` runs 10 – 20 °C above `TEMP`. `TEMP` follows with lag, overshoots by 1 – 3 °C. `PRES` rises 0 → 1.5 – 3.5 bar g. `AGIT` steps to 120 – 150 rpm. |
| `Reaction hold` | 2 – 6 h | `TEMP` oscillates ±0.5 °C about `TEMP_SP`; `JKT_MODE` alternates 1/2 in short bursts. `PRES` slowly rises then plateaus. |
| `Cooling` | 60 – 120 min | `TEMP_SP` steps to 20 – 30 °C. `JKT_MODE` 2, `JKT_TEMP` well below `TEMP`. `TEMP` and `PRES` fall. |
| `Transfer` | 20 – 40 min | `VOL` ramps to 0. `AGIT` reduces; `AGIT_RUN` → 0 when `VOL` < 500 L. Coincides with R2 `Receive`. |
| `Clean` | 30 – 60 min | `VOL` partial (1,500 – 2,500 L), `TEMP` 60 – 80 °C, `AGIT` 150 – 180 rpm, then drain. |

**R2 — Workup**

| Phase | Typical duration | Behaviour |
|---|---|---|
| `Idle` | 5 – 120 min | Everything at rest. `DOSE_TOTAL` reset to 0 at the start of the next `Receive`. |
| `Receive` | 20 – 40 min | `VOL` ramps up from R1's transfer. `AGIT_RUN` → 1. `PH` reads the incoming mixture (2 – 3). `TEMP` 25 – 45 °C. |
| `pH adjust` | 45 – 90 min | `DOSE_PUMP` 1, `DOSE_FLOW` 200 – 300 L/h initially, then pulsed at lower rates. `PH` steps toward 7.0 asymptotically. `DOSE_TOTAL` integrates `DOSE_FLOW`. `VOL` rises by the dosed volume. Mild exotherm: `TEMP` rises a few °C. |
| `Settle & separate` | 30 – 60 min | `AGIT_RUN` → 0, `DOSE_PUMP` 0. All values flat. Then `VOL` steps down 20 – 30 % as the aqueous layer is drained. `AGIT_RUN` → 1 at end. |
| `Solvent swap` | 60 – 120 min | `TEMP` rises to 50 – 70 °C. `VOL` falls gradually then partially recovers as fresh solvent is added. `PH` flat. |
| `Transfer` | 20 – 40 min | `VOL` ramps to 0. Coincides with R3 `Receive`. |
| `Clean` | 30 – 60 min | As R1. |

**R3 — Crystalliser**

| Phase | Typical duration | Behaviour |
|---|---|---|
| `Idle` | 5 – 120 min | Everything at rest. `SEEDED` reset to 0 at the start of the next `Receive`. |
| `Receive` | 20 – 40 min | `VOL` ramps to 2,200 – 2,600 L. `AGIT_RUN` → 1, `AGIT` 60 – 80 rpm. `TURB` may read moderately high (suspended solids). |
| `Heat to dissolve` | 30 – 60 min | `TEMP` rises to 60 – 75 °C. `TURB` falls to near 0 as solids dissolve. `COOL_RAMP` 0, `COOL_RATE` positive then ~0. |
| `Cooling ramp` | 60 – 120 min | `COOL_RAMP` 1. `TEMP` falls linearly; `COOL_RATE` −5 to −15 °C/h. Part-way through, `SEEDED` → 1; within 5 – 15 min `TURB` jumps sharply and keeps climbing. |
| `Age` | 60 – 180 min | `COOL_RAMP` 0, `COOL_RATE` ~0. `TEMP` flat at 0 – 10 °C. `TURB` rises slowly toward plateau. `AGIT` constant 60 – 100 rpm. |
| `Transfer` | 20 – 40 min | `VOL` ramps to 0 (slurry to centrifuge, out of scope). |
| `Clean` | 30 – 60 min | As R1, scaled to 3,000 L. |

A full pass of one batch through all three reactors takes roughly 14 to 24 hours. Each reactor's own cycle (from `Charging`/`Receive` to the end of `Clean`) runs roughly 6 to 12 hours.

### 4.9 Simulation cause-and-effect model

The simulation engine should reproduce a cause → effect chain rather than generate values independently, because this is what makes trends look real.

1. **Phase** sets targets: temperature setpoint, agitator speed, jacket mode, dosing on/off, cooling ramp on/off.
2. **Integer status tags** follow the targets immediately (`AGIT_RUN`, `JKT_MODE`, `DOSE_PUMP`, `COOL_RAMP`, `SEEDED`).
3. **Actuator values** move toward their targets quickly with small noise (`JKT_TEMP`, `DOSE_FLOW`, `AGIT`).
4. **Process values** respond to the actuators with lag, first-order dynamics, and noise (`TEMP`, `PH`, `PRES`, `TURB`, `VOL`).
5. **Calculated tags** are derived from other tags every tick: `DOSE_TOTAL` = running integral of `DOSE_FLOW` since batch start; `COOL_RATE` = slope of `TEMP` over a 5 – 10 minute smoothing window.

`N2_BLANKET` is not driven by phase; it stays at 1 unless a fault is injected or a scripted excursion sets it to 0.

### 4.10 Data rates

Four separate rates, which the UI must not conflate.

| Rate | Interval | Meaning for the UI |
|---|---|---|
| Simulation tick | 1 s | Internal. Values are recomputed. |
| Live push | 1 – 2 s | What the dashboard receives. Tiles and the live trend update at this rate. |
| Archive write | 5 s for float tags; on change of state for integer tags | What is persisted. This is the finest resolution any historical view or API call can return for float tags. Integer tags return their state transitions. |
| Rollup | 1 min | Precomputed aggregates for long-range views. For integer tags the rollup holds time-in-state per minute. |

Consequence for design: current-value tiles update roughly every second, but a historical chart cannot show anything finer than five-second resolution for float tags. The Trend explorer's "raw" setting means five-second data for float tags and change-of-state data for integer tags.

### 4.11 Retention

Raw readings are kept 90 days, one-minute rollups 2 years, and batch and event records permanently. A batch older than 90 days therefore still appears in the Batches list with its full event structure and per-event summaries, but its raw trend is unavailable. See screen 5.4 for how this state must be presented.

### 4.12 External consumer use cases

BatchLine, the EBR system, extracts data in five patterns. Two of them are pull, three are push, and the distinction drives which screen serves them.

| Case | Description | Direction | Served by |
|---|---|---|---|
| 1. Single value | Value of one tag at one timestamp | BatchLine pulls | Verified on Trend explorer (data table) |
| 2. Event time | Start and end time of a named unit procedure or phase within a batch | BatchLine pulls | Batches & events (event tree) |
| 3. Calculated value | Max, min, or average of one tag over a range; for integer tags, time-in-state | BatchLine pulls | Batches & events (per-event summary) and Trend explorer (summary strip) |
| 4. Periodic, fixed duration | Repeated sampling at an interval until a set end time | Historian pushes | Monitoring jobs |
| 5. Periodic, manual completion | Repeated sampling until an operator stops it | Historian pushes | Monitoring jobs |

In practice BatchLine extracts CPP tags almost exclusively, which is why the CPP flag drives filters on the verification screens.

For cases 1 to 3 the UI's role is verification, not delivery. Exact values, exact timestamps, and quality flags must be visible and copyable rather than rounded for display. For cases 4 and 5 the UI is the control surface.

---

## 5. Screens

Six screens. Navigation is a persistent left sidebar.

```
Plant overview       ← default landing
Reactor detail
Trend explorer
Batches & events
Monitoring jobs
Simulation control
```

A persistent header shows: product name, simulation clock (server time, UTC and local), simulation state badge (`Running` / `Paused` / `Seeding`), and connection indicator for the live data stream.

---

### 5.1 Plant overview

**Purpose** At-a-glance state of the whole synthesis stage. The screen a demo starts on.

**Layout** Three equal-width reactor cards in a row, ordered R1 → R2 → R3 left to right to match material flow, with small flow arrows between them. A one-line scope caption above the cards: "Final synthesis stage — reaction, workup, crystallisation".

**Each reactor card contains**
- Asset name, ID, and role
- Current phase as a prominent badge, colour-coded by phase
- Active batch ID and product code, or "No active batch" when idle
- Phase elapsed time and estimated remaining time
- Float tag readouts (5 or 6 per reactor), each showing: parameter name, current value, units, CPP badge where applicable, and a compact sparkline of the last 60 minutes
- Integer tag readouts (3 per reactor) as compact state chips showing the label, with a thin state-band strip of the last 60 minutes beneath
- A small alarm indicator when any float tag is outside limits or an integer tag is in its alarm state
- A simple vessel illustration whose fill level reflects `VOL`, whose fill colour reflects `TEMP` (cool blue through to warm amber), with an agitator glyph animated when `AGIT_RUN` = 1

**Below the cards**
- A **batch flow strip**: the last several batch IDs, each shown as a bar spanning its journey across R1, R2, and R3, so the hand-off between reactors is visible
- A **phase timeline**: three horizontal lanes, one per reactor, showing the last 24 hours of phase blocks
- A **recent events feed**: last 15 phase transitions, integer-tag state changes, and alarm events across all reactors, newest first, each linking to the relevant reactor or batch

**Interactions** Clicking a card opens reactor detail for that asset. Clicking a phase block or batch bar opens the corresponding batch.

**States to design**
- Normal, all three running on consecutive batches
- One reactor idle between batches
- One reactor in float-tag alarm
- One reactor in integer-tag alarm (`R1.N2_BLANKET` = 0)
- One reactor with a `Bad` quality sensor
- Simulation paused (values frozen, clear visual indication that this is not live)
- Live stream disconnected (last known values shown, with an explicit staleness notice and the age of the data)

---

### 5.2 Reactor detail

**Purpose** Full view of a single reactor. The screen a demo spends most time on.

**Reactor selector** Segmented control or tab row at the top: `R1 Synthesis | R2 Workup | R3 Crystalliser`. Selection persists across navigation.

**Upper section — current state**
- Large vessel visualisation: fill level from `VOL`, temperature-mapped fill colour, animated agitator when `AGIT_RUN` = 1, jacket indicator driven by `JKT_MODE` on R1 (heating / cooling / idle), dosing inlet glyph active when `DOSE_PUMP` = 1 on R2, crystal glyphs appearing when `SEEDED` = 1 on R3
- Batch context panel: batch ID, product code, recipe version, unit procedure, phase, phase start time, elapsed, estimated remaining, and a step indicator showing position in this reactor's phase sequence (completed / current / upcoming)
- **Float tag tiles**, larger than on the overview. Each shows: parameter name, current value with correct decimal places, units, CPP badge, quality badge, and a trend arrow over the last five minutes. Alarm limits shown as a small linear scale with the current value marked. On R1, the `TEMP` tile additionally shows setpoint (read from `R1.TEMP_SP`, not from internal simulation state) and deviation. Calculated tags carry a small "calc" marker.
- **Integer tag tiles**, visually distinct from float tiles: state label large, integer value small, time in current state, and a state-band strip of the last hour. Alarm-state tags (`R1.N2_BLANKET`) show a red treatment when in state 0.

**Lower section — trend**
- Multi-axis time-series chart with all float tags overlaid, each toggleable via legend
- Beneath the chart, aligned to the same time axis, one state band per integer tag showing state changes as coloured segments
- Time range selector: 15m, 1h, 4h, 12h, 24h, plus a custom range picker
- Phase boundaries drawn as vertical dividers with phase name labels
- Alarm limit lines drawn as horizontal references; on R1, `TEMP_SP` drawn as a stepped line so the lag and overshoot of `TEMP` are visible
- Hovering shows a crosshair with all values (float and integer, with label) at that timestamp
- Regions of `Bad` quality drawn as visible gaps, not interpolated through, on both line charts and state bands

**States to design**
- Active batch mid-phase
- Idle, no active batch (values at rest, trend showing the previous batch)
- Float alarm active
- Integer alarm active (R1 nitrogen blanket lost)
- Sensor fault injected on one tag
- Loading, and empty (no data in selected range)

---

### 5.3 Trend explorer

**Purpose** Cross-reactor comparison and ad-hoc investigation. Used by validation engineers checking a value.

**Layout** Left panel for tag selection, main area for the chart, bottom area for a data table.

**Tag selector** Tree grouped by reactor, then by `Values` and `Status`, 25 tags total, with checkboxes for multi-select. CPP tags carry a badge and a "CPP only" filter toggle is provided. Search field for filtering. Selected tags shown as removable chips above the chart.

**Chart area**
- Overlaid series for all selected float tags, each with its own colour and, where units differ, its own axis
- Selected integer tags rendered as step lines on a dedicated 0/1/2 axis, or as state bands beneath the chart; the designer should pick one treatment and use it consistently with Reactor detail
- Time range picker: presets plus absolute from/to inputs accepting date and time
- Resolution control: raw (5 s), 1 minute, 5 minutes, 1 hour. When the selected range is too wide for the chosen resolution, the resolution is reduced automatically and the control must show that this happened. Silently downsampling is not acceptable on a screen used for verification.
- Cursor readout showing every selected series at the hovered timestamp; integer tags show both integer and label

**Query bounds**
Every query is time-bounded and row-limited. Requesting raw resolution across a multi-week range is refused with an inline explanation rather than attempted.

**Data table below chart**
Timestamped rows for the visible range: timestamp, tag, value, units, quality. Integer tags show the integer in the value column with the label in a secondary column. Sortable, paginated, with CSV export. Exact stored values at full precision.

**Summary strip**
For the visible range, per selected float tag: min with timestamp, max with timestamp, time-weighted average, event-weighted average, sample count, and percent good. Per selected integer tag: time in each state, number of transitions, and percent good. Both averaging methods are shown deliberately, because the difference between them is a known source of validation disputes.

---

### 5.4 Batches and events

**Purpose** Browse historical batches and drill into their event structure. This is the entry point for most EBR queries.

**Batch list**
Table of batches, newest first. Columns: batch ID, product code, start time, end time, duration, status (`Running` / `Completed` / `Aborted`), current location (which reactor, for running batches), and a compact ribbon showing the three unit procedures proportionally with their phases. Filters for reactor (batches that passed through it), date range, and status. Search by batch ID.

**Batch detail** (drill-in, either a full page or a wide side panel)
- Header: batch ID, product code, recipe version, status, start, end, total duration
- Event tree: Batch → Unit procedure (R1, R2, R3) → Phase, expandable. Each row shows event name, start time, end time (or "Running"), and duration. Alarm and state-change events appear as leaf rows under the phase in which they occurred.
- Batch trend: segmented by unit procedure, showing that reactor's float tags with phase dividers, and its integer tags as state bands. Selecting an event in the tree highlights the corresponding region on the chart and vice versa.
- Per-event summary panel: when an event is selected, show min, max, time-weighted average, and percent good for each float tag of that reactor within the event's window, and time-in-state for each integer tag. A "CPP only" toggle filters the panel to CPP tags, which is what BatchLine requests.
- Copy affordances: each timestamp and each computed value individually copyable.

**States to design**
- Completed batch (all three unit procedures)
- Running batch (e.g. R1 unit procedure complete, R2 in progress, R3 not started)
- Aborted batch (incomplete phase sequence, may have stopped at any reactor)
- Batch whose raw data has aged out of retention (rollups available, raw unavailable — stated clearly rather than shown as an error)

---

### 5.5 Monitoring jobs

**Purpose** Manage and observe outbound periodic sampling. This covers the two EBR use cases where the historian pushes data rather than being polled.

Two job kinds:
- **Fixed duration** — samples at a set interval until a predetermined end time
- **Manual completion** — samples at a set interval until an operator stops it

**Active jobs list**
Cards or table rows, each showing: job ID, batch ID, reactor, tags being sampled, interval, kind, started at, samples sent, next sample countdown, delivery health, and state. Manual-completion jobs show a prominent **Complete monitoring** action. All jobs show **Cancel**.

**Create job**
Form with: reactor, tag multi-select (float and integer tags both allowed; CPP tags pre-selected by default), interval (30s / 1m / 5m / 15m / custom), kind, end time or duration for fixed jobs, safety cap for manual jobs, batch ID, and callback destination chosen from a pre-configured list. Preview of the expected sample count and schedule before confirming.

**Job detail**
- Schedule strip: past samples, next sample, planned remaining samples
- Sample log table: sequence number, scheduled time, actual sample time, one column per tag with value and quality (integer tags show the integer), delivery status, attempt count, and delivered-at timestamp. Failed deliveries expandable to show the error and a manual retry action.
- Delivery summary: sent, acknowledged, failed, pending

**States to design**
- Fixed job running normally
- Manual job running, awaiting operator completion
- Job with delivery failures and retries in progress
- Job that hit its safety cap and expired (distinct from completed)
- Completed job (read-only history)
- No active jobs (empty state with a clear call to action)

---

### 5.6 Simulation control

**Purpose** Drive the simulator into specific conditions for testing. Clearly separated from the monitoring screens, because nothing here exists in a real historian.

**Simulation state**
Run / pause control, simulation speed multiplier (1x, 10x, 60x), and current simulation clock.

**Per-reactor phase control**
For each reactor: current batch, unit procedure, and phase, and an action to force an immediate transition to a chosen phase from that reactor's own phase list. Forcing `Transfer` on R1 should start `Receive` on R2 for the same batch, so the batch hand-off stays consistent.

**Status override**
Per integer tag, force a state (0 / 1 / 2 as applicable) and release back to simulation control. This is how the `N2_BLANKET` alarm is scripted for demos.

**Fault injection**
Per tag, inject and clear: stuck value, upward or downward drift (float only), noise spike (float only), signal dropout, or forced quality flag. Active faults listed with the affected tag, fault type, and time active, each individually clearable. A global "clear all faults" action.

**Setpoint override**
On R1, temporarily override `TEMP_SP` to force a temperature alarm on demand. The override is written to the `R1.TEMP_SP` tag so the tile, trend, and API all agree.

**History management**
- Reseed: generate synthetic history for a chosen number of days with an optional numeric seed, showing a clear warning that existing data will be replaced
- Reset: wipe all data and start clean
- Current archive statistics: row count, oldest reading, newest reading, batches on record, storage used

**Retention settings**
Display and edit: raw retention (default 90 days), rollup retention (default 2 years), and a note that batch and event records are never deleted.

Every destructive action requires explicit confirmation naming what will be lost.

---

### 5.7 API explorer (secondary, lower priority)

**Purpose** Let an integration developer exercise endpoints without leaving the app.

Endpoint list grouped by EBR use case, each with a parameter form, an execute action, the resolved request URL, and a formatted response viewer. A recent request log showing method, path, status, duration, and consumer, with each entry replayable. Integer tag values appear in responses as integers with no label, matching the archive.

Also holds API key management: create, label, and revoke keys, with last-used timestamps.

This screen can be a later addition. Mock it only if there is time after the first six.

---

## 6. Design direction

**Character** Industrial monitoring software for a regulated industry, not a consumer analytics product. Dense, precise, and calm. A validation engineer should trust it; a pharmaceutical stakeholder in a demo should find it legible and recognisable.

**Colour**
- Restrained neutral base. Colour is reserved for meaning, not decoration.
- Phase colours: a distinct, consistent hue per phase, applied identically everywhere a phase appears. Shared phases (`Idle`, `Charging`/`Receive`, `Transfer`, `Clean`) use the same colour on every reactor. Cool tones for `Idle` and `Charging`/`Receive`, warm for `Heating`, `Reaction hold`, `Heat to dissolve`, and `Solvent swap`, cooling tones for `Cooling`, `Cooling ramp`, and `Age`, neutral for `Transfer` and `Clean`. `pH adjust` and `Settle & separate` take a distinct mid-tone.
- Float tag colours: one consistent colour per tag family across every chart (temperature family including `TEMP`, `TEMP_SP`, and `JKT_TEMP` in related shades; pressure; agitation; volume; pH and dosing; turbidity and cooling rate).
- Integer state colours: state 1 in a quiet positive tone, state 0 in a neutral tone except for alarm-state tags where 0 is red, state 2 (`JKT_MODE` cooling) in a cool tone. State bands should be legible in greyscale.
- Status colours used sparingly and only for status: alarm, quality warning, delivery failure.

**Typography** Tabular numerals for every value. Values are the content of this product and should be the most prominent text on any tile. Units clearly subordinate to the number. State labels on integer tiles are the equivalent prominent element. Timestamps in a monospaced or tabular treatment.

**Data density** Favour density over whitespace on the explorer, batch, and monitoring screens. The overview and reactor detail screens can breathe more, since they carry the demo.

**Motion** Minimal. Values updating should transition briefly rather than jumping. The agitator animation, fill level, and state-chip colour change on integer transitions are the only decorative motion. No animation on chart redraw.

**Timestamps** Display in both UTC and local time wherever a timestamp is significant, or provide a global toggle with the active mode always visible. Never show a timestamp without making its zone unambiguous.

---

## 7. Sample data for mockups

Use these values so mockups read as plausible and are internally consistent. All times UTC.

**Simulation clock** 27 March 2026, 15:07:22

**Product** `API-7734`, recipe `v2.1`

**Reactor 1 — Synthesis** — batch `B-2026-0143`, unit procedure R1, phase `Heating`, phase started 14:52:40, elapsed 14m 42s, estimated remaining 51m. Normal.

| Tag | Value | Quality | Note |
|---|---|---|---|
| `R1.TEMP` | 61.30 °C | Good | Rising |
| `R1.TEMP_SP` | 85.00 °C | Good | Deviation −23.70 |
| `R1.JKT_TEMP` | 78.5 °C | Good | Rising |
| `R1.PRES` | 0.85 bar g | Good | Rising |
| `R1.AGIT` | 120 rpm | Good | |
| `R1.VOL` | 3,900 L | Good | |
| `R1.AGIT_RUN` | 1 (Running) | Good | Since 14:31:05 |
| `R1.JKT_MODE` | 1 (Heating) | Good | Since 14:52:40 |
| `R1.N2_BLANKET` | 1 (OK) | Good | |

**Reactor 2 — Workup** — batch `B-2026-0142`, unit procedure R2, phase `pH adjust`, phase started 14:14:05, elapsed 53m 17s, estimated remaining 22m. **Alarm: nitrogen blanket lost.**

| Tag | Value | Quality | Note |
|---|---|---|---|
| `R2.PH` | 5.84 | Good | Rising toward 7.00 |
| `R2.TEMP` | 42.15 °C | Good | Flat |
| `R2.DOSE_FLOW` | 120.0 L/h | Good | Pulsing |
| `R2.DOSE_TOTAL` | 684.5 L | Good | Calculated |
| `R2.VOL` | 4,180 L | Good | |
| `R2.AGIT_RUN` | 1 (Running) | Good | |
| `R2.DOSE_PUMP` | 1 (On) | Good | |
| `R2.N2_BLANKET` | 0 (Lost) | Good | **Since 14:38:12** — shown as an event; not an alarm-state tag on R2, so warning treatment rather than alarm |

*(If the mockup needs a true integer alarm, move this scenario to `R1.N2_BLANKET` instead; R2's blanket loss is shown here as a notable state change to exercise the event feed.)*

**Reactor 3 — Crystalliser** — batch `B-2026-0141`, unit procedure R3, phase `Cooling ramp`, phase started 13:58:15, elapsed 1h 09m, estimated remaining 22m. **Sensor fault on turbidity.**

| Tag | Value | Quality | Note |
|---|---|---|---|
| `R3.TEMP` | 31.20 °C | Good | Falling |
| `R3.COOL_RATE` | −9.8 °C/h | Good | Calculated |
| `R3.AGIT` | 80 rpm | Good | |
| `R3.TURB` | — | **Bad** | Sensor fault injected 14:41:03 |
| `R3.VOL` | 2,410 L | Good | |
| `R3.AGIT_RUN` | 1 (Running) | Good | |
| `R3.COOL_RAMP` | 1 (Ramping) | Good | Since 13:58:15 |
| `R3.SEEDED` | 1 (Yes) | Good | Since 14:12:40 |

**Example event structure for `B-2026-0142`** (currently in R2)

| Event | Start | End | Duration |
|---|---|---|---|
| Batch `B-2026-0142` | 06:12:00 | — | 8h 55m (running) |
| — Unit procedure R1 — Synthesis | 06:12:00 | 13:47:20 | 7h 35m 20s |
| —— Charging | 06:12:00 | 06:44:31 | 32m 31s |
| —— Heating | 06:44:31 | 08:02:17 | 1h 17m 46s |
| —— Reaction hold | 08:02:17 | 12:10:40 | 4h 08m 23s |
| —— Cooling | 12:10:40 | 13:22:05 | 1h 11m 25s |
| —— Transfer | 13:22:05 | 13:47:20 | 25m 15s |
| — Unit procedure R2 — Workup | 13:22:05 | — | 1h 45m (running) |
| —— Receive | 13:22:05 | 13:47:20 | 25m 15s |
| —— Wait for start | 13:47:20 | 14:14:05 | 26m 45s |
| —— pH adjust | 14:14:05 | — | 53m 17s (running) |
| ——— `R2.N2_BLANKET` → 0 | 14:38:12 | — | 29m 10s (active) |
| — Unit procedure R3 — Crystallisation | — | — | Not started |

Note that R1 `Transfer` and R2 `Receive` share the same window. After transfer, R1 ran `Clean` 13:47:20 – 14:20:10, `Idle` 14:20:10 – 14:26:30, then started `B-2026-0143` `Charging` at 14:26:30.

**Example per-event summary** (`R1.TEMP` during `Reaction hold` of `B-2026-0142`)
- Min 83.62 °C at 11:47:05
- Max 86.14 °C at 08:09:33
- Time-weighted average 84.97 °C
- Event-weighted average 84.98 °C
- Samples 2,980, percent good 100.0

**Example integer per-event summary** (`R2.N2_BLANKET` during `pH adjust` of `B-2026-0142`, to now)
- Time in state 1 (OK): 24m 07s
- Time in state 0 (Lost): 29m 10s
- Transitions: 1
- Percent good 100.0

**Example monitoring job**
- Job `mj-7f3a91`, batch `B-2026-0142`, reactor R2, tags `R2.PH`, `R2.TEMP`, `R2.DOSE_TOTAL`, interval 5 min, fixed duration 14:15 to 16:15, 25 samples planned, 11 sent, next at 15:10:00
- Sample 10 — 15:00:00, PH 5.61, TEMP 42.30, DOSE_TOTAL 652.0, delivered 15:00:01
- Sample 11 — 15:05:00, PH 5.78, TEMP 42.20, DOSE_TOTAL 671.8, delivered 15:05:02

---

## 8. Success criteria

The mockups succeed if:

1. A pharmaceutical stakeholder shown the overview screen for ten seconds understands that this is one API synthesis stage with three vessels, roughly what each is doing, which batch is where, and that one vessel needs attention.
2. An integration developer can find a specific historical batch, locate a specific unit procedure and phase within it, and read the exact value and timestamp they need to write a test fixture.
3. A validation engineer can trace a number from a batch record back to a timestamped archive reading, can tell whether that reading was of good quality, and can see whether the tag is a CPP.
4. `Bad` quality data is never mistakable for a real measurement anywhere in the interface, on line charts or on state bands.
5. Integer status tags are never mistakable for numeric process values: a reader always sees the state label where they are reading, and the integer where they are verifying.
6. The distinction between live data, frozen data, and stale data is unambiguous on every screen that shows a current value.

---

## 9. Open questions

1. Does BatchLine consume PI Web API's exact URL patterns and JSON envelopes, or is there an integration layer in between? If the former, response shapes should mirror PI precisely.
2. Should the dashboard show pending outbound samples that have not yet been acknowledged by BatchLine, or only confirmed deliveries?
3. Should the seeded history include more than one product code, grouped into campaigns with a distinct changeover clean between them? This adds realism for a pharma audience but complicates the batch list filters.
4. Does BatchLine expect two-state integer tags to be delivered as integers (0/1) or as booleans in the JSON? The archive stores integers either way.
5. Is a tablet layout needed for anyone walking a demo around, or is desktop sufficient?

---

## Appendix A. Technical context

Not design content. Recorded here so the document is self-contained.

**Stack** Node with Express for the API, a separate process for the simulation loop, PostgreSQL with the TimescaleDB extension for the archive, React with a streaming-capable charting library for the frontend.

**Deployment** Single small VPS, four containers via Docker Compose, reverse proxy terminating TLS. Grafana runs alongside as a separate container for ad-hoc querying and internal debugging, and is not part of the product UI.

**Data volumes** Sixteen float tags at a five-second archive rate produce roughly 280,000 rows per day. Nine integer tags archived on change of state add a few hundred rows per day. At 90-day retention with compression the archive stays in the low gigabytes.

**Seeding** Because all data is synthetic, history is generated rather than accumulated. On first run the simulator backfills 90 days of completed batches in seconds. Generation is driven by a seeded PRNG, so a given seed reproduces identical data, including the R1 → R2 → R3 hand-off timing of every batch, which keeps batch genealogy consistent across reseeds.

**Design implication of seeding** The Batches list is fully populated from day one. Mockups should not depict an early-adoption empty state for historical screens; the only genuine empty states are a fresh reset and a filter that matches nothing.

---

## Appendix B. Changes from v0.1

| Area | v0.1 | v0.2 |
|---|---|---|
| Process framing | Generic chemical reactors | One synthesis stage of a small-molecule API, stated explicitly in scope and on the overview |
| Assets | Three structurally identical reactors | Three specialised reactors: Synthesis, Workup, Crystalliser, with material and role |
| Tags | 4 identical float tags per reactor, 12 total | Reactor-specific sets: 9 / 8 / 8, 25 total; 16 float (2 calculated) and 9 integer status tags |
| Point types | Float only | Float, calculated float, and integer (enumerated) with change-of-state archiving |
| Status encoding | — | Integers, 1 = active/healthy, 0 = inactive/failed; labels are UI metadata only |
| Setpoint | Display-only field on tiles | `R1.TEMP_SP` is an archived tag; tiles read from it |
| Ranges | 0 – 150 °C, 0 – 10 bar g, shared limits | Per-reactor ranges allowing cold operation (−20 °C) and vacuum (−1 bar g) |
| CPP | — | CPP flag on every tag; filters on Trend explorer, Batch detail, and Monitoring job creation |
| Alarms | Float limits only | Float limits plus optional alarm state on integer tags (`R1.N2_BLANKET`) |
| Batch model | One independent batch per reactor | One batch flows R1 → R2 → R3 as Batch → Unit procedure → Phase (ISA-88); product code and recipe version on header |
| Phases | One generic 7-phase cycle | Reactor-specific 7-phase cycles sharing Idle, Charging/Receive, Transfer, Clean |
| Simulation | Phase drives setpoints drives values | Explicit cause → effect chain: phase → status → actuator → process value → calculated tag |
| Overview screen | Three cards, timeline, feed | Adds flow arrows, scope caption, status chips with state bands, batch flow strip |
| Reactor detail | Four float tiles, one trend | Float and integer tile variants; state bands under trend; setpoint line on R1 |
| Trend explorer | 12-tag tree | 25-tag tree grouped by reactor then Values/Status; integer summary as time-in-state |
| Batches | Batch = one reactor cycle | Batch spans three unit procedures; list shows product and current location |
| Simulation control | Phase, fault, setpoint, history | Adds status override; setpoint override writes to the tag; forced transfer keeps hand-off consistent |
| Compliance | Out of scope | Explicitly deferred beyond MVP (audit trail, e-signature, ack workflows) |
| Sample data | Generic | Rewritten for the new tags, three consecutive batches, and one integer state-change scenario |
