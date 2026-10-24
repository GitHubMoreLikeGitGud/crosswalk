-- =============================================================================
-- Verification and agent queries for weather_or_not_usl (after 05_won_usl_create.sql).
-- A read of a USL table activated over the GHCN filestore views takes minutes
-- (live: station 44 to 88 s, weather_quarter about 3 min, RUN DQ coverage_ok
-- 361 s), so run this file with --timeout 600 (the runner's RUN/SHOW DQ default
-- is 120 s). Never relaunch DQ while an earlier run may still be going.
-- Expected values: ../README.md.
-- =============================================================================

-- 1. The model: tables with their activation flag, and the JSON the planner reads.
SHOW NAMESPACES OR TABLES IN lightning.metastore.weatherornot;
LOAD USL weather_or_not_usl NAMESPACE lightning.metastore.weatherornot;

-- 2. station: 57 rows, every one with a state (no seed gap).
SELECT COUNT(*) AS n, COUNT(state) AS with_state FROM lightning.metastore.weatherornot.weather_or_not_usl.station;
SELECT id, state, name FROM lightning.metastore.weatherornot.weather_or_not_usl.station ORDER BY id;

-- 3. weather_quarter: 57 stations x 2 years x 3 quarters = 342 rows when every
-- station has data in every quarter.
SELECT COUNT(*) AS n, COUNT(DISTINCT station_id) AS stations, MIN(coverage) AS min_coverage, SUM(CASE WHEN coverage < 0.9 THEN 1 ELSE 0 END) AS below_09
FROM lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter;

-- 4. The validation station: must match the pyarrow computation to 0.01
-- (2025 Q1 HDD 2022.69, CDD 22.08, 90 days; 2024 Q1 HDD 1672.53, CDD 9.18, 91 days).
SELECT station_id, year, quarter, hdd, cdd, days_observed, coverage
FROM lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter
WHERE station_id = 'USW00013740'
ORDER BY year, quarter;

-- 5. A join inside the USL (the FK path): total degree days per state and
-- quarter, the per-state weather input. The double columns of a USL table are
-- carried as decimals inside the USL layer: AVG(w.hdd + w.cdd), with or without
-- ROUND, fails while encoding the result ("java.math.BigDecimal is not a valid
-- external type for schema of double"); cast the operands to DOUBLE first.
SELECT s.state, w.year, w.quarter, COUNT(*) AS stations, AVG(CAST(w.hdd AS DOUBLE) + CAST(w.cdd AS DOUBLE)) AS tdd, MIN(w.coverage) AS min_coverage
FROM lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter w
JOIN lightning.metastore.weatherornot.weather_or_not_usl.station s ON s.id = w.station_id
WHERE s.state IN ('NC', 'SC', 'FL', 'IN', 'OH', 'KY')
GROUP BY s.state, w.year, w.quarter
ORDER BY s.state, w.year, w.quarter;

-- 6. Join map, station to state coverage: stations per state and the share of
-- station-quarters with coverage of at least 0.9.
SELECT s.state, COUNT(DISTINCT w.station_id) AS stations, COUNT(*) AS station_quarters,
       SUM(CASE WHEN w.coverage >= 0.9 THEN 1 ELSE 0 END) AS covered_quarters
FROM lightning.metastore.weatherornot.weather_or_not_usl.station s
LEFT JOIN lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter w ON w.station_id = s.id
GROUP BY s.state
ORDER BY s.state;

-- 7. Data quality: the rules (keys are named after their columns), the custom
-- rule's counts, and the invalid records the agent's DQ gate reads.
LIST DQ USL lightning.metastore.weatherornot.weather_or_not_usl;
-- Live 2026-10-24: RUN DQ coverage_ok 361 s (342 / 342 / 0); RUN DQ id on station 86 s
-- (57 / 57 / 0); SHOW DQ INVALID RECORD coverage_ok 181 s (0 rows). The FK rule
-- station_id was not run (about six minutes each on this table). SHOW DQ ALL
-- INVALID evaluates every rule and did not return within 900 s; the gateway's
-- dq_invalid template therefore reads the single coverage_ok rule.
RUN DQ coverage_ok TABLE lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter;
RUN DQ station_id TABLE lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter;
RUN DQ id TABLE lightning.metastore.weatherornot.weather_or_not_usl.station;
SHOW DQ INVALID RECORD coverage_ok TABLE lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter;
SHOW DQ ALL INVALID TABLE lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter;

-- 8. DQ-equivalent plain SQL for coverage_ok, used when DQ does not return within
-- the bounded wait.
SELECT station_id, year, quarter, days_observed, coverage
FROM lightning.metastore.weatherornot.weather_or_not_usl.weather_quarter
WHERE NOT (coverage >= 0.9)
ORDER BY station_id, year, quarter;

-- =============================================================================
-- SEC side (steps 6 to 8 of the create file): these tables sit over cached REST
-- views, so their reads and DQ runs take seconds, not minutes.
-- =============================================================================

-- 9. Counts: sic_code 1,005; utility 43 (one per seed); revenue_quarter = the
-- seeds present across the six frames views (one row per filer, tag and period).
SELECT COUNT(*) AS n FROM lightning.metastore.weatherornot.weather_or_not_usl.sic_code;
SELECT COUNT(*) AS n, COUNT(ticker) AS with_ticker, COUNT(DISTINCT sic) AS sic_codes FROM lightning.metastore.weatherornot.weather_or_not_usl.utility;
SELECT xbrl_tag, year, quarter, COUNT(*) AS n, SUM(CASE WHEN is_comparative THEN 1 ELSE 0 END) AS comparatives FROM lightning.metastore.weatherornot.weather_or_not_usl.revenue_quarter GROUP BY xbrl_tag, year, quarter ORDER BY xbrl_tag, year, quarter;

-- 10. The agent's reads (gateway templates usl_utility and usl_revenue) for the demo utility.
SELECT cik, name, ticker, sic, hq_state FROM lightning.metastore.weatherornot.weather_or_not_usl.utility WHERE cik = '0001031296';
SELECT cik, xbrl_tag, year, quarter, val, accn, filed, is_comparative FROM lightning.metastore.weatherornot.weather_or_not_usl.revenue_quarter WHERE cik = '0001031296' AND CONCAT('CY', CAST(year AS STRING), 'Q', CAST(quarter AS STRING)) = 'CY2025Q1' ORDER BY xbrl_tag, accn;

-- 11. A join across the USL (the FK path): each seed's revenue facts with its
-- name and SIC description, for the two Revenues periods.
SELECT u.cik, u.name, s.description AS sic_description, r.year, r.quarter, r.val, r.accn
FROM lightning.metastore.weatherornot.weather_or_not_usl.revenue_quarter r
JOIN lightning.metastore.weatherornot.weather_or_not_usl.utility u ON u.cik = r.cik
LEFT JOIN lightning.metastore.weatherornot.weather_or_not_usl.sic_code s ON s.code = u.sic
WHERE r.xbrl_tag = 'Revenues' AND u.cik IN ('0001031296', '0000004904')
ORDER BY u.cik, r.year;

-- 12. Data quality on the SEC side (onboarding check, run once; timings in
-- ../README.md): the FK rule sic on utility (expect one invalid row, MGE Energy
-- SIC 4900 absent from company_dns), the PK and FK rules on revenue_quarter and
-- the PK rule on sic_code (expect 0 invalid), and the invalid records of the FK rule.
RUN DQ sic TABLE lightning.metastore.weatherornot.weather_or_not_usl.utility;
RUN DQ cik TABLE lightning.metastore.weatherornot.weather_or_not_usl.revenue_quarter;
RUN DQ code TABLE lightning.metastore.weatherornot.weather_or_not_usl.sic_code;
SHOW DQ INVALID RECORD sic TABLE lightning.metastore.weatherornot.weather_or_not_usl.utility;
