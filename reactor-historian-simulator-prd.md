# Product requirements: Reactor process historian simulator

**Version** 0.1 (draft for UI design)
**Date** 8 September 2026
**Purpose of this document** Provide enough product and data context for a designer to produce screen mockups. Backend implementation detail is deliberately summarised.

---

## 1. Summary

A simulated manufacturing process historian, modelled on AVEVA PI System, covering three chemical reactor vessels. The system generates synthetic process data continuously, stores it as a time-series archive, presents it on a monitoring dashboard, and exposes it to external systems through a REST API.

It is **not** connected to physical equipment. All values are produced by a simulation engine. The product exists so that integration teams can build and validate against a PI-like data source without needing access to a real plant or a real PI installation.

The primary external consumer is **BatchLine**, an electronic batch record (EBR) system that pulls process values into batch documentation.

---

## 2. Users

| User | Goal | Primary screens |
|---|---|---|
| **Integration developer** | Build and debug BatchLine's connection to the historian. Needs to see what data exists, call endpoints, and inspect what was returned. | API explorer, tag browser, batch history |
| **Validation / QA engineer** | Confirm that a value pulled into a batch record matches the archive. Needs traceability from an EBR field back to a timestamped reading. | Batch history, trend explorer, monitoring log |
| **Demo presenter** | Show a convincing live plant-floor monitoring view to stakeholders. | Plant overview, reactor detail |
| **Simulation operator** | Drive the simulator into specific conditions for testing: force an alarm, inject a sensor fault, reseed history. | Simulation control |

The integration developer is the primary user. The dashboard needs to look credible, but its job is diagnostic rather than operational.

---

## 3. Scope

### In scope
- Three reactor vessels, four process parameters each
- Continuous simulation with batch phase progression
- Time-series archive with configurable retention
- Live dashboard with reactor selection and trend charts
- Batch and event browser
- REST API for external data extraction
- Outbound periodic sampling to a configured callback
- Fault injection and history reseeding

### Out of scope
- Any connection to real instrumentation, PLCs, or SCADA
- User accounts, roles, or permissions (single trusted operator assumed)
- Alarm acknowledgement workflows or operator sign-off
- Control actions (the dashboard is read-only; setpoints are driven by the simulation, not the user)
- Mobile-first layouts (desktop 1440px is the design target; tablet is a nice-to-have)
- General-purpose BI, ad-hoc charting, or SQL console features. A separate Grafana instance and a read-only database role cover these needs. The product UI is purpose-built for process monitoring and EBR traceability, and should not attempt to be a query tool.

---

## 4. Domain model

### Assets

Three reactors, identical in structure, differing in size and current activity.

| Asset | Display name | Capacity |
|---|---|---|
| `R1` | Reactor 1 — Primary synthesis | 5,000 L |
| `R2` | Reactor 2 — Secondary synthesis | 5,000 L |
| `R3` | Reactor 3 — Crystalliser | 3,000 L |

### Parameters

Four per reactor, twelve tags total. Tag names follow `{asset}.{parameter}`.

| Parameter | Tag suffix | Units | Range | Typical operating | Alarm low | Alarm high | Display digits |
|---|---|---|---|---|---|---|---|
| Temperature | `TEMP` | °C | 0 – 150 | 20 – 95 | 5 | 105 | 2 |
| Pressure | `PRES` | bar g | 0 – 10 | 0.8 – 6.0 | — | 7.5 | 2 |
| Agitation speed | `AGIT` | rpm | 0 – 300 | 0 – 180 | — | 250 | 0 |
| Liquid volume | `VOL` | L | 0 – 5,000 | 0 – 4,200 | — | 4,800 | 0 |

Full tag list: `R1.TEMP`, `R1.PRES`, `R1.AGIT`, `R1.VOL`, `R2.TEMP`, … `R3.VOL`.

### Quality

Every reading carries a quality flag. The UI must distinguish these visually — this is not decoration, it determines whether a value may be used in a batch record.

| Quality | Meaning | Suggested treatment |
|---|---|---|
| `Good` | Normal | Default styling |
| `Questionable` | Value present but suspect (drift detected) | Amber marker, value still shown |
| `Bad` | Sensor fault, value not trustworthy | Value replaced with an em dash, red marker |
| `Substituted` | Value manually overridden | Value shown with a distinguishing marker |

### Batch phases

Each reactor runs a repeating cycle. Phase drives the setpoints, which drive the parameter values.

| Phase | Typical duration | Behaviour |
|---|---|---|
| `Idle` | 30 – 120 min | All parameters at rest. Volume zero, agitator stopped. |
| `Charging` | 20 – 40 min | Volume ramps up. Agitator starts at low speed. |
| `Heating` | 45 – 90 min | Temperature ramps to setpoint with slight overshoot. Pressure follows. |
| `Hold` | 2 – 6 h | Temperature steady at setpoint with small oscillation. |
| `Cooling` | 60 – 120 min | Temperature descends. Pressure falls. |
| `Discharge` | 20 – 40 min | Volume ramps down to zero. |
| `Clean` | 40 – 60 min | Short high-temperature, high-agitation cycle. Volume partial. |

A full cycle runs roughly 8 to 14 hours. The three reactors are deliberately out of phase with one another so the overview screen always shows a mix of states.

### Batches and events

A batch spans one full cycle. Batch IDs follow `B-2026-0142` (year, then sequence). Each phase transition creates an **event** with a start time and an end time, where end time is `null` while the phase is running. Events nest: a batch contains phases, and phases may contain sub-steps.

### Data rates

Three separate rates, which the UI must not conflate.

| Rate | Interval | Meaning for the UI |
|---|---|---|
| Simulation tick | 1 s | Internal. Values are recomputed. |
| Live push | 1 – 2 s | What the dashboard receives. Parameter tiles and the live trend update at this rate. |
| Archive write | 5 s | What is persisted. This is the finest resolution any historical view or API call can return. |
| Rollup | 1 min | Precomputed aggregates for long-range views. |

Consequence for design: the current-value tiles on Plant overview and Reactor detail update roughly every second, but a historical chart cannot show anything finer than five-second resolution. The Trend explorer's "raw" setting means five-second data, not one-second.

### Retention

Raw readings are kept 90 days, one-minute rollups 2 years, and batch and event records permanently. A batch older than 90 days therefore still appears in the Batches list with its full event structure and per-event summaries, but its raw trend is unavailable. See screen 5.4 for how this state must be presented.

### External consumer use cases

BatchLine, the EBR system, extracts data in five patterns. Two of them are pull, three are push, and the distinction drives which screen serves them.

| Case | Description | Direction | Served by |
|---|---|---|---|
| 1. Single value | Value of one tag at one timestamp | BatchLine pulls | Verified on Trend explorer (data table) |
| 2. Event time | Start and end time of a named event within a batch | BatchLine pulls | Batches & events (event tree) |
| 3. Calculated value | Max, min, or average of one tag over a range | BatchLine pulls | Batches & events (per-event summary) and Trend explorer (summary strip) |
| 4. Periodic, fixed duration | Repeated sampling at an interval until a set end time | Historian pushes | Monitoring jobs |
| 5. Periodic, manual completion | Repeated sampling until an operator stops it | Historian pushes | Monitoring jobs |

For cases 1 to 3 the UI's role is verification, not delivery. A developer or validation engineer uses the screen to confirm that what the API returned matches the archive. This is why exact values, exact timestamps, and quality flags must be visible and copyable rather than rounded for display.

For cases 4 and 5 the UI is the control surface. Jobs are created, monitored, and in case 5 manually completed from the Monitoring jobs screen.

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

**Purpose** At-a-glance state of all three reactors. The screen a demo starts on.

**Layout** Three equal-width cards in a row on desktop, stacking on narrow viewports.

**Each reactor card contains**
- Asset name and ID
- Current phase, as a prominent badge, colour-coded by phase
- Active batch ID, or "No active batch" when idle
- Phase elapsed time and estimated remaining time
- Four parameter readouts, each showing: parameter name, current value, units, and a compact sparkline of the last 60 minutes
- A small alarm indicator when any parameter is outside limits
- A simple vessel illustration whose fill level reflects current liquid volume, with fill colour reflecting temperature (cool blue through to warm amber)

**Below the cards**
- A combined phase timeline: three horizontal lanes, one per reactor, showing the last 24 hours of phase blocks. This makes the out-of-phase staggering visible and gives an immediate sense of plant activity.
- A recent events feed: last 15 phase transitions and alarm events across all reactors, newest first, each linking to the relevant reactor or batch.

**Interactions** Clicking a card opens reactor detail for that asset. Clicking a phase block in the timeline opens the corresponding batch.

**States to design**
- Normal, all three running
- One reactor idle
- One reactor in alarm
- One reactor with a `Bad` quality sensor
- Simulation paused (values frozen, clear visual indication that this is not live)
- Live stream disconnected (last known values shown, with an explicit staleness notice and the age of the data)

---

### 5.2 Reactor detail

**Purpose** Full view of a single reactor. The screen a demo spends most time on.

**Reactor selector** Segmented control or tab row at the top: `Reactor 1 | Reactor 2 | Reactor 3`. Selection persists across navigation. Must be immediately obvious which reactor is selected.

**Upper section — current state**
- Large vessel visualisation: fill level, temperature-mapped fill colour, animated agitator when running, jacket indicator when heating or cooling is active
- Batch context panel: batch ID, phase, phase start time, elapsed, estimated remaining, and a step indicator showing position in the phase sequence (completed / current / upcoming)
- Four parameter tiles, larger than on the overview. Each shows: parameter name, current value with correct decimal places, units, setpoint, deviation from setpoint, quality badge, and a trend arrow indicating direction over the last five minutes. Alarm limits shown as a small linear scale with the current value marked.

**Lower section — trend**
- Multi-axis time-series chart with all four parameters overlaid, each toggleable via legend
- Time range selector: 15m, 1h, 4h, 12h, 24h, plus a custom range picker
- Phase boundaries drawn as vertical dividers with phase name labels, so a reader can see which part of the curve belongs to which phase
- Alarm limit lines drawn as horizontal references
- Hovering shows a crosshair with all four values at that timestamp and the timestamp itself
- Regions of `Bad` quality drawn as visible gaps, not interpolated through

**States to design**
- Active batch mid-phase
- Idle, no active batch (parameters at rest, trend showing the previous batch)
- Alarm active
- Sensor fault injected on one parameter
- Loading, and empty (no data in selected range)

---

### 5.3 Trend explorer

**Purpose** Cross-reactor comparison and ad-hoc investigation. Used by validation engineers checking a value.

**Layout** Left panel for tag selection, main area for the chart, bottom area for a data table.

**Tag selector** Tree grouped by asset, twelve tags total, with checkboxes for multi-select. Search field for filtering. Selected tags shown as removable chips above the chart.

**Chart area**
- Overlaid series for all selected tags, each with its own colour and, where units differ, its own axis
- Time range picker: presets plus absolute from/to inputs accepting date and time
- Resolution control: raw (5 s), 1 minute, 5 minutes, 1 hour. When the selected range is too wide for the chosen resolution, the resolution is reduced automatically and the control must show that this happened, along with the resolution actually served. Silently downsampling is not acceptable on a screen used for verification.
- Cursor readout showing every selected series at the hovered timestamp

**Query bounds**
Every query on this screen is time-bounded and row-limited. The range picker must not permit an unbounded selection, and requesting raw resolution across a multi-week range should be refused with an explanation rather than attempted. Design an inline notice for this case; it will be seen regularly.

**Data table below chart**
Timestamped rows for the visible range: timestamp, tag, value, units, quality. Sortable, paginated, with CSV export. This is the screen where someone verifies that an EBR field matches the archive, so the table must show exact stored values at full precision, not rounded display values.

**Summary strip**
For the visible range, per selected tag: min with timestamp, max with timestamp, time-weighted average, event-weighted average, sample count, and percent good. Both averaging methods are shown deliberately, because the difference between them is a known source of validation disputes.

---

### 5.4 Batches and events

**Purpose** Browse historical batches and drill into their event structure. This is the entry point for most EBR queries.

**Batch list**
Table of batches, newest first. Columns: batch ID, reactor, start time, end time, duration, status (`Running` / `Completed` / `Aborted`), and a compact phase ribbon showing the phase sequence proportionally. Filters for reactor, date range, and status. Search by batch ID.

**Batch detail** (drill-in, either a full page or a wide side panel)
- Header: batch ID, reactor, status, start, end, total duration
- Event tree: nested, expandable. Each row shows event name, start time, end time (or "Running"), and duration. Nesting depth up to three levels.
- Batch trend: all four parameters across the whole batch, with phase dividers. Selecting an event in the tree highlights the corresponding region on the chart and vice versa.
- Per-event summary panel: when an event is selected, show min, max, time-weighted average, and percent good for each parameter within that event's window. This is exactly what BatchLine requests, so seeing it in the UI lets a developer verify the API returns matching numbers.
- Copy affordances: each timestamp and each computed value should be individually copyable, since developers will paste them into test fixtures.

**States to design**
- Completed batch
- Currently running batch (end time absent, chart ends at "now", event tree shows an in-progress phase)
- Aborted batch (incomplete phase sequence)
- Batch whose raw data has aged out of retention (rollups available, raw unavailable — must be stated clearly rather than shown as an error)

---

### 5.5 Monitoring jobs

**Purpose** Manage and observe outbound periodic sampling. This covers the two EBR use cases where the historian pushes data rather than being polled.

Two job kinds:
- **Fixed duration** — samples at a set interval until a predetermined end time
- **Manual completion** — samples at a set interval until an operator stops it

**Active jobs list**
Cards or table rows, each showing: job ID, batch ID, reactor, tags being sampled, interval, kind, started at, samples sent, next sample countdown, delivery health, and state. Manual-completion jobs show a prominent **Complete monitoring** action. All jobs show **Cancel**.

**Create job**
Form with: reactor, tag multi-select, interval (30s / 1m / 5m / 15m / custom), kind, end time or duration for fixed jobs, safety cap for manual jobs, batch ID, and callback destination chosen from a pre-configured list. Preview of the expected sample count and schedule before confirming.

**Job detail**
- Schedule strip: past samples, next sample, planned remaining samples
- Sample log table: sequence number, scheduled time, actual sample time, one column per tag with value and quality, delivery status, attempt count, and delivered-at timestamp. Failed deliveries expandable to show the error and a manual retry action.
- Delivery summary: sent, acknowledged, failed, pending

**States to design**
- Fixed job running normally
- Manual job running, awaiting operator completion
- Job with delivery failures and retries in progress
- Job that hit its safety cap and expired (distinct from completed — this needs attention)
- Completed job (read-only history)
- No active jobs (empty state with a clear call to action)

---

### 5.6 Simulation control

**Purpose** Drive the simulator into specific conditions for testing. Clearly separated from the monitoring screens, because nothing here exists in a real historian.

**Simulation state**
Run / pause control, simulation speed multiplier (1x, 10x, 60x), and current simulation clock.

**Per-reactor phase control**
For each reactor: current phase, and an action to force an immediate transition to a chosen phase. Useful for reaching a specific condition without waiting hours.

**Fault injection**
Per tag, inject and clear: stuck value, upward or downward drift, noise spike, signal dropout, or forced quality flag. Active faults listed with the affected tag, fault type, and time active, each individually clearable. A global "clear all faults" action.

**Setpoint override**
Per reactor, temporarily override the phase setpoint for any parameter, to force an alarm condition on demand.

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

Endpoint list grouped by EBR use case, each with a parameter form, an execute action, the resolved request URL, and a formatted response viewer. A recent request log showing method, path, status, duration, and consumer, with each entry replayable.

Also holds API key management: create, label, and revoke keys, with last-used timestamps.

This screen can be a later addition. Mock it only if there is time after the first six.

---

## 6. Design direction

**Character** Industrial monitoring software, not a consumer analytics product. Dense, precise, and calm. A validation engineer should trust it; a stakeholder in a demo should find it legible.

**Colour**
- Restrained neutral base. Colour is reserved for meaning, not decoration.
- Phase colours: a distinct, consistent hue per phase, applied identically everywhere a phase appears (badge, timeline block, chart divider, event tree). Cool tones for `Idle` and `Charging`, warm for `Heating` and `Hold`, cooling tones for `Cooling`, neutral for `Discharge` and `Clean`.
- Parameter colours: one consistent colour per parameter across every chart in the product. Temperature, pressure, agitation, and volume should be identifiable by colour alone once learned.
- Status colours used sparingly and only for status: alarm, quality warning, delivery failure.

**Typography** Tabular numerals for every value, so digits do not shift as values update. Values are the content of this product and should be the most prominent text on any tile. Units clearly subordinate to the number. Timestamps in a monospaced or tabular treatment for scannability.

**Data density** Favour density over whitespace on the explorer, batch, and monitoring screens. The overview and reactor detail screens can breathe more, since they carry the demo.

**Motion** Minimal. Values updating should transition briefly rather than jumping, so a change is noticeable without being distracting. The agitator animation on the vessel and the fill level are the only decorative motion. No animation on chart redraw.

**Timestamps** Display in both UTC and local time wherever a timestamp is significant, or provide a global toggle with the active mode always visible. Never show a timestamp without making its zone unambiguous. This matters because batches span DST transitions.

---

## 7. Sample data for mockups

Use these values so mockups read as plausible and are internally consistent.

**Simulation clock** 27 March 2026, 15:07:22 UTC

**Reactor 1** — active
- Batch `B-2026-0142`, phase `Hold`, phase started 14:31:08, elapsed 36m 14s, estimated remaining 3h 24m
- `R1.TEMP` 84.62 °C (setpoint 85.00, deviation −0.38), Good, trending flat
- `R1.PRES` 3.41 bar g, Good, trending flat
- `R1.AGIT` 145 rpm (setpoint 145), Good
- `R1.VOL` 3,850 L, Good

**Reactor 2** — active, alarm
- Batch `B-2026-0143`, phase `Heating`, phase started 14:52:40, elapsed 14m 42s, estimated remaining 51m
- `R2.TEMP` 107.85 °C, Good, rising — **above high alarm limit of 105**
- `R2.PRES` 6.92 bar g, Good, rising
- `R2.AGIT` 160 rpm, Good
- `R2.VOL` 4,100 L, Good

**Reactor 3** — active, sensor fault
- Batch `B-2026-0141`, phase `Cooling`, phase started 13:58:15, elapsed 1h 09m, estimated remaining 22m
- `R3.TEMP` 46.30 °C, Good, falling
- `R3.PRES` — , **Bad** (sensor fault injected 14:41:03)
- `R3.AGIT` 90 rpm, Good
- `R3.VOL` 2,640 L, Good

**Example event structure for `B-2026-0142`**

| Event | Start | End | Duration |
|---|---|---|---|
| Batch `B-2026-0142` | 06:12:00 | — | 8h 55m (running) |
| — Charging | 06:12:00 | 06:44:31 | 32m 31s |
| — Heating | 06:44:31 | 08:02:17 | 1h 17m 46s |
| — Hold | 14:31:08 | — | 36m 14s (running) |

**Example per-event summary** (`R1.TEMP` during `Heating` of `B-2026-0142`)
- Min 21.04 °C at 06:44:33
- Max 87.91 °C at 07:58:42
- Time-weighted average 62.18 °C
- Event-weighted average 61.94 °C
- Samples 934, percent good 100.0

**Example monitoring job**
- Job `mj-7f3a91`, batch `B-2026-0142`, reactor 1, tags `R1.TEMP` and `R1.PRES`, interval 5 min, fixed duration 15:00 to 21:00, 73 samples planned, 2 sent, next at 15:10:00
- Sample 1 — 15:00:00, TEMP 84.71, PRES 3.38, delivered 15:00:01
- Sample 2 — 15:05:00, TEMP 84.55, PRES 3.40, delivered 15:05:02

---

## 8. Success criteria

The mockups succeed if:

1. A stakeholder shown the overview screen for ten seconds understands that three vessels are running, roughly what state each is in, and that one needs attention.
2. An integration developer can find a specific historical batch, locate a specific phase within it, and read the exact value and timestamp they need to write a test fixture.
3. A validation engineer can trace a number from a batch record back to a timestamped archive reading, and can tell whether that reading was of good quality.
4. `Bad` quality data is never mistakable for a real measurement anywhere in the interface.
5. The distinction between live data, frozen data, and stale data is unambiguous on every screen that shows a current value.

---

## 9. Open questions

1. Does BatchLine consume PI Web API's exact URL patterns and JSON envelopes, or is there an integration layer in between? If the former, response shapes should mirror PI precisely so the simulator can later be swapped for real PI without reconfiguring BatchLine.
2. Should the dashboard show pending outbound samples that have not yet been acknowledged by BatchLine, or only confirmed deliveries?
3. Are additional parameters expected later, such as pH for in-process control? The parameter tile layout should tolerate five or six tags per reactor if so.
4. Is a tablet layout needed for anyone walking a demo around, or is desktop sufficient?

---

## Appendix A. Technical context

Not design content. Recorded here so the document is self-contained.

**Stack** Node with Express for the API, a separate process for the simulation loop, PostgreSQL with the TimescaleDB extension for the archive, React with a streaming-capable charting library for the frontend.

**Deployment** Single small VPS, four containers via Docker Compose, reverse proxy terminating TLS. Grafana runs alongside as a separate container for ad-hoc querying and internal debugging, and is not part of the product UI.

**Data volumes** Twelve tags at a five-second archive rate produce roughly 200,000 rows per day. At 90-day retention with compression the archive stays in the low gigabytes.

**Seeding** Because all data is synthetic, history is generated rather than accumulated. On first run the simulator backfills 90 days of completed batches in seconds. Generation is driven by a seeded PRNG, so a given seed reproduces identical data, which makes repeatable test fixtures possible. This is what allows the destructive reset and reseed actions on screen 5.6 to exist at all.

**Design implication of seeding** The Batches list is fully populated from day one. Mockups should not depict an early-adoption empty state for historical screens; the only genuine empty states are a fresh reset and a filter that matches nothing.
