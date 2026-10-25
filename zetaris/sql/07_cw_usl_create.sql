-- =============================================================================
-- USL crosswalk_usl in lightning.metastore.crosswalk: seven tables with primary
-- and foreign keys, descriptions, and one activation per table from the cached
-- SchemaStore views of 01 (FEMA), 02 (stations), 03 (SEC), 04 (SIC) and 05
-- (seeds). The foreign keys ARE the join map: every FK was measured first in
-- 06_cw_joinmap_select.sql; RUN DQ on a FK rule lists the orphans.
--
-- Rules: one statement per call. The COMPILE USL statement is sent as ONE
-- statement (the runner merges the CREATE TABLE parts back into it). Description
-- text is unquoted and contains no semicolon, apostrophe or parenthesis.
--
-- Status: run live 2026-10-25 against Zetaris 2.4.3.1; outcomes, counts and DQ
-- timings in ../README.md.
--
-- Caveats:
--   1. tag is a reserved word in the Lightning catalog parser: the column is
--      xbrl_tag (sister entry, 2026-10-24). Composite primary keys are table-level.
--   2. Activation source: cached SchemaStore views, not the raw REST tables. A raw
--      REST table re-fetches its endpoint on every read, so a USL table bound to
--      one would call SEC EDGAR or FEMA on every USL read and every RUN DQ. The
--      first activation (state) is the test that activation from a view works.
--   3. station is restricted to the 56 seed stations so that the FK state -> state
--      holds (the inventory also has territories outside the state reference).
--   4. revenue_quarter keeps only the seed filers (FK cik -> utility). The frames
--      endpoint serves one fact per filer and period, so PK cik + xbrl_tag + period
--      is unique; val is cast to DOUBLE (frames infer bigint for some periods).
--   5. weather_quarter is not in this model: the GHCN parquet tables are not
--      registered under CW_GHCN on Day 0 (the Day-1 lane adds them if needed); the
--      weather read stays on the cached views.
--   6. A re-run of ACTIVATE with a changed query re-binds the table and keeps the
--      DQ rules.
-- =============================================================================

-- Step 0: namespaces. The parent must exist before the child.
CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.crosswalk;

-- Step 1: the model, seven tables, ONE statement. Parents before children.
COMPILE USL IF NOT EXISTS crosswalk_usl DEPLOY NAMESPACE lightning.metastore.crosswalk DDL
CREATE TABLE state (
    code varchar(2) NOT NULL PRIMARY KEY,
    name varchar(40),
    fips varchar(2)
);
CREATE TABLE sic_code (
    sic varchar(4) NOT NULL PRIMARY KEY,
    division varchar(1),
    description varchar(200)
);
CREATE TABLE utility (
    cik varchar(10) NOT NULL PRIMARY KEY,
    name varchar(200),
    ticker varchar(10),
    sic varchar(4) FOREIGN KEY REFERENCES sic_code(sic)
);
CREATE TABLE utility_state (
    cik varchar(10) NOT NULL FOREIGN KEY REFERENCES utility(cik),
    state varchar(2) NOT NULL FOREIGN KEY REFERENCES state(code),
    PRIMARY KEY (cik, state)
);
CREATE TABLE fema_declaration (
    disaster_number int NOT NULL,
    fips_county varchar(3) NOT NULL,
    state varchar(2) FOREIGN KEY REFERENCES state(code),
    fips_state varchar(2),
    declaration_date varchar(24),
    incident_type varchar(40),
    title varchar(200),
    designated_area varchar(120),
    PRIMARY KEY (disaster_number, fips_county)
);
CREATE TABLE station (
    id varchar(11) NOT NULL PRIMARY KEY,
    state varchar(2) FOREIGN KEY REFERENCES state(code),
    name varchar(60)
);
CREATE TABLE revenue_quarter (
    cik varchar(10) NOT NULL FOREIGN KEY REFERENCES utility(cik),
    xbrl_tag varchar(60) NOT NULL,
    period varchar(8) NOT NULL,
    val double,
    accn varchar(25),
    PRIMARY KEY (cik, xbrl_tag, period)
);

-- Step 2: descriptions (the planner prompt is built from LOAD USL output).
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl SET DESCRIPTION Crosswalk model - US states, investor-owned electric utilities from SEC EDGAR with the states they serve, FEMA major-disaster declarations of Q1 2025, GHCN airport weather stations and quarterly revenue facts. Every foreign key is a join key that was measured in Lightning SQL before it was declared.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.state SET TABLE DESCRIPTION State reference - 50 states and DC with the two-letter postal code and the two-digit FIPS code. Territories are absent by design.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.sic_code SET TABLE DESCRIPTION SIC code reference from company_dns V4. Electric utilities are 4911, 4931 and 4932.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.utility SET TABLE DESCRIPTION One row per seed utility from the EDGAR submissions endpoint - cik as a zero padded 10-digit string, name, ticker, SIC. MGE Energy reports SIC 4900, which the reference lacks - the one known FK orphan.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.utility_state SET TABLE DESCRIPTION Service territory - one row per utility and state it serves, curated from the FY2024 Form 10-K service-territory descriptions, capped at 6 states per utility.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.fema_declaration SET TABLE DESCRIPTION FEMA major-disaster declarations declared in Q1 2025 - one row per designated area, with the state, declaration date, incident type and title from OpenFEMA DisasterDeclarationsSummaries v2.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.station SET TABLE DESCRIPTION GHCN-Daily first-order airport stations used as the weather proxy for a state - the 56 seed stations with the state parsed from ghcnd-stations.txt columns 39-40.;
UPDATE USL lightning.metastore.crosswalk.crosswalk_usl.revenue_quarter SET TABLE DESCRIPTION Quarterly revenue facts of the seed utilities from SEC frames for CY2025Q1 and CY2024Q1 under three tags - val in US dollars, accn the filing the frames endpoint served.;

-- Step 3: activations, parents first. state is the activation-from-a-view test.
ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.state AS
SELECT COALESCE(code, '') AS code, name AS name, fips AS fips FROM cw.states;

ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.sic_code AS
SELECT COALESCE(code, '') AS sic, division AS division, description AS description FROM cw.sic_codes;

ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.utility AS
SELECT COALESCE(cik, '') AS cik, name AS name, ticker AS ticker, sic AS sic FROM cw.seed_utilities;

ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.utility_state AS
SELECT COALESCE(cik, '') AS cik, COALESCE(state, '') AS state FROM cw.utility_states;

ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.fema_declaration AS
SELECT COALESCE(CAST(disaster_number AS INT), 0) AS disaster_number, COALESCE(fips_county_code, '') AS fips_county, state AS state,
       fips_state_code AS fips_state, declaration_date AS declaration_date, incident_type AS incident_type,
       declaration_title AS title, designated_area AS designated_area
FROM cw.fema_declarations_dr_2025q1;

ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.station AS
SELECT COALESCE(id, '') AS id, state AS state, name AS name
FROM cw.stations
WHERE id IN ('USW00013876', 'USW00013963', 'USW00023183', 'USW00023174', 'USW00023234', 'USW00003017', 'USW00014740', 'USW00013781', 'USW00012839', 'USW00012842', 'USW00013874', 'USW00022521', 'USW00014933', 'USW00024131', 'USW00094846', 'USW00014842', 'USW00093819', 'USW00093817', 'USW00013996', 'USW00093821', 'USW00012916', 'USW00014739', 'USW00093721', 'USW00093720', 'USW00094847', 'USW00014836', 'USW00014922', 'USW00014913', 'USW00013994', 'USW00003940', 'USW00024033', 'USW00013722', 'USW00024011', 'USW00014745', 'USW00014734', 'USW00093730', 'USW00023050', 'USW00094728', 'USW00014821', 'USW00014820', 'USW00013967', 'USW00024229', 'USW00013739', 'USW00094823', 'USW00014765', 'USW00013883', 'USW00014944', 'USW00024090', 'USW00003927', 'USW00012960', 'USW00013737', 'USW00024233', 'USW00014839', 'USW00014837', 'USW00013866', 'USW00024018');

ACTIVATE USL TABLE lightning.metastore.crosswalk.crosswalk_usl.revenue_quarter AS
SELECT COALESCE(LPAD(CAST(f.cik AS STRING), 10, '0'), '') AS cik, COALESCE(f.xbrl_tag, '') AS xbrl_tag, COALESCE(f.period, '') AS period,
       CAST(f.val AS DOUBLE) AS val, f.accn AS accn
FROM (
  SELECT cik, val, accn, 'Revenues' AS xbrl_tag, 'CY2025Q1' AS period FROM cw.frames_Revenues_CY2025Q1
  UNION ALL SELECT cik, val, accn, 'Revenues' AS xbrl_tag, 'CY2024Q1' AS period FROM cw.frames_Revenues_CY2024Q1
  UNION ALL SELECT cik, val, accn, 'RevenueFromContractWithCustomerExcludingAssessedTax' AS xbrl_tag, 'CY2025Q1' AS period FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
  UNION ALL SELECT cik, val, accn, 'RevenueFromContractWithCustomerExcludingAssessedTax' AS xbrl_tag, 'CY2024Q1' AS period FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1
  UNION ALL SELECT cik, val, accn, 'RegulatedAndUnregulatedOperatingRevenue' AS xbrl_tag, 'CY2025Q1' AS period FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
  UNION ALL SELECT cik, val, accn, 'RegulatedAndUnregulatedOperatingRevenue' AS xbrl_tag, 'CY2024Q1' AS period FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1
) f
WHERE CAST(f.cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);

-- Next: verify and run DQ with 07_cw_usl_select.sql (--timeout 900)
