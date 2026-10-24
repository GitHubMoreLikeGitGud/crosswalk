-- =============================================================================
-- Run-time registration template (SPEC gate G7): the statements the gateway
-- registrar issues when the agent asks for a frames period that is not yet
-- registered, in order. This file documents the text; it is NOT run with
-- gateway/run_sql.py. The rendering source is gateway/templates.py
-- (registrar_frames_table, registrar_frames_view, registrar_frames_describe,
-- registrar_frames_cache; plan register_frames), called as
--     POST http://127.0.0.1:8793/registrar/register_frames
--     {"tag": "<tag>", "period": "<period>", "contract": {...}}
-- under a medium-risk execution contract (gateway/contracts.py). The same
-- shape exists for companyconcept (register_concept: cik10, tag) and
-- submissions (register_submission: cik10).
--
-- Parameters are validated before substitution (gateway/templates.py
-- PARAM_PATTERNS): {tag} is one of Revenues,
-- RevenueFromContractWithCustomerExcludingAssessedTax,
-- RegulatedAndUnregulatedOperatingRevenue; {period} matches ^CY\d{4}Q[1-3]$
-- (never Q4: the SEC frames API has no 3-month Q4 frame). Each rendered
-- statement is then checked against the registrar allowlist
-- (gateway/allowlist.py: host data.sec.gov over https only, one endpoint,
-- WON_SEC database, container won). The User-Agent placeholder is replaced
-- from WON_USER_AGENT on the wire only; the log and the HTTP reply keep the
-- placeholder.
--
-- Steps 1 and 2 treat "already exists" as done, so re-registering a period
-- the instance already holds only re-caches it. Step 4 has a 600 s bound.
-- Proved live 2026-10-24 with Revenues / CY2025Q2 (1,941 facts, 1.2 s) and
-- Revenues / CY2024Q2 (2,018 facts, 1.1 s); see ../README.md. After the plan the
-- agent reads the period with frames_count and frames_seeds (the seed filers
-- only, at most 43 rows).
-- =============================================================================

-- Step 1: the raw REST table. One SEC request.
CREATE LIGHTNING REST TABLE frames_{tag}_{period} FROM WON_SEC REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
) BODY ();

-- Step 2: the flattened view (one fact per filer).
CREATE SCHEMASTORE VIEW frames_{tag}_{period} WITH CONTAINER won AS
SELECT f.cik AS cik, f.`entityName` AS `entityName`, f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn
FROM WON_SEC.frames_{tag}_{period}
LATERAL VIEW explode(data) AS f;

-- Step 3: the view's columns, returned to the agent as evidence (no source call).
DESCRIBE won.frames_{tag}_{period};

-- Step 4: cache the view. One SEC request; every later read is answered from the driver.
CACHE TABLE won.frames_{tag}_{period};

-- Verification the agent runs afterwards through the reader template frames_count:
-- SELECT COUNT(*) AS n FROM won.frames_{tag}_{period};
