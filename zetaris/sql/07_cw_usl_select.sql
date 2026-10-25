-- =============================================================================
-- Verification and DQ for crosswalk_usl (after 07_cw_usl_create.sql). Run with
-- --timeout 900: RUN DQ materialises the table from its sources (cached views;
-- utility and revenue_quarter visit the 43 submission views, about 17 s per read).
-- Expected values: ../README.md.
-- =============================================================================

-- 1. The model: tables with their activation flag, and the JSON the planner reads.
SHOW NAMESPACES OR TABLES IN lightning.metastore.crosswalk;
LOAD USL crosswalk_usl NAMESPACE lightning.metastore.crosswalk;

-- 2. Row counts (expect 51 / 1,005 / 43 / 97 / 116 / 56 / the seed facts in six frames views).
SELECT COUNT(*) AS n FROM lightning.metastore.crosswalk.crosswalk_usl.state;
SELECT COUNT(*) AS n FROM lightning.metastore.crosswalk.crosswalk_usl.sic_code;
SELECT COUNT(*) AS n, COUNT(DISTINCT sic) AS sic_codes FROM lightning.metastore.crosswalk.crosswalk_usl.utility;
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS utilities, COUNT(DISTINCT state) AS states FROM lightning.metastore.crosswalk.crosswalk_usl.utility_state;
SELECT COUNT(*) AS n, COUNT(DISTINCT disaster_number) AS declarations, COUNT(DISTINCT state) AS states FROM lightning.metastore.crosswalk.crosswalk_usl.fema_declaration;
SELECT COUNT(*) AS n, COUNT(state) AS with_state FROM lightning.metastore.crosswalk.crosswalk_usl.station;
SELECT xbrl_tag, period, COUNT(*) AS n FROM lightning.metastore.crosswalk.crosswalk_usl.revenue_quarter GROUP BY xbrl_tag, period ORDER BY xbrl_tag, period;

-- 3. The demo join inside the USL (the FK path): utilities serving a state with a
-- Q1-2025 major-disaster declaration, with the declaration count by state.
SELECT us.state, s.name AS state_name, COUNT(DISTINCT f.disaster_number) AS declarations, COUNT(DISTINCT us.cik) AS utilities
FROM lightning.metastore.crosswalk.crosswalk_usl.fema_declaration f
JOIN lightning.metastore.crosswalk.crosswalk_usl.state s ON s.code = f.state
JOIN lightning.metastore.crosswalk.crosswalk_usl.utility_state us ON us.state = f.state
GROUP BY us.state, s.name ORDER BY declarations DESC, us.state;

-- 4. Data quality: the rules (keys are named after their columns), then RUN DQ on
-- every FK rule (expect invalid = 1 on utility.sic, MGE Energy; 0 elsewhere) and
-- the invalid records of that one rule.
LIST DQ USL lightning.metastore.crosswalk.crosswalk_usl;
RUN DQ sic TABLE lightning.metastore.crosswalk.crosswalk_usl.utility;
RUN DQ cik TABLE lightning.metastore.crosswalk.crosswalk_usl.utility_state;
RUN DQ state TABLE lightning.metastore.crosswalk.crosswalk_usl.utility_state;
RUN DQ state TABLE lightning.metastore.crosswalk.crosswalk_usl.fema_declaration;
RUN DQ state TABLE lightning.metastore.crosswalk.crosswalk_usl.station;
RUN DQ cik TABLE lightning.metastore.crosswalk.crosswalk_usl.revenue_quarter;
SHOW DQ INVALID RECORD sic TABLE lightning.metastore.crosswalk.crosswalk_usl.utility;

-- 5. DQ-equivalent plain SQL for the utility.sic rule, used when DQ does not
-- return within the bounded wait.
SELECT u.cik, u.name, u.sic FROM lightning.metastore.crosswalk.crosswalk_usl.utility u LEFT JOIN lightning.metastore.crosswalk.crosswalk_usl.sic_code s ON s.sic = u.sic WHERE s.sic IS NULL ORDER BY u.cik;
