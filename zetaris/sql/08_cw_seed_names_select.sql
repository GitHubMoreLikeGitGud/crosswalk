-- =============================================================================
-- Verification for 08_cw_seed_names_create.sql. Every statement reads cached
-- views (sub-second). Expected values: ../README.md.
-- =============================================================================

-- 1. Rows, distinct CIKs, tickers present, SIC codes: 43, 43, 40, 4.
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS ciks, COUNT(ticker) AS with_ticker, COUNT(DISTINCT sic) AS sic_codes FROM cw.seed_utility_names;

-- 2. The SIC the reference lacks: MGE Energy, 4900.
SELECT cik, name, ticker, sic FROM cw.seed_utility_names WHERE sic = '4900';

-- 3. Every utility of cw.utility_states has a name row: 43, 43.
SELECT COUNT(DISTINCT us.cik) AS served, COUNT(DISTINCT n.cik) AS named FROM cw.utility_states us LEFT JOIN cw.seed_utility_names n ON n.cik = us.cik;

-- 4. The gateway's answer_fema_utilities template for CY2025Q1: one row per (utility, served
-- state) with a Q1-2025 major-disaster declaration (CA 3, KY 2, MO 2, OK 2, OR 1, SC 2, WV 2 = 14).
SELECT us.cik, n.name, n.ticker, us.state, f.declarations, f.severe_storm, f.fire, f.flood, f.other_incidents FROM cw.utility_states us JOIN (SELECT state, COUNT(DISTINCT disaster_number) AS declarations, COUNT(DISTINCT CASE WHEN incident_type = 'Severe Storm' THEN disaster_number END) AS severe_storm, COUNT(DISTINCT CASE WHEN incident_type = 'Fire' THEN disaster_number END) AS fire, COUNT(DISTINCT CASE WHEN incident_type = 'Flood' THEN disaster_number END) AS flood, COUNT(DISTINCT CASE WHEN incident_type NOT IN ('Severe Storm', 'Fire', 'Flood') THEN disaster_number END) AS other_incidents FROM cw.fema_declarations_dr_2025q1 GROUP BY state) f ON f.state = us.state JOIN cw.seed_utility_names n ON n.cik = us.cik ORDER BY f.declarations DESC, n.name, us.state;
