-- Verification for 06_won_sec_seeds_create.sql (counts in Zetaris against the source
-- responses, fetched independently with the same User-Agent on the same day).
-- Every statement reads cached views; none calls SEC EDGAR. Expected values:
-- ../README.md (2026-10-24).

-- 1. One profile row per seed: 43 rows, every cik a 10-digit string, sic 4911 /
-- 4931 / 4932 except MGE Energy (4900, kept as a target-only seed).
SELECT u.cik, u.name, u.sic, u.state FROM (
SELECT cik, name, sic, state FROM won.submission_0001326160
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000092122
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000753308
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000004904
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000072903
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000065984
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001711269
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001002910
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000811156
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000936340
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000783325
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000352541
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000922224
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001031296
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000788784
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001047862
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000072741
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001109357
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000827052
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001004980
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001032208
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000764622
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000784977
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001057877
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001993004
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001130464
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000104918
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001021635
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001130310
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001692819
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001013871
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000354707
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000066756
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001466593
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001161728
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000755001
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001108426
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000715957
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001868275
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001111711
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001193311
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000100122
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000096271
) u ORDER BY u.cik;

-- 2. Companyconcept USD facts of the demo and warm-run utilities (source lengths
-- in ../README.md).
SELECT COUNT(*) AS n FROM won.concept_0001031296_Revenues;
SELECT COUNT(*) AS n FROM won.concept_0001031296_RevenueFromContractWithCustomerExcludingAssessedTax;
SELECT COUNT(*) AS n FROM won.concept_0000004904_Revenues;
SELECT COUNT(*) AS n FROM won.concept_0000004904_RevenueFromContractWithCustomerExcludingAssessedTax;

-- The like-for-like rows the agent reads (method step 2): FirstEnergy CY2025Q1 and
-- CY2024Q1 as first filed and as later comparatives; AEP's CY2025Q1 value differs
-- between its 2025 10-Q and the 2026 10-Q comparative (the live multi-filing conflict).
SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0001031296_Revenues WHERE `start` IN ('2024-01-01', '2025-01-01') AND `end` IN ('2024-03-31', '2025-03-31') ORDER BY `end`, filed;
SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0000004904_Revenues WHERE `start` IN ('2024-01-01', '2025-01-01') AND `end` IN ('2024-03-31', '2025-03-31') ORDER BY `end`, filed;

-- 3. The peer universe per frames period: the gateway template frames_seeds
-- (seed CIKs compared as integers). Counts per tag and period in ../README.md.

SELECT COUNT(*) AS seeds_present FROM won.frames_Revenues_CY2025Q1 WHERE CAST(cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);
SELECT COUNT(*) AS seeds_present FROM won.frames_Revenues_CY2024Q1 WHERE CAST(cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);
SELECT COUNT(*) AS seeds_present FROM won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1 WHERE CAST(cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);
SELECT COUNT(*) AS seeds_present FROM won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1 WHERE CAST(cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);
SELECT COUNT(*) AS seeds_present FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1 WHERE CAST(cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);
SELECT COUNT(*) AS seeds_present FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 WHERE CAST(cik AS BIGINT) IN (1326160, 92122, 753308, 4904, 72903, 65984, 1711269, 1002910, 811156, 936340, 783325, 352541, 922224, 1031296, 788784, 1047862, 72741, 1109357, 827052, 1004980, 1032208, 764622, 784977, 1057877, 1993004, 1130464, 104918, 1021635, 1130310, 1692819, 1013871, 354707, 66756, 1466593, 1161728, 755001, 1108426, 715957, 1868275, 1111711, 1193311, 100122, 96271);

-- 4. Join map over all 43 seeds (SPEC section 4): (a) submissions sic vs the
-- company_dns reference: seeds whose SIC code has no reference row (expect one,
-- MGE Energy 4900); (b) frames loc vs submissions business state in Revenues
-- CY2025Q1: agreeing rows out of the seeds present.
SELECT u.cik, u.name, u.sic FROM (
SELECT cik, name, sic, state FROM won.submission_0001326160
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000092122
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000753308
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000004904
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000072903
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000065984
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001711269
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001002910
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000811156
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000936340
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000783325
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000352541
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000922224
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001031296
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000788784
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001047862
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000072741
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001109357
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000827052
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001004980
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001032208
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000764622
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000784977
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001057877
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001993004
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001130464
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000104918
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001021635
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001130310
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001692819
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001013871
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000354707
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000066756
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001466593
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001161728
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000755001
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001108426
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000715957
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001868275
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001111711
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001193311
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000100122
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000096271
) u LEFT JOIN won.sic_codes r ON r.code = u.sic WHERE r.code IS NULL ORDER BY u.cik;
SELECT SUM(CASE WHEN f.loc = CONCAT('US-', u.state) THEN 1 ELSE 0 END) AS agree, COUNT(*) AS seeds_present FROM won.frames_Revenues_CY2025Q1 f JOIN (
SELECT cik, name, sic, state FROM won.submission_0001326160
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000092122
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000753308
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000004904
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000072903
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000065984
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001711269
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001002910
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000811156
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000936340
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000783325
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000352541
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000922224
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001031296
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000788784
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001047862
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000072741
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001109357
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000827052
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001004980
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001032208
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000764622
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000784977
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001057877
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001993004
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001130464
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000104918
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001021635
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001130310
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001692819
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001013871
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000354707
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000066756
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001466593
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001161728
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000755001
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001108426
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000715957
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001868275
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001111711
UNION ALL SELECT cik, name, sic, state FROM won.submission_0001193311
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000100122
UNION ALL SELECT cik, name, sic, state FROM won.submission_0000096271
) u ON LPAD(CAST(f.cik AS STRING), 10, '0') = u.cik;
