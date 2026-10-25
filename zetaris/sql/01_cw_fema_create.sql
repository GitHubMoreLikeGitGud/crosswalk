-- =============================================================================
-- Source: OpenFEMA (US Federal Emergency Management Agency), two endpoints
-- under one Lightning database:
--   DisasterDeclarationsSummaries v2
--     https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries
--     one row per declared designated area (county or equivalent) per
--     disaster; filtered here to major disasters (declarationType DR) declared
--     in Q1 2025 (declarationDate in [2025-01-01, 2025-04-01)), one page
--     ($top=1000; the filter returns 116 rows).
--   OpenFemaDataSets v1 (the dataset catalogue)
--     https://www.fema.gov/api/open/v1/OpenFemaDataSets
--     one row per published dataset with its name, title, description,
--     web-service URL and last refresh: the discovery catalogue the agent
--     searches.
-- Licence: OpenFEMA data is public US federal data, no key, no rate limit
-- published; FEMA is cited as the source and nothing here is FEMA-endorsed.
-- https://www.fema.gov/about/openfema/terms-conditions
-- Format: REST/JSON (CREATE LIGHTNING REST TABLE); the response is an object
-- {metadata, <DatasetName>[]} so the array field is named after the dataset
-- and is read with LATERAL VIEW explode(...) in a SchemaStore view in the
-- shared container `cw`. metadata.count is NOT a row count (0 on this filter).
-- Docs: https://www.fema.gov/about/openfema/api
--       https://www.fema.gov/openfema-data-page/disaster-declarations-summaries-v2
-- Rate limit: none published; a REST table re-fetches on every query, so the
-- views are cached right after creation. OData options must be percent-
-- encoded in the endpoint string ($ -> %24, space -> %20, ' -> %27, : -> %3A).
-- Status: run live 2026-10-25 against Zetaris 2.4.3.1 (local Docker); counts
-- and timings in ../README.md. The same URL fetched outside Zetaris the same
-- morning returned 116 rows (10 distinct disasterNumber, 8 states).
-- =============================================================================
--
-- Caveats:
--   1. CREATE LIGHTNING DATABASE and CREATE SCHEMASTORE CONTAINER accept no
--      IF NOT EXISTS on 2.4.3.1 (parse error); rerun with --skip-exists.
--   2. Column names are camelCase in the source and are backticked.
--   3. State is the two-letter postal code (AK, CA, KY, MO, OK, OR, SC, WV in
--      this filter); fipsStateCode and fipsCountyCode are zero-padded strings.
--   4. The catalogue has no apiEndpoint field; its `webService` column holds
--      the dataset's API URL and is exposed as api_endpoint.
-- =============================================================================

-- Step 0: the Lightning database and the shared SchemaStore container for
-- every Crosswalk view. No endpoint call.
CREATE LIGHTNING DATABASE CW_FEMA DESCRIBE BY "Crosswalk - OpenFEMA disaster declarations summaries v2 and the OpenFEMA dataset catalogue v1, REST source";

CREATE SCHEMASTORE CONTAINER cw;

-- Step 1: major-disaster declarations declared in Q1 2025 (one page). Calls
-- the endpoint.
CREATE LIGHTNING REST TABLE declarations_dr_2025q1 FROM CW_FEMA REQUEST(
    endpoint "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?%24filter=declarationType%20eq%20%27DR%27%20and%20declarationDate%20ge%20%272025-01-01T00%3A00%3A00.000Z%27%20and%20declarationDate%20lt%20%272025-04-01T00%3A00%3A00.000Z%27&%24top=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

-- Step 2: the declarations exploded, one row per designated area.
CREATE SCHEMASTORE VIEW fema_declarations_dr_2025q1 WITH CONTAINER cw AS
SELECT d.`disasterNumber` AS disaster_number, d.state AS state, d.`declarationDate` AS declaration_date,
       d.`incidentType` AS incident_type, d.`declarationTitle` AS declaration_title, d.`declarationType` AS declaration_type,
       d.`fipsStateCode` AS fips_state_code, d.`fipsCountyCode` AS fips_county_code, d.`designatedArea` AS designated_area
FROM CW_FEMA.declarations_dr_2025q1
LATERAL VIEW explode(`DisasterDeclarationsSummaries`) AS d;

-- Step 3: cache the view (one more endpoint call).
CACHE TABLE cw.fema_declarations_dr_2025q1;

-- Step 4: the dataset catalogue. Calls the endpoint.
CREATE LIGHTNING REST TABLE datasets_catalogue FROM CW_FEMA REQUEST(
    endpoint "https://www.fema.gov/api/open/v1/OpenFemaDataSets",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

-- Step 5: one row per dataset.
CREATE SCHEMASTORE VIEW fema_catalogue WITH CONTAINER cw AS
SELECT c.name AS name, c.version AS version, c.title AS title, c.description AS description,
       c.`webService` AS api_endpoint, c.`lastDataSetRefresh` AS last_dataset_refresh
FROM CW_FEMA.datasets_catalogue
LATERAL VIEW explode(`OpenFemaDataSets`) AS c;

-- Step 6: cache the catalogue view.
CACHE TABLE cw.fema_catalogue;

-- Next: verify with 01_cw_fema_select.sql
