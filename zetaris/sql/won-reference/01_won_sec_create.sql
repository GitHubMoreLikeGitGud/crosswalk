-- =============================================================================
-- Source: SEC EDGAR XBRL APIs, three endpoints under one Lightning database:
--   frames          https://data.sec.gov/api/xbrl/frames/us-gaap/<tag>/USD/CY<yyyy>Q<n>.json
--                   every filer's fact for one tag in one calendar quarter
--   companyconcept  https://data.sec.gov/api/xbrl/companyconcept/CIK<cik10>/us-gaap/<tag>.json
--                   one filer's full history for one tag, across filings
--   submissions     https://data.sec.gov/submissions/CIK<cik10>.json
--                   the filer's profile (name, SIC, business state)
-- Licence: SEC data is public; filings are filer-authored, so the extracted
-- facts are queried live and never redistributed (counts and schemas only in
-- this repo). https://www.sec.gov/privacy#dissemination
-- Format: REST/JSON (CREATE LIGHTNING REST TABLE), one SchemaStore view per
-- raw table in the shared container `won`. Shapes (checked live 2026-10-24):
--   frames         {taxonomy, tag, ccp, uom, label, description, pts, data[]}
--                  data = array<struct<accn, cik:bigint, entityName, loc, start, end, val>>
--                  -> LATERAL VIEW explode(data). cik is an integer here.
--   companyconcept {cik, taxonomy, tag, label, description, entityName, units: {USD: []}}
--                  USD = array<struct<start, end, val, accn, fy, fp, form, filed[, frame]>>
--                  -> LATERAL VIEW explode(units.USD). `frame` is absent from some
--                  filers' facts, so the views never select it.
--   submissions    flat object; only cik (10-digit string), name, sic,
--                  sicDescription and addresses.business.stateOrCountry are used.
--                  Street fields are never selected.
-- Docs: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
-- Rate limit: 10 requests/second with a declared User-Agent (SEC blocks a
-- missing or default one). The placeholder below is replaced at run time
-- from WON_USER_AGENT in .env.local (gateway/run_sql.py and the gateway
-- registrar); it is never a literal in this repository. A REST table calls
-- its source on every query, so every view is cached right after creation.
-- Status: run live 2026-10-24 against Zetaris 2.4.3.1 (local Docker); the
-- counts and timings are in ../README.md.
-- =============================================================================
--
-- Caveats:
--   1. Quoting: `entityName`, `sicDescription`, `stateOrCountry` are mixed
--      case and `start` / `end` are reserved words, so they are backticked.
--   2. The frames key is an integer cik; submissions carry a zero-padded
--      10-digit string. Join with LPAD(CAST(f.cik AS STRING), 10, '0') = s.cik
--      (see the join map in 01_won_sec_select.sql), never as-is.
--   3. Which tag a utility reports its quarterly revenue under differs:
--      Duke Energy and Xcel Energy have no quarterly `Revenues` facts and
--      report `RegulatedAndUnregulatedOperatingRevenue`; Southern Co and
--      Entergy report `Revenues`. A companyconcept endpoint for a tag the
--      filer never used answers HTTP 404, so concept tables are registered
--      only for tags the filer has (Southern: Revenues only; Entergy:
--      Revenues and RevenueFromContractWithCustomerExcludingAssessedTax).
--   4. Neither CREATE LIGHTNING DATABASE nor CREATE SCHEMASTORE CONTAINER
--      accepts IF NOT EXISTS on 2.4.3.1 (parse error "mismatched input
--      'not'", checked 2026-10-24): run this file with `--skip-exists` on an
--      instance that already has WON_SEC or `won`.
--   5. Run-time registration of further periods and filers goes through
--      the gateway registrar plans (gateway/templates.py register_frames,
--      register_concept, register_submission; the frames text is in
--      03_won_frames_runtime_template.sql), never by editing this file.
-- =============================================================================

-- Step 0: the Lightning database for every SEC raw table, and the shared
-- SchemaStore container (also used by the GHCN views). No endpoint call.
CREATE LIGHTNING DATABASE WON_SEC DESCRIBE BY "Weather-or-Not - SEC EDGAR XBRL frames, companyconcept and submissions REST source";

CREATE SCHEMASTORE CONTAINER won;

-- ---------------------------------------------------------------------------
-- Step 1: frames, the two comparison quarters (CY2025Q1 vs CY2024Q1) for the
-- three revenue tags the method probes, in that order. Each CREATE and each
-- CACHE calls the endpoint once.
-- ---------------------------------------------------------------------------
CREATE LIGHTNING REST TABLE frames_Revenues_CY2025Q1 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_Revenues_CY2025Q1 WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_Revenues_CY2025Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE won.frames_Revenues_CY2025Q1;

CREATE LIGHTNING REST TABLE frames_Revenues_CY2024Q1 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2024Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_Revenues_CY2024Q1 WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_Revenues_CY2024Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE won.frames_Revenues_CY2024Q1;

CREATE LIGHTNING REST TABLE frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY2025Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1 WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1;

CREATE LIGHTNING REST TABLE frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY2024Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1 WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1;

CREATE LIGHTNING REST TABLE frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RegulatedAndUnregulatedOperatingRevenue/USD/CY2025Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1;

CREATE LIGHTNING REST TABLE frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RegulatedAndUnregulatedOperatingRevenue/USD/CY2024Q1.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1
LATERAL VIEW explode(data) AS f;

CACHE TABLE won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1;

-- ---------------------------------------------------------------------------
-- Step 2: companyconcept history for the four Day-0 utilities. `Revenues`
-- for all four; the quarterly tag Duke Energy and Xcel Energy use as well
-- (caveat 3). Column order follows the reader template concept_history.
-- ---------------------------------------------------------------------------
-- Duke Energy Corp, CIK 0001326160
CREATE LIGHTNING REST TABLE concept_0001326160_Revenues FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0001326160/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0001326160_Revenues WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0001326160_Revenues
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0001326160_Revenues;

CREATE LIGHTNING REST TABLE concept_0001326160_RegulatedAndUnregulatedOperatingRevenue FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0001326160/us-gaap/RegulatedAndUnregulatedOperatingRevenue.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0001326160_RegulatedAndUnregulatedOperatingRevenue WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0001326160_RegulatedAndUnregulatedOperatingRevenue
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0001326160_RegulatedAndUnregulatedOperatingRevenue;

-- Southern Co, CIK 0000092122 (Revenues only; the other two tags answer 404)
CREATE LIGHTNING REST TABLE concept_0000092122_Revenues FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000092122/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0000092122_Revenues WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0000092122_Revenues
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0000092122_Revenues;

-- Xcel Energy Inc, CIK 0000072903
CREATE LIGHTNING REST TABLE concept_0000072903_Revenues FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000072903/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0000072903_Revenues WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0000072903_Revenues
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0000072903_Revenues;

CREATE LIGHTNING REST TABLE concept_0000072903_RegulatedAndUnregulatedOperatingRevenue FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000072903/us-gaap/RegulatedAndUnregulatedOperatingRevenue.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0000072903_RegulatedAndUnregulatedOperatingRevenue WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0000072903_RegulatedAndUnregulatedOperatingRevenue
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0000072903_RegulatedAndUnregulatedOperatingRevenue;

-- Entergy Corp, CIK 0000065984
CREATE LIGHTNING REST TABLE concept_0000065984_Revenues FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000065984/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW concept_0000065984_Revenues WITH CONTAINER won AS
SELECT f.fy AS fy, f.fp AS fp, f.form AS form, f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val
FROM WON_SEC.concept_0000065984_Revenues
LATERAL VIEW explode(units.USD) AS f;

CACHE TABLE won.concept_0000065984_Revenues;

-- ---------------------------------------------------------------------------
-- Step 3: submissions profiles of the four utilities. Scalars only.
-- ---------------------------------------------------------------------------
CREATE LIGHTNING REST TABLE submissions_0001326160 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0001326160.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0001326160 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0001326160;

CACHE TABLE won.submission_0001326160;

CREATE LIGHTNING REST TABLE submissions_0000092122 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000092122.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000092122 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000092122;

CACHE TABLE won.submission_0000092122;

CREATE LIGHTNING REST TABLE submissions_0000072903 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000072903.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000072903 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000072903;

CACHE TABLE won.submission_0000072903;

CREATE LIGHTNING REST TABLE submissions_0000065984 FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK0000065984.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

CREATE SCHEMASTORE VIEW submission_0000065984 WITH CONTAINER won AS
SELECT cik AS cik, name AS name, sic AS sic, `sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state
FROM WON_SEC.submissions_0000065984;

CACHE TABLE won.submission_0000065984;

-- =============================================================================
-- Teardown is not scripted: DROP is refused by the gateway allowlist, and the
-- REST tables and the database registration are removed in the Zetaris Data
-- Explorer (no SQL path, per the getting-started HOWTO). UNCACHE before a
-- deliberate re-fetch: UNCACHE TABLE won.<view> then CACHE TABLE won.<view>.
-- =============================================================================
