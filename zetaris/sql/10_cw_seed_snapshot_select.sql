-- =============================================================================
-- Verification for 10_cw_seed_snapshot_create.sql. Every statement reads cached
-- views (sub-second); the expected values are the snapshot file's.
-- =============================================================================

-- 1. Rows, distinct CIKs, tickers present, SIC codes, snapshot times: 43, 43, 40, 4, 1.
SELECT COUNT(*) AS n, COUNT(DISTINCT cik10) AS ciks, COUNT(NULLIF(ticker, '')) AS with_ticker, COUNT(DISTINCT sic) AS sic_codes, COUNT(DISTINCT snapshot_at) AS snapshots FROM cw.seed_submissions_snapshot;

-- 2. Every seed utility of cw.seed_utility_names is in the snapshot with the same SIC.
SELECT COUNT(*) AS named, COUNT(s.cik10) AS in_snapshot, COUNT(CASE WHEN s.sic = n.sic THEN 1 END) AS same_sic FROM cw.seed_utility_names n LEFT JOIN cw.seed_submissions_snapshot s ON s.cik10 = n.cik;

-- 3. The SIC the company_dns reference lacks (MGE Energy, 4900).
SELECT cik10, name, ticker, sic, hq_state FROM cw.seed_submissions_snapshot WHERE sic = '4900';
