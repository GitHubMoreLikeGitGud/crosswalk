-- Verification for 02_won_dns_create.sql. Reads the cached objects only.

-- Expect 1,005, the `total` field and `data` length of the source response.
SELECT COUNT(*) AS n FROM won.sic_codes;

-- Shape as inferred (raw: code, message, module, data, dependencies, total).
DESCRIBE WON_DNS.sic_codes_v4_raw;
DESCRIBE won.sic_codes;

-- The three utility codes the peer set uses (method step 4). Expect
-- 4911 Electric Services, 4931 Electric and Other Services Combined,
-- 4932 Gas and Other Services Combined; all division E, major group 49.
SELECT code, description, division, division_desc, major_group, major_group_desc FROM won.sic_codes WHERE code IN ('4911', '4931', '4932') ORDER BY code;

-- Codes are unique (a PK candidate for the USL sic_code table).
SELECT COUNT(*) AS n, COUNT(DISTINCT code) AS distinct_codes FROM won.sic_codes;

-- Every code is four digits.
SELECT COUNT(*) AS not_four_digits FROM won.sic_codes WHERE NOT code RLIKE '^[0-9]{4}$';
