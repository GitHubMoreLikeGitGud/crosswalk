-- Verification for 05_cw_seeds_create.sql. Reads the cached views only.

-- Expect 51 / 51 distinct codes / 51 distinct FIPS.
SELECT COUNT(*) AS n, COUNT(DISTINCT code) AS codes, COUNT(DISTINCT fips) AS fips FROM cw.states;

-- Expect 97 pairs over 43 utilities and 43 states, every pair distinct.
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS utilities, COUNT(DISTINCT state) AS states, COUNT(DISTINCT CONCAT(cik, '-', state)) AS distinct_pairs FROM cw.utility_states;

-- Every served state is in the state reference (expect 0 orphans).
SELECT COUNT(DISTINCT u.state) AS served_states, COUNT(DISTINCT CASE WHEN s.code IS NULL THEN u.state END) AS orphans FROM cw.utility_states u LEFT JOIN cw.states s ON s.code = u.state;

-- Expect 56 seed stations.
SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS ids FROM cw.seed_stations;

-- Expect 43 utilities, 43 distinct CIKs, 40 with a ticker, 42 with SIC 4911/4931/4932 and MGE Energy with 4900.
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS ciks, SUM(CASE WHEN ticker <> '' THEN 1 ELSE 0 END) AS with_ticker FROM cw.seed_utilities;
SELECT sic, COUNT(*) AS utilities FROM cw.seed_utilities GROUP BY sic ORDER BY sic;
SELECT cik, name, ticker, sic, hq_state FROM cw.seed_utilities WHERE sic = '4900';
