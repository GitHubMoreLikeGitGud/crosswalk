-- =============================================================================
-- Opaque-column experiment: the eight views the Q1 2025 question probes, copied
-- as new views whose columns are renamed c1, c2, ... in their original order, so
-- no column name reveals a key. The originals are not altered; the new views live
-- in the cw container under the opq_ prefix and are listed in
-- ../manifest-opaque.json (with each view's column map, which the agent never
-- reads into a prompt). `npm run ask -- --quarter CY2025Q1 --cold --opaque`
-- probes these views instead of the originals.
-- Format: CREATE SCHEMASTORE VIEW ... AS SELECT ... FROM <cached cw view>, then
-- CACHE TABLE; run with gateway.run_sql --skip-exists (never DROP, never REPLACE).
-- Rate limit: none (every view reads a cached cw view; no source call).
-- Status and counts: 11_cw_opaque_select.sql.
-- =============================================================================

CREATE SCHEMASTORE VIEW opq_seed_submissions_snapshot WITH CONTAINER cw AS
SELECT `cik10` AS c1, `name` AS c2, `ticker` AS c3, `sic` AS c4, `hq_state` AS c5, `snapshot_at` AS c6 FROM cw.seed_submissions_snapshot;

CACHE TABLE cw.opq_seed_submissions_snapshot;

CREATE SCHEMASTORE VIEW opq_frames_revenues_cy2025q1 WITH CONTAINER cw AS
SELECT `cik` AS c1, `entityName` AS c2, `loc` AS c3, `start` AS c4, `end` AS c5, `val` AS c6, `accn` AS c7 FROM cw.frames_Revenues_CY2025Q1;

CACHE TABLE cw.opq_frames_revenues_cy2025q1;

CREATE SCHEMASTORE VIEW opq_fema_declarations_dr_2025q1 WITH CONTAINER cw AS
SELECT `disaster_number` AS c1, `state` AS c2, `declaration_date` AS c3, `incident_type` AS c4, `declaration_title` AS c5, `declaration_type` AS c6, `fips_state_code` AS c7, `fips_county_code` AS c8, `designated_area` AS c9 FROM cw.fema_declarations_dr_2025q1;

CACHE TABLE cw.opq_fema_declarations_dr_2025q1;

CREATE SCHEMASTORE VIEW opq_utility_states WITH CONTAINER cw AS
SELECT `cik` AS c1, `state` AS c2 FROM cw.utility_states;

CACHE TABLE cw.opq_utility_states;

CREATE SCHEMASTORE VIEW opq_states WITH CONTAINER cw AS
SELECT `code` AS c1, `name` AS c2, `fips` AS c3 FROM cw.states;

CACHE TABLE cw.opq_states;

CREATE SCHEMASTORE VIEW opq_seed_stations WITH CONTAINER cw AS
SELECT `id` AS c1, `state` AS c2, `name` AS c3 FROM cw.seed_stations;

CACHE TABLE cw.opq_seed_stations;

CREATE SCHEMASTORE VIEW opq_stations WITH CONTAINER cw AS
SELECT `id` AS c1, `state` AS c2, `name` AS c3, `latitude` AS c4, `longitude` AS c5 FROM cw.stations;

CACHE TABLE cw.opq_stations;

CREATE SCHEMASTORE VIEW opq_sic_codes WITH CONTAINER cw AS
SELECT `code` AS c1, `description` AS c2, `division` AS c3, `division_desc` AS c4, `major_group` AS c5, `major_group_desc` AS c6 FROM cw.sic_codes;

CACHE TABLE cw.opq_sic_codes;
