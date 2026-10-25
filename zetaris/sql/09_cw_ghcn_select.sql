-- =============================================================================
-- Verification for 09_cw_ghcn_create.sql (or the four register_source calls
-- that ran the same statements). Every statement reads the cached views.
-- Expected values: ../README.md.
-- =============================================================================

-- 1. Schema of one view: 7 columns, DATA_VALUE bigint (tenths of a degree C).
DESCRIBE cw.ghcn_2025_tmax;

-- 2. The cached views: rows, stations (57 = 56 seeds + the validation station) and date range.
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM cw.ghcn_2025_tmax;
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM cw.ghcn_2025_tmin;
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM cw.ghcn_2024_tmax;
SELECT COUNT(*) AS n, COUNT(DISTINCT ID) AS stations, MIN(DATE) AS first_date, MAX(DATE) AS last_date FROM cw.ghcn_2024_tmin;

-- 3. Degree days, the gateway's weather_quarter template rendered for 2025 Q1 and the
-- validation stations. The sister entry's pyarrow computation over the same files gave
-- USW00013740 HDD 2022.69, CDD 22.08, 90 days; USW00013722 HDD 1538.88, CDD 28.41, 90 days.
SELECT x.ID AS station_id, 2025 AS year, 1 AS quarter, SUM(GREATEST(0, 65 - (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32))) AS hdd, SUM(GREATEST(0, (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32) - 65)) AS cdd, COUNT(*) AS days_observed, CASE 1 WHEN 1 THEN CASE WHEN 2025 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS days_in_quarter, COUNT(*) / CAST(CASE 1 WHEN 1 THEN CASE WHEN 2025 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS DOUBLE) AS coverage FROM cw.ghcn_2025_tmax x JOIN cw.ghcn_2025_tmin n ON n.ID = x.ID AND n.DATE = x.DATE WHERE x.ID IN ('USW00013740', 'USW00013722') AND CAST(substr(x.DATE, 5, 2) AS INT) BETWEEN 3 * 1 - 2 AND 3 * 1 AND (x.Q_FLAG IS NULL OR x.Q_FLAG = '') AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '') GROUP BY x.ID ORDER BY x.ID;

-- 4. The same for 2024 Q1 (leap year, 91 days). Sister entry: USW00013740 HDD 1672.53,
-- CDD 9.18, 91 days; USW00013722 HDD 1333.50, CDD 9.99, 91 days.
SELECT x.ID AS station_id, 2024 AS year, 1 AS quarter, SUM(GREATEST(0, 65 - (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32))) AS hdd, SUM(GREATEST(0, (((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32) - 65)) AS cdd, COUNT(*) AS days_observed, CASE 1 WHEN 1 THEN CASE WHEN 2024 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS days_in_quarter, COUNT(*) / CAST(CASE 1 WHEN 1 THEN CASE WHEN 2024 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS DOUBLE) AS coverage FROM cw.ghcn_2024_tmax x JOIN cw.ghcn_2024_tmin n ON n.ID = x.ID AND n.DATE = x.DATE WHERE x.ID IN ('USW00013740', 'USW00013722') AND CAST(substr(x.DATE, 5, 2) AS INT) BETWEEN 3 * 1 - 2 AND 3 * 1 AND (x.Q_FLAG IS NULL OR x.Q_FLAG = '') AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '') GROUP BY x.ID ORDER BY x.ID;
