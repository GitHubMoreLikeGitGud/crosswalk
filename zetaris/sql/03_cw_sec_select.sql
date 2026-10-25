-- Verification for 03_cw_sec_create.sql. Reads the cached views only (a read of a
-- cached REST view does not call SEC EDGAR).

-- Shapes as inferred (raw frames: taxonomy, tag, ccp, uom, label, description, pts, data).
DESCRIBE CW_SEC.frames_Revenues_CY2025Q1;
DESCRIBE cw.frames_Revenues_CY2025Q1;
DESCRIBE cw.submission_0001326160;

-- Facts per frames view: compare with the `data` length of the source response
-- (the sister entry's 2026-10-24 reads: 1,937 / 2,095 / 2,546 / 2,654 / 20 / 22;
-- the endpoint serves the most recently filed fact, so counts drift as filings land).
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers FROM cw.frames_Revenues_CY2025Q1;
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers FROM cw.frames_Revenues_CY2024Q1;
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1;
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers FROM cw.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1;
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1;
SELECT COUNT(*) AS n, COUNT(DISTINCT cik) AS filers FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1;

-- One row per filer in a frames period (the frames endpoint serves one fact per filer).
SELECT COUNT(*) - COUNT(DISTINCT cik) AS duplicate_filers FROM cw.frames_Revenues_CY2025Q1;

-- A submission view holds exactly one row: the filer's scalars.
SELECT cik, name, sic, `sicDescription`, state FROM cw.submission_0001326160;

-- The join-map statements over these views are in 06_cw_joinmap_select.sql.
