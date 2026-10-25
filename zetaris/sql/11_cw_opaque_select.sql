-- =============================================================================
-- Verification for 11_cw_opaque_create.sql: each opaque view has the rows of the
-- view it copies (one statement per pair; a view is referenced once per statement).
-- =============================================================================

-- 1. 43 and 43.
SELECT (SELECT COUNT(*) FROM cw.opq_seed_submissions_snapshot) AS opaque_rows, (SELECT COUNT(*) FROM cw.seed_submissions_snapshot) AS source_rows;

-- 2. 1,937 and 1,937.
SELECT (SELECT COUNT(*) FROM cw.opq_frames_revenues_cy2025q1) AS opaque_rows, (SELECT COUNT(*) FROM cw.frames_Revenues_CY2025Q1) AS source_rows;

-- 3. 116 and 116.
SELECT (SELECT COUNT(*) FROM cw.opq_fema_declarations_dr_2025q1) AS opaque_rows, (SELECT COUNT(*) FROM cw.fema_declarations_dr_2025q1) AS source_rows;

-- 4. 97 and 97.
SELECT (SELECT COUNT(*) FROM cw.opq_utility_states) AS opaque_rows, (SELECT COUNT(*) FROM cw.utility_states) AS source_rows;

-- 5. 51 and 51.
SELECT (SELECT COUNT(*) FROM cw.opq_states) AS opaque_rows, (SELECT COUNT(*) FROM cw.states) AS source_rows;

-- 6. 56 and 56.
SELECT (SELECT COUNT(*) FROM cw.opq_seed_stations) AS opaque_rows, (SELECT COUNT(*) FROM cw.seed_stations) AS source_rows;

-- 7. 133,039 and 133,039.
SELECT (SELECT COUNT(*) FROM cw.opq_stations) AS opaque_rows, (SELECT COUNT(*) FROM cw.stations) AS source_rows;

-- 8. 1,005 and 1,005.
SELECT (SELECT COUNT(*) FROM cw.opq_sic_codes) AS opaque_rows, (SELECT COUNT(*) FROM cw.sic_codes) AS source_rows;
