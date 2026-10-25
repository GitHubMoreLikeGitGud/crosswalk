-- Verification for 02_cw_stations_create.sql. Reads the cached view only
-- (the raw CSV table is read once, by the CACHE).

-- Shape as inferred: the raw table has one string column _c0 (a whole 85-character line).
DESCRIBE CW_GHCN.ghcnd_stations_txt;
DESCRIBE cw.stations;

-- Expect the line count of the file downloaded outside Zetaris on 2026-10-25: 133,039.
SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS distinct_ids FROM cw.stations;

-- US stations with a state (expect 78,568: every US line in the file has one) and US total.
SELECT COUNT(*) AS us_with_state FROM cw.stations WHERE id LIKE 'US%' AND TRIM(state) <> '';
SELECT COUNT(*) AS us_total FROM cw.stations WHERE id LIKE 'US%';

-- Distinct US states in the inventory (expect 50 states + DC + territories such as PR, VI, GU, AS, MP, UM, PW, MH, FM).
SELECT COUNT(DISTINCT state) AS us_states FROM cw.stations WHERE id LIKE 'US%' AND TRIM(state) <> '';

-- The 56 seed stations (seeds/stations.json): every one present, and the state in the
-- inventory equals the seed state (expect 56 / 56 / 0).
SELECT COUNT(*) AS seeds, SUM(CASE WHEN v.state = s.state THEN 1 ELSE 0 END) AS state_equal, SUM(CASE WHEN v.id IS NULL THEN 1 ELSE 0 END) AS missing
FROM (SELECT id, state FROM VALUES
    ('USW00013876', 'AL'),
    ('USW00013963', 'AR'),
    ('USW00023183', 'AZ'),
    ('USW00023174', 'CA'),
    ('USW00023234', 'CA'),
    ('USW00003017', 'CO'),
    ('USW00014740', 'CT'),
    ('USW00013781', 'DE'),
    ('USW00012839', 'FL'),
    ('USW00012842', 'FL'),
    ('USW00013874', 'GA'),
    ('USW00022521', 'HI'),
    ('USW00014933', 'IA'),
    ('USW00024131', 'ID'),
    ('USW00094846', 'IL'),
    ('USW00014842', 'IL'),
    ('USW00093819', 'IN'),
    ('USW00093817', 'IN'),
    ('USW00013996', 'KS'),
    ('USW00093821', 'KY'),
    ('USW00012916', 'LA'),
    ('USW00014739', 'MA'),
    ('USW00093721', 'MD'),
    ('USW00093720', 'MD'),
    ('USW00094847', 'MI'),
    ('USW00014836', 'MI'),
    ('USW00014922', 'MN'),
    ('USW00014913', 'MN'),
    ('USW00013994', 'MO'),
    ('USW00003940', 'MS'),
    ('USW00024033', 'MT'),
    ('USW00013722', 'NC'),
    ('USW00024011', 'ND'),
    ('USW00014745', 'NH'),
    ('USW00014734', 'NJ'),
    ('USW00093730', 'NJ'),
    ('USW00023050', 'NM'),
    ('USW00094728', 'NY'),
    ('USW00014821', 'OH'),
    ('USW00014820', 'OH'),
    ('USW00013967', 'OK'),
    ('USW00024229', 'OR'),
    ('USW00013739', 'PA'),
    ('USW00094823', 'PA'),
    ('USW00014765', 'RI'),
    ('USW00013883', 'SC'),
    ('USW00014944', 'SD'),
    ('USW00024090', 'SD'),
    ('USW00003927', 'TX'),
    ('USW00012960', 'TX'),
    ('USW00013737', 'VA'),
    ('USW00024233', 'WA'),
    ('USW00014839', 'WI'),
    ('USW00014837', 'WI'),
    ('USW00013866', 'WV'),
    ('USW00024018', 'WY')
  AS seed(id, state)) s
LEFT JOIN cw.stations v ON v.id = s.id;

-- Any seed whose state differs (expect no rows).
SELECT s.id, s.state AS seed_state, v.state AS inventory_state, v.name
FROM (SELECT id, state FROM VALUES
    ('USW00013876', 'AL'),
    ('USW00013963', 'AR'),
    ('USW00023183', 'AZ'),
    ('USW00023174', 'CA'),
    ('USW00023234', 'CA'),
    ('USW00003017', 'CO'),
    ('USW00014740', 'CT'),
    ('USW00013781', 'DE'),
    ('USW00012839', 'FL'),
    ('USW00012842', 'FL'),
    ('USW00013874', 'GA'),
    ('USW00022521', 'HI'),
    ('USW00014933', 'IA'),
    ('USW00024131', 'ID'),
    ('USW00094846', 'IL'),
    ('USW00014842', 'IL'),
    ('USW00093819', 'IN'),
    ('USW00093817', 'IN'),
    ('USW00013996', 'KS'),
    ('USW00093821', 'KY'),
    ('USW00012916', 'LA'),
    ('USW00014739', 'MA'),
    ('USW00093721', 'MD'),
    ('USW00093720', 'MD'),
    ('USW00094847', 'MI'),
    ('USW00014836', 'MI'),
    ('USW00014922', 'MN'),
    ('USW00014913', 'MN'),
    ('USW00013994', 'MO'),
    ('USW00003940', 'MS'),
    ('USW00024033', 'MT'),
    ('USW00013722', 'NC'),
    ('USW00024011', 'ND'),
    ('USW00014745', 'NH'),
    ('USW00014734', 'NJ'),
    ('USW00093730', 'NJ'),
    ('USW00023050', 'NM'),
    ('USW00094728', 'NY'),
    ('USW00014821', 'OH'),
    ('USW00014820', 'OH'),
    ('USW00013967', 'OK'),
    ('USW00024229', 'OR'),
    ('USW00013739', 'PA'),
    ('USW00094823', 'PA'),
    ('USW00014765', 'RI'),
    ('USW00013883', 'SC'),
    ('USW00014944', 'SD'),
    ('USW00024090', 'SD'),
    ('USW00003927', 'TX'),
    ('USW00012960', 'TX'),
    ('USW00013737', 'VA'),
    ('USW00024233', 'WA'),
    ('USW00014839', 'WI'),
    ('USW00014837', 'WI'),
    ('USW00013866', 'WV'),
    ('USW00024018', 'WY')
  AS seed(id, state)) s
LEFT JOIN cw.stations v ON v.id = s.id
WHERE v.state IS NULL OR v.state <> s.state;

-- Sample of the parsed columns for three seed stations.
SELECT id, state, name, latitude, longitude FROM cw.stations WHERE id IN ('USW00013740', 'USW00013722', 'USW00094728') ORDER BY id;
