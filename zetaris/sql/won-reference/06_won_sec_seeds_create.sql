-- =============================================================================
-- Source: SEC EDGAR XBRL APIs (the same three endpoints as 01_won_sec_create.sql):
--   submissions     https://data.sec.gov/submissions/CIK<cik10>.json
--                   the profile of every seed utility in seeds/utilities.json
--   companyconcept  https://data.sec.gov/api/xbrl/companyconcept/CIK<cik10>/us-gaap/<tag>.json
--                   the full history of the demo and warm-run utilities (FirstEnergy
--                   0001031296, American Electric Power 0000004904) under the tags
--                   each one uses (Revenues and RevenueFromContractWithCustomer-
--                   ExcludingAssessedTax; both answer 404 for
--                   RegulatedAndUnregulatedOperatingRevenue, checked 2026-10-24)
-- Licence: SEC data is public; filings are filer-authored, so the extracted
-- facts are queried live and never redistributed (counts and schemas only in
-- this repo). https://www.sec.gov/privacy#dissemination
-- Format: REST/JSON (CREATE LIGHTNING REST TABLE), one SchemaStore view per raw
-- table in the shared container `won`; the view shapes are those of 01_won_sec.
-- Docs: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
-- Rate limit: 10 requests/second with a declared User-Agent; the placeholder is
-- replaced at run time from WON_USER_AGENT (gateway/run_sql.py, the registrar).
-- Every CREATE and every CACHE is one SEC request: this file makes 2 x (39 + 4)
-- = 86 requests, spaced by the runner.
-- Status: run live 2026-10-24 against Zetaris 2.4.3.1 (local Docker); counts
-- and timings in ../README.md.
-- =============================================================================
--
-- Caveats:
--   1. 01_won_sec_create.sql already registers the submissions of four seeds
--      (Duke Energy, Southern Co, Xcel Energy, Entergy); this file adds the
--      other 39, so 01 + 06 together hold all 43 of seeds/utilities.json. The
--      statement text is what the gateway registrar renders for
--      register_submission(cik10) and register_concept(cik10, tag).
--   2. The USL utility table (05_won_usl_create.sql step 7) is activated over
--      the 43 submission views, so this file runs before that step.
--   3. Run with --skip-exists on an instance that already holds some of these
--      objects; a re-run re-caches every view (one SEC request each).
--   4. The seed order below is the order of seeds/utilities.json.
-- =============================================================================

-- Step 1: submissions profiles of the 39 seeds not registered by 01_won_sec_create.sql.

-- NEXTERA ENERGY INC, CIK 0000753308
CREATE LIGHTNING REST TABLE submissions_0000753308 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000753308.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000753308 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000753308;

CACHE TABLE won.submission_0000753308;

-- AMERICAN ELECTRIC POWER CO INC, CIK 0000004904
CREATE LIGHTNING REST TABLE submissions_0000004904 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000004904.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000004904 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000004904;

CACHE TABLE won.submission_0000004904;

-- Evergy, Inc., CIK 0001711269
CREATE LIGHTNING REST TABLE submissions_0001711269 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001711269.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001711269 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001711269;

CACHE TABLE won.submission_0001711269;

-- AMEREN CORP, CIK 0001002910
CREATE LIGHTNING REST TABLE submissions_0001002910 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001002910.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001002910 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001002910;

CACHE TABLE won.submission_0001002910;

-- CMS ENERGY CORP, CIK 0000811156
CREATE LIGHTNING REST TABLE submissions_0000811156 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000811156.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000811156 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000811156;

CACHE TABLE won.submission_0000811156;

-- DTE ENERGY CO, CIK 0000936340
CREATE LIGHTNING REST TABLE submissions_0000936340 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000936340.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000936340 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000936340;

CACHE TABLE won.submission_0000936340;

-- WEC ENERGY GROUP, INC., CIK 0000783325
CREATE LIGHTNING REST TABLE submissions_0000783325 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000783325.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000783325 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000783325;

CACHE TABLE won.submission_0000783325;

-- ALLIANT ENERGY CORP, CIK 0000352541
CREATE LIGHTNING REST TABLE submissions_0000352541 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000352541.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000352541 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000352541;

CACHE TABLE won.submission_0000352541;

-- PPL Corp, CIK 0000922224
CREATE LIGHTNING REST TABLE submissions_0000922224 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000922224.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000922224 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000922224;

CACHE TABLE won.submission_0000922224;

-- FIRSTENERGY CORP, CIK 0001031296
CREATE LIGHTNING REST TABLE submissions_0001031296 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001031296.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001031296 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001031296;

CACHE TABLE won.submission_0001031296;

-- PUBLIC SERVICE ENTERPRISE GROUP INC, CIK 0000788784
CREATE LIGHTNING REST TABLE submissions_0000788784 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000788784.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000788784 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000788784;

CACHE TABLE won.submission_0000788784;

-- CONSOLIDATED EDISON INC, CIK 0001047862
CREATE LIGHTNING REST TABLE submissions_0001047862 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001047862.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001047862 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001047862;

CACHE TABLE won.submission_0001047862;

-- EVERSOURCE ENERGY, CIK 0000072741
CREATE LIGHTNING REST TABLE submissions_0000072741 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000072741.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000072741 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000072741;

CACHE TABLE won.submission_0000072741;

-- EXELON CORP, CIK 0001109357
CREATE LIGHTNING REST TABLE submissions_0001109357 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001109357.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001109357 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001109357;

CACHE TABLE won.submission_0001109357;

-- EDISON INTERNATIONAL, CIK 0000827052
CREATE LIGHTNING REST TABLE submissions_0000827052 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000827052.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000827052 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000827052;

CACHE TABLE won.submission_0000827052;

-- PG&E Corp, CIK 0001004980
CREATE LIGHTNING REST TABLE submissions_0001004980 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001004980.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001004980 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001004980;

CACHE TABLE won.submission_0001004980;

-- SEMPRA, CIK 0001032208
CREATE LIGHTNING REST TABLE submissions_0001032208 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001032208.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001032208 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001032208;

CACHE TABLE won.submission_0001032208;

-- PINNACLE WEST CAPITAL CORP, CIK 0000764622
CREATE LIGHTNING REST TABLE submissions_0000764622 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000764622.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000764622 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000764622;

CACHE TABLE won.submission_0000764622;

-- PORTLAND GENERAL ELECTRIC CO /OR/, CIK 0000784977
CREATE LIGHTNING REST TABLE submissions_0000784977 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000784977.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000784977 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000784977;

CACHE TABLE won.submission_0000784977;

-- IDACORP INC, CIK 0001057877
CREATE LIGHTNING REST TABLE submissions_0001057877 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001057877.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001057877 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001057877;

CACHE TABLE won.submission_0001057877;

-- NorthWestern Energy Group, Inc., CIK 0001993004
CREATE LIGHTNING REST TABLE submissions_0001993004 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001993004.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001993004 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001993004;

CACHE TABLE won.submission_0001993004;

-- BLACK HILLS CORP /SD/, CIK 0001130464
CREATE LIGHTNING REST TABLE submissions_0001130464 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001130464.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001130464 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001130464;

CACHE TABLE won.submission_0001130464;

-- AVISTA CORP, CIK 0000104918
CREATE LIGHTNING REST TABLE submissions_0000104918 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000104918.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000104918 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000104918;

CACHE TABLE won.submission_0000104918;

-- OGE ENERGY CORP., CIK 0001021635
CREATE LIGHTNING REST TABLE submissions_0001021635 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001021635.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001021635 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001021635;

CACHE TABLE won.submission_0001021635;

-- CENTERPOINT ENERGY INC, CIK 0001130310
CREATE LIGHTNING REST TABLE submissions_0001130310 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001130310.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001130310 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001130310;

CACHE TABLE won.submission_0001130310;

-- Vistra Corp., CIK 0001692819
CREATE LIGHTNING REST TABLE submissions_0001692819 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001692819.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001692819 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001692819;

CACHE TABLE won.submission_0001692819;

-- NRG ENERGY, INC., CIK 0001013871
CREATE LIGHTNING REST TABLE submissions_0001013871 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001013871.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001013871 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001013871;

CACHE TABLE won.submission_0001013871;

-- HAWAIIAN ELECTRIC INDUSTRIES INC, CIK 0000354707
CREATE LIGHTNING REST TABLE submissions_0000354707 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000354707.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000354707 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000354707;

CACHE TABLE won.submission_0000354707;

-- ALLETE INC, CIK 0000066756
CREATE LIGHTNING REST TABLE submissions_0000066756 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000066756.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000066756 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000066756;

CACHE TABLE won.submission_0000066756;

-- Otter Tail Corp, CIK 0001466593
CREATE LIGHTNING REST TABLE submissions_0001466593 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001466593.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001466593 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001466593;

CACHE TABLE won.submission_0001466593;

-- MGE ENERGY INC, CIK 0001161728
CREATE LIGHTNING REST TABLE submissions_0001161728 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001161728.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001161728 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001161728;

CACHE TABLE won.submission_0001161728;

-- UNITIL CORP, CIK 0000755001
CREATE LIGHTNING REST TABLE submissions_0000755001 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000755001.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000755001 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000755001;

CACHE TABLE won.submission_0000755001;

-- TXNM ENERGY INC, CIK 0001108426
CREATE LIGHTNING REST TABLE submissions_0001108426 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001108426.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001108426 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001108426;

CACHE TABLE won.submission_0001108426;

-- DOMINION ENERGY, INC, CIK 0000715957
CREATE LIGHTNING REST TABLE submissions_0000715957 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000715957.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000715957 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000715957;

CACHE TABLE won.submission_0000715957;

-- Constellation Energy Corp, CIK 0001868275
CREATE LIGHTNING REST TABLE submissions_0001868275 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001868275.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001868275 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001868275;

CACHE TABLE won.submission_0001868275;

-- NISOURCE INC., CIK 0001111711
CREATE LIGHTNING REST TABLE submissions_0001111711 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001111711.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001111711 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001111711;

CACHE TABLE won.submission_0001111711;

-- ONCOR ELECTRIC DELIVERY CO LLC, CIK 0001193311
CREATE LIGHTNING REST TABLE submissions_0001193311 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001193311.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001193311 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001193311;

CACHE TABLE won.submission_0001193311;

-- TUCSON ELECTRIC POWER CO, CIK 0000100122
CREATE LIGHTNING REST TABLE submissions_0000100122 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000100122.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000100122 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000100122;

CACHE TABLE won.submission_0000100122;

-- TAMPA ELECTRIC CO, CIK 0000096271
CREATE LIGHTNING REST TABLE submissions_0000096271 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000096271.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000096271 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000096271;

CACHE TABLE won.submission_0000096271;

-- Step 2: companyconcept history of the demo and warm-run utilities, per (filer, tag) the filer uses.

-- FIRSTENERGY CORP, CIK 0001031296, Revenues
CREATE LIGHTNING REST TABLE concept_0001031296_Revenues FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0001031296/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0001031296_Revenues WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0001031296_Revenues
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0001031296_Revenues;

-- FIRSTENERGY CORP, CIK 0001031296, RevenueFromContractWithCustomerExcludingAssessedTax
CREATE LIGHTNING REST TABLE concept_0001031296_RevenueFromContractWithCustomerExcludingAssessedTax FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0001031296/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0001031296_RevenueFromContractWithCustomerExcludingAssessedTax WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0001031296_RevenueFromContractWithCustomerExcludingAssessedTax
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0001031296_RevenueFromContractWithCustomerExcludingAssessedTax;

-- AMERICAN ELECTRIC POWER CO INC, CIK 0000004904, Revenues
CREATE LIGHTNING REST TABLE concept_0000004904_Revenues FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000004904/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0000004904_Revenues WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0000004904_Revenues
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0000004904_Revenues;

-- AMERICAN ELECTRIC POWER CO INC, CIK 0000004904, RevenueFromContractWithCustomerExcludingAssessedTax
CREATE LIGHTNING REST TABLE concept_0000004904_RevenueFromContractWithCustomerExcludingAssessedTax FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000004904/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0000004904_RevenueFromContractWithCustomerExcludingAssessedTax WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0000004904_RevenueFromContractWithCustomerExcludingAssessedTax
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0000004904_RevenueFromContractWithCustomerExcludingAssessedTax;
