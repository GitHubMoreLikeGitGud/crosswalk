-- =============================================================================
-- The Day-0 join map: five join keys measured in Lightning SQL over CACHED views
-- only (no raw cross-source join is ever issued). Each key has a counts
-- statement and an orphans statement. Match rate = matched distinct left keys /
-- distinct left keys; VERIFIED at >= 0.95, PARTIAL at >= 0.80, REJECTED below.
-- Prerequisites: 01 (FEMA), 02 (stations), 03 (SEC), 04 (SIC), 05 (seeds).
-- Not a registration: this file has no _create pair. Results and timings in
-- ../README.md. The gateway templates joinmap_* render the same statements.
-- =============================================================================

-- (a) cik: seed submissions cik (10-digit string, left) vs frames cik (integer)
--     under lpad10, over the three CY2025Q1 frames views. The matched count is
--     the number of seed filers with a CY2025Q1 fact under any of the three tags.
SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys
FROM (SELECT DISTINCT cik AS k FROM cw.seed_utilities) l
LEFT JOIN (
  SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_Revenues_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
) r ON r.k = l.k;

-- (the view is referenced once: a second reference to cw.seed_utilities in the same
-- statement fails to resolve on 2.4.3.1, MISSING_ATTRIBUTES.RESOLVED_ATTRIBUTE_APPEAR_IN_OPERATION)
SELECT u.cik AS orphan_cik, u.name
FROM cw.seed_utilities u
LEFT JOIN (
  SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_Revenues_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
) r ON r.k = u.cik
WHERE r.k IS NULL ORDER BY u.cik LIMIT 10;

-- (a, control) the same key under identity (no LPAD): the formats differ, expect 0 matched.
SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys
FROM (SELECT DISTINCT cik AS k FROM cw.seed_utilities) l
LEFT JOIN (SELECT DISTINCT CAST(cik AS STRING) AS k FROM cw.frames_Revenues_CY2025Q1) r ON r.k = l.k;

-- (b) loc: frames loc 'US-XX' under substr(4,2) vs the submissions business-address
--     state, for the seed filers present in the CY2025Q1 frames (any tag). Left key =
--     the seed filer; matched when its frames state equals its submissions state.
SELECT COUNT(DISTINCT l.cik) AS left_keys, COUNT(DISTINCT CASE WHEN l.loc_state = r.hq_state THEN l.cik END) AS matched_keys
FROM (
  SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_Revenues_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
) l
JOIN cw.seed_utilities r ON r.cik = l.cik;

SELECT l.cik, l.loc, l.loc_state, r.hq_state, r.name
FROM (
  SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, loc, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_Revenues_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, loc, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
  UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, loc, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
) l
JOIN cw.seed_utilities r ON r.cik = l.cik
WHERE l.loc_state <> r.hq_state ORDER BY l.cik LIMIT 10;

-- (c) FEMA state (two letters, left) vs utility_state.state under identity.
SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys
FROM (SELECT DISTINCT state AS k FROM cw.fema_declarations_dr_2025q1) l
LEFT JOIN (SELECT DISTINCT state AS k FROM cw.utility_states) r ON r.k = l.k;

SELECT l.k AS orphan_state
FROM (SELECT DISTINCT state AS k FROM cw.fema_declarations_dr_2025q1) l
LEFT JOIN (SELECT DISTINCT state AS k FROM cw.utility_states) r ON r.k = l.k
WHERE r.k IS NULL ORDER BY l.k LIMIT 10;

-- (c, FIPS) FEMA fipsStateCode (left) vs the state reference FIPS under identity.
SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys
FROM (SELECT DISTINCT fips_state_code AS k FROM cw.fema_declarations_dr_2025q1) l
LEFT JOIN (SELECT DISTINCT fips AS k FROM cw.states) r ON r.k = l.k;

-- (c, answer) the utilities the FEMA join selects: served state with >= 1 DR declaration in Q1 2025.
SELECT us.state, COUNT(DISTINCT f.disaster_number) AS declarations, COUNT(DISTINCT us.cik) AS utilities
FROM cw.fema_declarations_dr_2025q1 f
JOIN cw.utility_states us ON us.state = f.state
GROUP BY us.state ORDER BY declarations DESC, us.state;

-- (d) seed station id (left) vs the stations inventory view id under identity,
--     and the state agreement of the matched stations.
SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN l.k END) AS matched_keys,
       COUNT(DISTINCT CASE WHEN r.state = l.state THEN l.k END) AS state_equal
FROM (SELECT DISTINCT id AS k, state FROM cw.seed_stations) l
LEFT JOIN cw.stations r ON r.id = l.k;

SELECT l.k AS orphan_station, l.state AS seed_state, r.state AS inventory_state
FROM (SELECT DISTINCT id AS k, state FROM cw.seed_stations) l
LEFT JOIN cw.stations r ON r.id = l.k
WHERE r.id IS NULL OR r.state <> l.state ORDER BY l.k LIMIT 10;

-- (e) submissions SIC (left) vs sic_codes.code under identity. Two readings:
--     distinct codes (the method's definition) and utilities (rows).
SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys
FROM (SELECT DISTINCT sic AS k FROM cw.seed_utilities) l
LEFT JOIN (SELECT DISTINCT code AS k FROM cw.sic_codes) r ON r.k = l.k;

SELECT COUNT(DISTINCT l.cik) AS left_rows, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.cik END) AS matched_rows
FROM (SELECT cik, sic FROM cw.seed_utilities) l
LEFT JOIN (SELECT DISTINCT code AS k FROM cw.sic_codes) r ON r.k = l.sic;

SELECT l.sic AS orphan_sic, l.cik, l.name
FROM cw.seed_utilities l
LEFT JOIN (SELECT DISTINCT code AS k FROM cw.sic_codes) r ON r.k = l.sic
WHERE r.k IS NULL ORDER BY l.sic, l.cik LIMIT 10;
