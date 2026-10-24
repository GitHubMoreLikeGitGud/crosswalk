-- Verification for 01_won_sec_create.sql (getting-started HOWTO section 2:
-- count in Zetaris, count the source response independently, investigate any
-- difference). Every statement reads a cached view, so none calls SEC EDGAR.
-- Expected values are the source counts of 2026-10-24; frames grow as filers
-- file, so re-count the source on the day you compare.

-- Frames: facts per period. Source data length 2026-10-24: Revenues CY2025Q1
-- 1,937 and CY2024Q1 2,095; RevenueFromContractWithCustomerExcludingAssessedTax
-- 2,546 and 2,654; RegulatedAndUnregulatedOperatingRevenue 20 and 22.
SELECT COUNT(*) AS n FROM won.frames_Revenues_CY2025Q1;
SELECT COUNT(*) AS n FROM won.frames_Revenues_CY2024Q1;
SELECT COUNT(*) AS n FROM won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1;
SELECT COUNT(*) AS n FROM won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1;
SELECT COUNT(*) AS n FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1;
SELECT COUNT(*) AS n FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1;

-- Schema as inferred by Zetaris (raw table and flattened view).
DESCRIBE WON_SEC.frames_Revenues_CY2025Q1;
DESCRIBE won.frames_Revenues_CY2025Q1;

-- A frames period is one fact per filer: distinct ciks must equal the count,
-- and every row is the 3-month calendar quarter.
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers, MIN(`start`) AS first_start, MAX(`end`) AS last_end FROM won.frames_Revenues_CY2025Q1;

-- The two Day-0 utilities that report quarterly `Revenues` (Southern Co, Entergy).
SELECT cik, `entityName`, loc, `start`, `end`, val, accn FROM won.frames_Revenues_CY2025Q1 WHERE LPAD(CAST(cik AS STRING), 10, '0') IN ('0001326160', '0000092122', '0000072903', '0000065984') ORDER BY cik;

-- The two that report RegulatedAndUnregulatedOperatingRevenue instead (Duke Energy, Xcel Energy).
SELECT cik, `entityName`, loc, `start`, `end`, val, accn FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 WHERE LPAD(CAST(cik AS STRING), 10, '0') IN ('0001326160', '0000092122', '0000072903', '0000065984') ORDER BY cik;

-- Companyconcept: USD facts per filer and tag. Source lengths 2026-10-24: Duke
-- Revenues 70 and RegulatedAndUnregulatedOperatingRevenue 170; Southern
-- Revenues 293; Xcel Revenues 210 and RegulatedAndUnregulatedOperatingRevenue
-- 115; Entergy Revenues 98.
SELECT COUNT(*) AS n FROM won.concept_0001326160_Revenues;
SELECT COUNT(*) AS n FROM won.concept_0001326160_RegulatedAndUnregulatedOperatingRevenue;
SELECT COUNT(*) AS n FROM won.concept_0000092122_Revenues;
SELECT COUNT(*) AS n FROM won.concept_0000072903_Revenues;
SELECT COUNT(*) AS n FROM won.concept_0000072903_RegulatedAndUnregulatedOperatingRevenue;
SELECT COUNT(*) AS n FROM won.concept_0000065984_Revenues;

DESCRIBE WON_SEC.concept_0000092122_Revenues;
DESCRIBE won.concept_0000092122_Revenues;

-- The like-for-like question (method step 2): the CY2024Q1 value as first
-- filed (fy 2024) and as the comparative in the CY2025Q1 filing (fy 2025).
-- Expect Southern 6,646,000,000 in both filings (no recast) and Entergy
-- 2,794,628,000 only in the 2025 filing (the 2024 filing used the other tag).
SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0000092122_Revenues WHERE `start` = '2024-01-01' AND `end` = '2024-03-31' ORDER BY filed;
SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0000065984_Revenues WHERE `start` = '2024-01-01' AND `end` = '2024-03-31' ORDER BY filed;
SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0001326160_RegulatedAndUnregulatedOperatingRevenue WHERE `start` IN ('2024-01-01', '2025-01-01') AND `end` IN ('2024-03-31', '2025-03-31') ORDER BY `end`, filed;

-- Submissions: one row each; cik is the 10-digit string, state the business address state.
SELECT cik, name, sic, `sicDescription`, state FROM won.submission_0001326160;
SELECT cik, name, sic, `sicDescription`, state FROM won.submission_0000092122;
SELECT cik, name, sic, `sicDescription`, state FROM won.submission_0000072903;
SELECT cik, name, sic, `sicDescription`, state FROM won.submission_0000065984;

DESCRIBE won.submission_0001326160;

-- === Join map (SPEC section 4), measured in Lightning SQL ===
-- (a) frames cik (integer, LPAD to 10) vs submissions cik (string): matches
-- per tag for the four utilities. Expect 2 (Revenues: Southern, Entergy),
-- 0 (RevenueFromContract...), 2 (RegulatedAndUnregulated...: Duke, Xcel).
SELECT COUNT(*) AS matched FROM won.frames_Revenues_CY2025Q1 f JOIN (SELECT cik FROM won.submission_0001326160 UNION ALL SELECT cik FROM won.submission_0000092122 UNION ALL SELECT cik FROM won.submission_0000072903 UNION ALL SELECT cik FROM won.submission_0000065984) s ON LPAD(CAST(f.cik AS STRING), 10, '0') = s.cik;
SELECT COUNT(*) AS matched FROM won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1 f JOIN (SELECT cik FROM won.submission_0001326160 UNION ALL SELECT cik FROM won.submission_0000092122 UNION ALL SELECT cik FROM won.submission_0000072903 UNION ALL SELECT cik FROM won.submission_0000065984) s ON LPAD(CAST(f.cik AS STRING), 10, '0') = s.cik;
SELECT COUNT(*) AS matched FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 f JOIN (SELECT cik FROM won.submission_0001326160 UNION ALL SELECT cik FROM won.submission_0000092122 UNION ALL SELECT cik FROM won.submission_0000072903 UNION ALL SELECT cik FROM won.submission_0000065984) s ON LPAD(CAST(f.cik AS STRING), 10, '0') = s.cik;

-- The same join without LPAD finds nothing (the formats differ), which is why the
-- USL keys are 10-digit strings everywhere.
SELECT COUNT(*) AS matched_without_lpad FROM won.frames_Revenues_CY2025Q1 f JOIN (SELECT cik FROM won.submission_0000092122 UNION ALL SELECT cik FROM won.submission_0000065984) s ON CAST(f.cik AS STRING) = s.cik;

-- (b) frames loc ('US-XX') vs submissions business state: agreement per utility
-- across the three tags. Expect 4 rows, all agreeing.
SELECT s.cik, s.name, s.state, f.loc, CASE WHEN f.loc = CONCAT('US-', s.state) THEN 1 ELSE 0 END AS agrees FROM (SELECT cik, loc FROM won.frames_Revenues_CY2025Q1 UNION ALL SELECT cik, loc FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1) f JOIN (SELECT cik, name, state FROM won.submission_0001326160 UNION ALL SELECT cik, name, state FROM won.submission_0000092122 UNION ALL SELECT cik, name, state FROM won.submission_0000072903 UNION ALL SELECT cik, name, state FROM won.submission_0000065984) s ON LPAD(CAST(f.cik AS STRING), 10, '0') = s.cik ORDER BY s.cik;

-- (c) loc coverage of a whole frames period: how many facts carry a US state
-- code at all (foreign filers carry a country code such as 'JP').
SELECT CASE WHEN loc LIKE 'US-%' THEN 'US state' ELSE 'other' END AS loc_kind, COUNT(*) AS n FROM won.frames_Revenues_CY2025Q1 GROUP BY CASE WHEN loc LIKE 'US-%' THEN 'US state' ELSE 'other' END ORDER BY loc_kind;

-- (d) SIC lookup for the four utilities against the company_dns reference
-- (02_won_dns_create.sql): expect 4 rows, descriptions agreeing on 4911 and
-- 4931 up to case ("Electric & Other Services Combined" vs "Electric and Other Services Combined").
SELECT s.cik, s.sic, s.`sicDescription`, r.description, r.division, r.major_group FROM (SELECT cik, sic, `sicDescription` FROM won.submission_0001326160 UNION ALL SELECT cik, sic, `sicDescription` FROM won.submission_0000092122 UNION ALL SELECT cik, sic, `sicDescription` FROM won.submission_0000072903 UNION ALL SELECT cik, sic, `sicDescription` FROM won.submission_0000065984) s JOIN won.sic_codes r ON s.sic = r.code ORDER BY s.cik;

-- === Refresh, run deliberately (each re-CACHE is one SEC request) ===
-- UNCACHE TABLE won.frames_Revenues_CY2025Q1;
-- CACHE TABLE won.frames_Revenues_CY2025Q1;
