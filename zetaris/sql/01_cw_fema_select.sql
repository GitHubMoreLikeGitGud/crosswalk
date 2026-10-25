-- Verification for 01_cw_fema_create.sql. Reads the cached views only.

-- Shapes as inferred.
DESCRIBE CW_FEMA.declarations_dr_2025q1;
DESCRIBE cw.fema_declarations_dr_2025q1;

-- Expect 116: the array length of the same response fetched outside Zetaris
-- (2026-10-25).
SELECT COUNT(*) AS n FROM cw.fema_declarations_dr_2025q1;

-- Expect 10 distinct declarations over 8 states.
SELECT COUNT(DISTINCT disaster_number) AS declarations, COUNT(DISTINCT state) AS states FROM cw.fema_declarations_dr_2025q1;

-- Distinct states (expect AK, CA, KY, MO, OK, OR, SC, WV) with their rows and declarations.
SELECT state, COUNT(*) AS designated_areas, COUNT(DISTINCT disaster_number) AS declarations FROM cw.fema_declarations_dr_2025q1 GROUP BY state ORDER BY state;

-- Counts by incident type (expect Severe Storm 107, Fire 6, Flood 3 rows).
SELECT incident_type, COUNT(*) AS designated_areas, COUNT(DISTINCT disaster_number) AS declarations FROM cw.fema_declarations_dr_2025q1 GROUP BY incident_type ORDER BY designated_areas DESC;

-- Every row is a DR declared in Q1 2025 (expect 0).
SELECT COUNT(*) AS outside_filter FROM cw.fema_declarations_dr_2025q1 WHERE declaration_type <> 'DR' OR declaration_date < '2025-01-01' OR declaration_date >= '2025-04-01';

-- Sample rows.
SELECT disaster_number, state, declaration_date, incident_type, declaration_title, fips_state_code, fips_county_code, designated_area FROM cw.fema_declarations_dr_2025q1 ORDER BY disaster_number, fips_county_code LIMIT 5;

-- The catalogue: expect 44 datasets (the array length outside Zetaris, 2026-10-25).
DESCRIBE cw.fema_catalogue;
SELECT COUNT(*) AS n, COUNT(DISTINCT name) AS distinct_names FROM cw.fema_catalogue;
SELECT name, version, title, api_endpoint, last_dataset_refresh FROM cw.fema_catalogue WHERE name LIKE 'Disaster%' ORDER BY name, version;
