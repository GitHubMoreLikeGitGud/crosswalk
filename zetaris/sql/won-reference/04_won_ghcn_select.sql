-- =============================================================================
-- Verification for 04_won_ghcn_create.sql. Every statement is a read; the raw
-- table count scans S3 (about 30 s), everything else reads the cached views.
-- Expected values (2026-10-24, pyarrow over the same files): ../README.md.
-- =============================================================================

-- 1. Schemas of the raw tables: 7 columns, DATA_VALUE bigint (tenths of a degree C).
DESCRIBE WON_GHCN.ghcn_2025_tmax;
DESCRIBE WON_GHCN.ghcn_2025_tmin;
DESCRIBE WON_GHCN.ghcn_2024_tmax;
DESCRIBE WON_GHCN.ghcn_2024_tmin;

-- 2. Gate: one station's day count on the raw table must equal the independent
-- pyarrow count over the 9 files (365 for 2025).
SELECT COUNT(*) AS n FROM WON_GHCN.ghcn_2025_tmax WHERE ID = 'USW00013740';

-- 3. The cached views: rows, stations and date range (57 stations each).
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM won.ghcn_2025_tmax;
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM won.ghcn_2025_tmin;
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM won.ghcn_2024_tmax;
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM won.ghcn_2024_tmin;
SELECT COUNT(*) AS n FROM won.ghcn_2025_tmax WHERE ID = 'USW00013740';

-- 4. Which views exist and whether they carry a cached table.
SHOW DATASOURCE VIEWS;

-- 5. Degree days per station and quarter, the gateway's weather_quarter template
-- rendered for year 2025, quarter 1 and two stations. Tmean F = ((TMAX + TMIN) / 2)
-- in tenths of a degree C, converted to F; HDD = sum(max(0, 65 - Tmean F)),
-- CDD = sum(max(0, Tmean F - 65)); days with a quality flag on either element are
-- dropped; coverage = days_observed / days in the quarter. Must match the pyarrow
-- computation to 0.01: USW00013740 HDD 2022.69, CDD 22.08, 90 days;
-- USW00013722 HDD 1538.88, CDD 28.41, 90 days.
SELECT x.ID AS station_id, 2025 AS year, 1 AS quarter,
  SUM(GREATEST(0, 65 - (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32))) AS hdd,
  SUM(GREATEST(0, (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32) - 65)) AS cdd,
  COUNT(*) AS days_observed,
  CASE 1 WHEN 1 THEN CASE WHEN 2025 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS days_in_quarter,
  COUNT(*) / CAST(CASE 1 WHEN 1 THEN CASE WHEN 2025 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS DOUBLE) AS coverage
FROM won.ghcn_2025_tmax x
JOIN won.ghcn_2025_tmin n ON n.ID = x.ID AND n.DATE = x.DATE
WHERE x.ID IN ('USW00013740', 'USW00013722')
  AND CAST(substr(x.DATE, 5, 2) AS INT) BETWEEN 3 * 1 - 2 AND 3 * 1
  AND (x.Q_FLAG IS NULL OR x.Q_FLAG = '')
  AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '')
GROUP BY x.ID
ORDER BY x.ID;

-- 6. The same for 2024 Q1 (leap year: 91 days). Expected USW00013740 HDD 1672.53,
-- CDD 9.18, 91 days; USW00013722 HDD 1333.50, CDD 9.99, 91 days.
SELECT x.ID AS station_id, 2024 AS year, 1 AS quarter,
  SUM(GREATEST(0, 65 - (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32))) AS hdd,
  SUM(GREATEST(0, (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32) - 65)) AS cdd,
  COUNT(*) AS days_observed,
  CASE 1 WHEN 1 THEN CASE WHEN 2024 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS days_in_quarter,
  COUNT(*) / CAST(CASE 1 WHEN 1 THEN CASE WHEN 2024 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS DOUBLE) AS coverage
FROM won.ghcn_2024_tmax x
JOIN won.ghcn_2024_tmin n ON n.ID = x.ID AND n.DATE = x.DATE
WHERE x.ID IN ('USW00013740', 'USW00013722')
  AND CAST(substr(x.DATE, 5, 2) AS INT) BETWEEN 3 * 1 - 2 AND 3 * 1
  AND (x.Q_FLAG IS NULL OR x.Q_FLAG = '')
  AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '')
GROUP BY x.ID
ORDER BY x.ID;

-- 7. Days with both TMAX and TMIN per station and quarter in 2025 (Q1 to Q3):
-- the coverage input for every seed station in one pass.
SELECT x.ID AS station_id,
  CAST((CAST(substr(x.DATE, 5, 2) AS INT) - 1) / 3 AS INT) + 1 AS quarter,
  COUNT(*) AS days_observed
FROM won.ghcn_2025_tmax x
JOIN won.ghcn_2025_tmin n ON n.ID = x.ID AND n.DATE = x.DATE
WHERE (x.Q_FLAG IS NULL OR x.Q_FLAG = '') AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '')
  AND CAST(substr(x.DATE, 5, 2) AS INT) <= 9
GROUP BY x.ID, CAST((CAST(substr(x.DATE, 5, 2) AS INT) - 1) / 3 AS INT) + 1
ORDER BY x.ID, quarter;
