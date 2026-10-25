-- =============================================================================
-- Source: SEC EDGAR XBRL APIs, two endpoints under one Lightning database:
--   frames        https://data.sec.gov/api/xbrl/frames/us-gaap/<tag>/USD/CY<yyyy>Q<n>.json
--                 every filer's fact for one tag in one calendar quarter
--   submissions   https://data.sec.gov/submissions/CIK<cik10>.json
--                 the filer's profile (name, SIC, business state)
-- Licence: SEC data is public; filings are filer-authored, so the extracted
-- facts are queried live and never redistributed (counts and schemas only in
-- this repository). https://www.sec.gov/privacy#dissemination
-- Format: REST/JSON (CREATE LIGHTNING REST TABLE), one SchemaStore view per
-- raw table in the shared container `cw`. Shapes (the sister entry checked
-- them live on 2026-10-24; this file re-registers the same objects under
-- CW_SEC in the same shape):
--   frames        {taxonomy, tag, ccp, uom, label, description, pts, data[]}
--                 data = array<struct<accn, cik:bigint, entityName, loc, start, end, val>>
--                 -> LATERAL VIEW explode(data). cik is an integer here.
--   submissions   flat object; only cik (10-digit string), name, sic,
--                 sicDescription and addresses.business.stateOrCountry are
--                 used. Street fields are never selected.
-- Docs: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
-- Rate limit: 10 requests/second with a declared User-Agent (the SEC blocks a
-- missing or default one). The placeholder below is replaced at run time
-- from CW_USER_AGENT in .env.local (gateway/run_sql.py and the gateway
-- registrar); it is never a literal in this repository. A REST table calls
-- its source on every query, so every view is cached right after creation.
-- Status: run live 2026-10-25 against Zetaris 2.4.3.1 (local Docker); the
-- counts and timings are in ../README.md.
-- =============================================================================
--
-- Caveats:
--   1. `entityName`, `sicDescription`, `stateOrCountry` are mixed case and
--      `start` / `end` are reserved words, so they are backticked.
--   2. The frames key is an integer cik; submissions carry a zero-padded
--      10-digit string. Join with LPAD(CAST(f.cik AS STRING), 10, '0') = s.cik
--      (join map statement (a) in 03_cw_sec_select.sql), never as-is.
--   3. frames `val` is inferred double for some periods and bigint for
--      others: CAST(val AS DOUBLE) downstream.
--   4. CREATE LIGHTNING DATABASE accepts no IF NOT EXISTS on 2.4.3.1; rerun
--      with --skip-exists. The container `cw` is created by 01_cw_fema_create.sql.
--   5. Run-time registration of further periods and filers goes through the
--      gateway registrar plans (register_frames, register_submission), never
--      by editing this file.
--   6. Three tags x two periods = 6 frames tables, and one submissions table
--      per seed utility of seeds/utilities.json (43), generated from that file.
-- =============================================================================

-- Step 0: the Lightning database. No endpoint call.
CREATE LIGHTNING DATABASE CW_SEC DESCRIBE BY "Crosswalk - SEC EDGAR XBRL frames and submissions REST source";

-- ---------------------------------------------------------------------------
-- Step 1: frames, the two comparison quarters (CY2025Q1 vs CY2024Q1) for the
-- three revenue tags. Each CREATE and each CACHE calls the endpoint once.
-- ---------------------------------------------------------------------------
CREATE LIGHTNING REST TABLE frames_Revenues_CY2025Q1 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_Revenues_CY2025Q1 WITH CONTAINER cw AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM CW_SEC.frames_Revenues_CY2025Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE cw.frames_Revenues_CY2025Q1;

CREATE LIGHTNING REST TABLE frames_Revenues_CY2024Q1 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2024Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_Revenues_CY2024Q1 WITH CONTAINER cw AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM CW_SEC.frames_Revenues_CY2024Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE cw.frames_Revenues_CY2024Q1;

CREATE LIGHTNING REST TABLE frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY2025Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1 WITH CONTAINER cw AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM CW_SEC.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1;

CREATE LIGHTNING REST TABLE frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY2024Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1 WITH CONTAINER cw AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM CW_SEC.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1;

CREATE LIGHTNING REST TABLE frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RegulatedAndUnregulatedOperatingRevenue/USD/CY2025Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 WITH CONTAINER cw AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM CW_SEC.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1;

CREATE LIGHTNING REST TABLE frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RegulatedAndUnregulatedOperatingRevenue/USD/CY2024Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 WITH CONTAINER cw AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM CW_SEC.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1;

-- ---------------------------------------------------------------------------
-- Step 2: submissions profiles of the 43 seed utilities (seeds/utilities.json
-- order). Scalars only, never street fields.
-- ---------------------------------------------------------------------------
CREATE LIGHTNING REST TABLE submissions_0001326160 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001326160.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001326160 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001326160;

CACHE TABLE cw.submission_0001326160;

CREATE LIGHTNING REST TABLE submissions_0000092122 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000092122.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000092122 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000092122;

CACHE TABLE cw.submission_0000092122;

CREATE LIGHTNING REST TABLE submissions_0000753308 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000753308.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000753308 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000753308;

CACHE TABLE cw.submission_0000753308;

CREATE LIGHTNING REST TABLE submissions_0000004904 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000004904.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000004904 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000004904;

CACHE TABLE cw.submission_0000004904;

CREATE LIGHTNING REST TABLE submissions_0000072903 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000072903.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000072903 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000072903;

CACHE TABLE cw.submission_0000072903;

CREATE LIGHTNING REST TABLE submissions_0000065984 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000065984.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000065984 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000065984;

CACHE TABLE cw.submission_0000065984;

CREATE LIGHTNING REST TABLE submissions_0001711269 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001711269.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001711269 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001711269;

CACHE TABLE cw.submission_0001711269;

CREATE LIGHTNING REST TABLE submissions_0001002910 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001002910.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001002910 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001002910;

CACHE TABLE cw.submission_0001002910;

CREATE LIGHTNING REST TABLE submissions_0000811156 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000811156.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000811156 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000811156;

CACHE TABLE cw.submission_0000811156;

CREATE LIGHTNING REST TABLE submissions_0000936340 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000936340.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000936340 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000936340;

CACHE TABLE cw.submission_0000936340;

CREATE LIGHTNING REST TABLE submissions_0000783325 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000783325.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000783325 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000783325;

CACHE TABLE cw.submission_0000783325;

CREATE LIGHTNING REST TABLE submissions_0000352541 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000352541.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000352541 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000352541;

CACHE TABLE cw.submission_0000352541;

CREATE LIGHTNING REST TABLE submissions_0000922224 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000922224.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000922224 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000922224;

CACHE TABLE cw.submission_0000922224;

CREATE LIGHTNING REST TABLE submissions_0001031296 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001031296.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001031296 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001031296;

CACHE TABLE cw.submission_0001031296;

CREATE LIGHTNING REST TABLE submissions_0000788784 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000788784.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000788784 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000788784;

CACHE TABLE cw.submission_0000788784;

CREATE LIGHTNING REST TABLE submissions_0001047862 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001047862.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001047862 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001047862;

CACHE TABLE cw.submission_0001047862;

CREATE LIGHTNING REST TABLE submissions_0000072741 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000072741.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000072741 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000072741;

CACHE TABLE cw.submission_0000072741;

CREATE LIGHTNING REST TABLE submissions_0001109357 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001109357.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001109357 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001109357;

CACHE TABLE cw.submission_0001109357;

CREATE LIGHTNING REST TABLE submissions_0000827052 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000827052.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000827052 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000827052;

CACHE TABLE cw.submission_0000827052;

CREATE LIGHTNING REST TABLE submissions_0001004980 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001004980.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001004980 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001004980;

CACHE TABLE cw.submission_0001004980;

CREATE LIGHTNING REST TABLE submissions_0001032208 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001032208.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001032208 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001032208;

CACHE TABLE cw.submission_0001032208;

CREATE LIGHTNING REST TABLE submissions_0000764622 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000764622.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000764622 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000764622;

CACHE TABLE cw.submission_0000764622;

CREATE LIGHTNING REST TABLE submissions_0000784977 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000784977.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000784977 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000784977;

CACHE TABLE cw.submission_0000784977;

CREATE LIGHTNING REST TABLE submissions_0001057877 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001057877.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001057877 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001057877;

CACHE TABLE cw.submission_0001057877;

CREATE LIGHTNING REST TABLE submissions_0001993004 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001993004.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001993004 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001993004;

CACHE TABLE cw.submission_0001993004;

CREATE LIGHTNING REST TABLE submissions_0001130464 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001130464.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001130464 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001130464;

CACHE TABLE cw.submission_0001130464;

CREATE LIGHTNING REST TABLE submissions_0000104918 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000104918.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000104918 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000104918;

CACHE TABLE cw.submission_0000104918;

CREATE LIGHTNING REST TABLE submissions_0001021635 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001021635.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001021635 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001021635;

CACHE TABLE cw.submission_0001021635;

CREATE LIGHTNING REST TABLE submissions_0001130310 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001130310.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001130310 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001130310;

CACHE TABLE cw.submission_0001130310;

CREATE LIGHTNING REST TABLE submissions_0001692819 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001692819.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001692819 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001692819;

CACHE TABLE cw.submission_0001692819;

CREATE LIGHTNING REST TABLE submissions_0001013871 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001013871.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001013871 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001013871;

CACHE TABLE cw.submission_0001013871;

CREATE LIGHTNING REST TABLE submissions_0000354707 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000354707.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000354707 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000354707;

CACHE TABLE cw.submission_0000354707;

CREATE LIGHTNING REST TABLE submissions_0000066756 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000066756.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000066756 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000066756;

CACHE TABLE cw.submission_0000066756;

CREATE LIGHTNING REST TABLE submissions_0001466593 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001466593.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001466593 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001466593;

CACHE TABLE cw.submission_0001466593;

CREATE LIGHTNING REST TABLE submissions_0001161728 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001161728.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001161728 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001161728;

CACHE TABLE cw.submission_0001161728;

CREATE LIGHTNING REST TABLE submissions_0000755001 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000755001.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000755001 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000755001;

CACHE TABLE cw.submission_0000755001;

CREATE LIGHTNING REST TABLE submissions_0001108426 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001108426.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001108426 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001108426;

CACHE TABLE cw.submission_0001108426;

CREATE LIGHTNING REST TABLE submissions_0000715957 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000715957.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000715957 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000715957;

CACHE TABLE cw.submission_0000715957;

CREATE LIGHTNING REST TABLE submissions_0001868275 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001868275.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001868275 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001868275;

CACHE TABLE cw.submission_0001868275;

CREATE LIGHTNING REST TABLE submissions_0001111711 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001111711.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001111711 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001111711;

CACHE TABLE cw.submission_0001111711;

CREATE LIGHTNING REST TABLE submissions_0001193311 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001193311.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001193311 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0001193311;

CACHE TABLE cw.submission_0001193311;

CREATE LIGHTNING REST TABLE submissions_0000100122 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000100122.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000100122 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000100122;

CACHE TABLE cw.submission_0000100122;

CREATE LIGHTNING REST TABLE submissions_0000096271 FROM CW_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000096271.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000096271 WITH CONTAINER cw AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM CW_SEC.submissions_0000096271;

CACHE TABLE cw.submission_0000096271;

-- Next: verify with 03_cw_sec_select.sql
