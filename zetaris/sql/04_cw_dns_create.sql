-- =============================================================================
-- Source: company_dns SIC (Standard Industrial Classification) reference,
-- V4 (production): https://company-dns.mediumroast.io/V4.0/na/sic/code/%25
-- 1,005 SIC codes with the full hierarchy (section letter, 2-digit division,
-- 3-digit group, 4-digit class). The vendor getting-started script
-- open_data/rest_apis/sql/rate_limited/12_company_dns_create.sql registers
-- both V3 and V4 under COMPANY_DNS; this instance has no COMPANY_DNS, so the
-- V4 steps are repeated here under CW_DNS (checked 2026-10-25: still no COMPANY_DNS).
-- Licence: company_dns is Apache 2.0 (github.com/miha42-github/company_dns);
-- its SIC data traces to the SEC's public SIC list. Query live, don't
-- redistribute the extracted data.
-- Format: REST/JSON. V4 `data` is a plain array of 1,005 flat objects
-- {section_id, section_desc, division_id, division_desc, group_id,
-- group_desc, class_id, class_desc} -> LATERAL VIEW explode(data).
-- Docs: https://github.com/miha42-github/company_dns
-- Rate limit: per caller address; an identifying User-Agent (an app name,
-- a space, and a contact address) gets 6,000 a minute (burst 600), an
-- unidentified one 600 a minute (burst 60) during the event and 5 a minute
-- afterwards. The placeholder below is replaced at run time from
-- CW_USER_AGENT in .env.local (an app name plus a contact), never a
-- literal here. A REST table re-fetches on every query, so the raw table
-- and the view are cached; run this file once, deliberately. On a 429 wait
-- 60 seconds before retrying that one statement.
-- Status: run live 2026-10-25 against Zetaris 2.4.3.1; counts in ../README.md. Same shape as the sister entry (2026-10-24).
-- =============================================================================
--
-- Caveats:
--   1. The %25 wildcard (a literal '%') is undocumented behaviour of the
--      service (the code is used in a LIKE); it returns all 1,005 codes.
--   2. Column names: the view uses the V3 vocabulary the SPEC's USL expects
--      (division = letter, major_group = 2-digit), mapped from V4's
--      section_id / division_id as in the vendor's sic_codes_v4_compat_table.
--      V4's own `division_desc` is the 2-digit level, not the letter level.
--   3. SIC 3570 is absent from the reference (vendor caveat); the three
--      utility codes 4911, 4931 and 4932 are present.
--   4. DESCRIBE BY accepts letters, digits, spaces and _ . - , only.
-- =============================================================================

-- Step 0: the logical database. No endpoint call. (IF NOT EXISTS is a parse
-- error on 2.4.3.1; rerun with --skip-exists.)
CREATE LIGHTNING DATABASE CW_DNS DESCRIBE BY "Crosswalk - company_dns SIC reference data V4 - section, division, group, class";

-- Step 1: the V4 raw table. Calls the endpoint.
CREATE LIGHTNING REST TABLE sic_codes_v4_raw FROM CW_DNS REQUEST(
    endpoint "https://company-dns.mediumroast.io/V4.0/na/sic/code/%25",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

-- Step 2: cache the raw table. Calls the endpoint once more.
CACHE TABLE CW_DNS.sic_codes_v4_raw;

-- Step 3: the reference view in the shared container (created by
-- 01_cw_fema_create.sql Step 0). Column order follows the reader template
-- `sic` and the USL table sic_code.
CREATE SCHEMASTORE VIEW sic_codes WITH CONTAINER cw AS
SELECT
    item.class_id AS code,
    item.class_desc AS description,
    item.section_id AS division,
    item.section_desc AS division_desc,
    item.division_id AS major_group,
    item.division_desc AS major_group_desc
FROM CW_DNS.sic_codes_v4_raw
LATERAL VIEW explode(data) AS item;

-- Step 4: cache the view (reads the cached raw table).
CACHE TABLE cw.sic_codes;
