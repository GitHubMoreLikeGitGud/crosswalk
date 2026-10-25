-- =============================================================================
-- Source: the committed seed files of this repository, registered as SchemaStore
-- views over inline VALUES so that the join map and the USL can join against them
-- in Lightning SQL like any other source:
--   seeds/states.json      50 states + DC: postal code, name, 2-digit FIPS code
--                          (hand-entered from the Census ANSI state list)
--   seeds/utilities.json   43 investor-owned electric utilities: CIK, ticker and
--                          the states each one serves (curated from the FY2024
--                          Form 10-K service-territory descriptions, capped at 6)
--   seeds/stations.json    56 GHCN first-order airport stations with their state
-- plus one derived view, cw.seed_utilities: one row per seed utility from its
-- cached SEC submissions view (03_cw_sec_create.sql) with the seed ticker.
-- Licence: the seed files are this repository's own curated inputs (Apache-2.0);
-- names, SIC and business state in cw.seed_utilities come from SEC EDGAR
-- submissions and are read live through the cached views.
-- Format: CREATE SCHEMASTORE VIEW ... AS SELECT ... FROM VALUES (...) AS t(...)
-- (accepted by Zetaris 2.4.3.1, probed live 2026-10-25), cached.
-- Docs: seeds/*.json carry their own generator and source notes.
-- Rate limit: none (no source call; cw.seed_utilities reads 43 cached views once
-- when it is cached).
-- Status: run live 2026-10-25 against Zetaris 2.4.3.1; counts in ../README.md.
-- =============================================================================
--
-- Caveats:
--   1. Territories (PR, VI, GU, AS, MP) are deliberately absent from cw.states:
--      a FEMA or GHCN row for them becomes a join-map orphan by design.
--   2. The utility_state pairs are capped at 6 states per utility (AEP serves
--      11, Xcel 8): a Not-tested item on the answer card.
--   3. Generated from the seed files; regenerate rather than hand-edit.
-- =============================================================================

-- Step 1: the state reference (51 rows).
CREATE SCHEMASTORE VIEW states WITH CONTAINER cw AS
SELECT code, name, fips FROM VALUES
    ('AL', 'Alabama', '01'),
    ('AK', 'Alaska', '02'),
    ('AZ', 'Arizona', '04'),
    ('AR', 'Arkansas', '05'),
    ('CA', 'California', '06'),
    ('CO', 'Colorado', '08'),
    ('CT', 'Connecticut', '09'),
    ('DE', 'Delaware', '10'),
    ('DC', 'District of Columbia', '11'),
    ('FL', 'Florida', '12'),
    ('GA', 'Georgia', '13'),
    ('HI', 'Hawaii', '15'),
    ('ID', 'Idaho', '16'),
    ('IL', 'Illinois', '17'),
    ('IN', 'Indiana', '18'),
    ('IA', 'Iowa', '19'),
    ('KS', 'Kansas', '20'),
    ('KY', 'Kentucky', '21'),
    ('LA', 'Louisiana', '22'),
    ('ME', 'Maine', '23'),
    ('MD', 'Maryland', '24'),
    ('MA', 'Massachusetts', '25'),
    ('MI', 'Michigan', '26'),
    ('MN', 'Minnesota', '27'),
    ('MS', 'Mississippi', '28'),
    ('MO', 'Missouri', '29'),
    ('MT', 'Montana', '30'),
    ('NE', 'Nebraska', '31'),
    ('NV', 'Nevada', '32'),
    ('NH', 'New Hampshire', '33'),
    ('NJ', 'New Jersey', '34'),
    ('NM', 'New Mexico', '35'),
    ('NY', 'New York', '36'),
    ('NC', 'North Carolina', '37'),
    ('ND', 'North Dakota', '38'),
    ('OH', 'Ohio', '39'),
    ('OK', 'Oklahoma', '40'),
    ('OR', 'Oregon', '41'),
    ('PA', 'Pennsylvania', '42'),
    ('RI', 'Rhode Island', '44'),
    ('SC', 'South Carolina', '45'),
    ('SD', 'South Dakota', '46'),
    ('TN', 'Tennessee', '47'),
    ('TX', 'Texas', '48'),
    ('UT', 'Utah', '49'),
    ('VT', 'Vermont', '50'),
    ('VA', 'Virginia', '51'),
    ('WA', 'Washington', '53'),
    ('WV', 'West Virginia', '54'),
    ('WI', 'Wisconsin', '55'),
    ('WY', 'Wyoming', '56')
  AS t(code, name, fips);

CACHE TABLE cw.states;

-- Step 2: utility -> served state pairs (97 rows, 43 distinct states).
CREATE SCHEMASTORE VIEW utility_states WITH CONTAINER cw AS
SELECT cik, state FROM VALUES
    ('0001326160', 'NC'),
    ('0001326160', 'SC'),
    ('0001326160', 'FL'),
    ('0001326160', 'IN'),
    ('0001326160', 'OH'),
    ('0001326160', 'KY'),
    ('0000092122', 'GA'),
    ('0000092122', 'AL'),
    ('0000092122', 'MS'),
    ('0000753308', 'FL'),
    ('0000004904', 'OH'),
    ('0000004904', 'TX'),
    ('0000004904', 'VA'),
    ('0000004904', 'WV'),
    ('0000004904', 'IN'),
    ('0000004904', 'OK'),
    ('0000072903', 'MN'),
    ('0000072903', 'CO'),
    ('0000072903', 'TX'),
    ('0000072903', 'NM'),
    ('0000072903', 'WI'),
    ('0000072903', 'ND'),
    ('0000065984', 'AR'),
    ('0000065984', 'LA'),
    ('0000065984', 'MS'),
    ('0000065984', 'TX'),
    ('0001711269', 'KS'),
    ('0001711269', 'MO'),
    ('0001002910', 'MO'),
    ('0001002910', 'IL'),
    ('0000811156', 'MI'),
    ('0000936340', 'MI'),
    ('0000783325', 'WI'),
    ('0000783325', 'MI'),
    ('0000352541', 'IA'),
    ('0000352541', 'WI'),
    ('0000922224', 'PA'),
    ('0000922224', 'KY'),
    ('0000922224', 'RI'),
    ('0001031296', 'OH'),
    ('0001031296', 'PA'),
    ('0001031296', 'NJ'),
    ('0001031296', 'WV'),
    ('0001031296', 'MD'),
    ('0000788784', 'NJ'),
    ('0001047862', 'NY'),
    ('0000072741', 'CT'),
    ('0000072741', 'MA'),
    ('0000072741', 'NH'),
    ('0001109357', 'IL'),
    ('0001109357', 'PA'),
    ('0001109357', 'MD'),
    ('0001109357', 'NJ'),
    ('0001109357', 'DE'),
    ('0000827052', 'CA'),
    ('0001004980', 'CA'),
    ('0001032208', 'CA'),
    ('0000764622', 'AZ'),
    ('0000784977', 'OR'),
    ('0001057877', 'ID'),
    ('0001993004', 'MT'),
    ('0001993004', 'SD'),
    ('0001130464', 'SD'),
    ('0001130464', 'WY'),
    ('0001130464', 'CO'),
    ('0000104918', 'WA'),
    ('0000104918', 'ID'),
    ('0001021635', 'OK'),
    ('0001130310', 'TX'),
    ('0001130310', 'IN'),
    ('0001692819', 'TX'),
    ('0001692819', 'IL'),
    ('0001692819', 'PA'),
    ('0001692819', 'OH'),
    ('0001013871', 'TX'),
    ('0000354707', 'HI'),
    ('0000066756', 'MN'),
    ('0000066756', 'WI'),
    ('0001466593', 'MN'),
    ('0001466593', 'ND'),
    ('0001466593', 'SD'),
    ('0001161728', 'WI'),
    ('0000755001', 'NH'),
    ('0000755001', 'MA'),
    ('0001108426', 'NM'),
    ('0001108426', 'TX'),
    ('0000715957', 'VA'),
    ('0000715957', 'NC'),
    ('0000715957', 'SC'),
    ('0001868275', 'IL'),
    ('0001868275', 'PA'),
    ('0001868275', 'MD'),
    ('0001868275', 'NY'),
    ('0001111711', 'IN'),
    ('0001193311', 'TX'),
    ('0000100122', 'AZ'),
    ('0000096271', 'FL')
  AS t(cik, state);

CACHE TABLE cw.utility_states;

-- Step 3: the 56 seed stations (id, state, name) as curated.
CREATE SCHEMASTORE VIEW seed_stations WITH CONTAINER cw AS
SELECT id, state, name FROM VALUES
    ('USW00013876', 'AL', 'BIRMINGHAM AP'),
    ('USW00013963', 'AR', 'LITTLE ROCK AP ADAMS FLD'),
    ('USW00023183', 'AZ', 'PHOENIX AP'),
    ('USW00023174', 'CA', 'LOS ANGELES INTL AP'),
    ('USW00023234', 'CA', 'SAN FRANCISCO INTL AP'),
    ('USW00003017', 'CO', 'DENVER INTL AP'),
    ('USW00014740', 'CT', 'HARTFORD-BRADLEY INTL AP'),
    ('USW00013781', 'DE', 'WILMINGTON NEW CASTLE CO AP'),
    ('USW00012839', 'FL', 'MIAMI INTL AP'),
    ('USW00012842', 'FL', 'TAMPA INTL AP'),
    ('USW00013874', 'GA', 'ATLANTA HARTSFIELD-JACKSON INT'),
    ('USW00022521', 'HI', 'HONOLULU INTL AP'),
    ('USW00014933', 'IA', 'DES MOINES INTL AP'),
    ('USW00024131', 'ID', 'BOISE AIR TERMINAL'),
    ('USW00094846', 'IL', 'CHICAGO OHARE INTL AP'),
    ('USW00014842', 'IL', 'GENERAL WAYNE A DOWNING INTL A'),
    ('USW00093819', 'IN', 'INDIANAPOLIS'),
    ('USW00093817', 'IN', 'EVANSVILLE RGNL AP'),
    ('USW00013996', 'KS', 'TOPEKA ASOS'),
    ('USW00093821', 'KY', 'LOUISVILLE INTL AP'),
    ('USW00012916', 'LA', 'NEW ORLEANS AP'),
    ('USW00014739', 'MA', 'BOSTON'),
    ('USW00093721', 'MD', 'BALTIMORE-WASHINGTON INTL AP'),
    ('USW00093720', 'MD', 'SALISBURY-WICOMICO RGNL AP'),
    ('USW00094847', 'MI', 'DETROIT METRO AP'),
    ('USW00014836', 'MI', 'LANSING CAPITAL CITY AP'),
    ('USW00014922', 'MN', 'MINNEAPOLIS-ST PAUL INTL AP'),
    ('USW00014913', 'MN', 'DULUTH'),
    ('USW00013994', 'MO', 'ST LOUIS LAMBERT INTL AP'),
    ('USW00003940', 'MS', 'JACKSON INTL AP'),
    ('USW00024033', 'MT', 'BILLINGS INTL AP'),
    ('USW00013722', 'NC', 'RALEIGH AP'),
    ('USW00024011', 'ND', 'BISMARCK'),
    ('USW00014745', 'NH', 'CONCORD ASOS'),
    ('USW00014734', 'NJ', 'NEWARK LIBERTY INTL AP'),
    ('USW00093730', 'NJ', 'ATLANTIC CITY INTL AP'),
    ('USW00023050', 'NM', 'ALBUQUERQUE INTL AP'),
    ('USW00094728', 'NY', 'NY CITY CNTRL PARK'),
    ('USW00014821', 'OH', 'JOHN GLENN INTL AP'),
    ('USW00014820', 'OH', 'CLEVELAND'),
    ('USW00013967', 'OK', 'OKLAHOMA CY WILL ROGERS WORLD'),
    ('USW00024229', 'OR', 'PORTLAND INTL AP'),
    ('USW00013739', 'PA', 'PHILA INTL AP'),
    ('USW00094823', 'PA', 'PITTSBURGH ASOS'),
    ('USW00014765', 'RI', 'PROVIDENCE'),
    ('USW00013883', 'SC', 'COLUMBIA'),
    ('USW00014944', 'SD', 'SIOUX FALLS'),
    ('USW00024090', 'SD', 'RAPID CITY RGNL AP'),
    ('USW00003927', 'TX', 'DAL-FTW WSCMO AP'),
    ('USW00012960', 'TX', 'HOUSTON INTERCONTINENTAL AP'),
    ('USW00013737', 'VA', 'NORFOLK INTL AP'),
    ('USW00024233', 'WA', 'SEATTLE TACOMA AP'),
    ('USW00014839', 'WI', 'MILWAUKEE MITCHELL AP'),
    ('USW00014837', 'WI', 'MADISON DANE CO RGNL AP'),
    ('USW00013866', 'WV', 'CHARLESTON - YEAGER AP'),
    ('USW00024018', 'WY', 'CHEYENNE')
  AS t(id, state, name);

CACHE TABLE cw.seed_stations;

-- Step 4: one row per seed utility from its cached submissions view (cik is the
-- 10-digit string EDGAR serves, hq_state the business address state) with the
-- seed ticker (empty string when the seed has none). Prerequisite:
-- 03_cw_sec_create.sql.
CREATE SCHEMASTORE VIEW seed_utilities WITH CONTAINER cw AS
SELECT u.cik AS cik, u.name AS name, t.ticker AS ticker, u.sic AS sic, u.state AS hq_state
FROM (
  SELECT cik, name, sic, state FROM cw.submission_0001326160
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000092122
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000753308
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000004904
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000072903
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000065984
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001711269
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001002910
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000811156
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000936340
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000783325
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000352541
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000922224
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001031296
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000788784
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001047862
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000072741
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001109357
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000827052
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001004980
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001032208
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000764622
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000784977
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001057877
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001993004
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001130464
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000104918
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001021635
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001130310
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001692819
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001013871
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000354707
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000066756
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001466593
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001161728
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000755001
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001108426
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000715957
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001868275
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001111711
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0001193311
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000100122
  UNION ALL SELECT cik, name, sic, state FROM cw.submission_0000096271
) u
LEFT JOIN (
  SELECT cik, ticker FROM VALUES
    ('0001326160', 'DUK'),
    ('0000092122', 'SO'),
    ('0000753308', 'NEE'),
    ('0000004904', 'AEP'),
    ('0000072903', 'XEL'),
    ('0000065984', 'ETR'),
    ('0001711269', 'EVRG'),
    ('0001002910', 'AEE'),
    ('0000811156', 'CMS'),
    ('0000936340', 'DTE'),
    ('0000783325', 'WEC'),
    ('0000352541', 'LNT'),
    ('0000922224', 'PPL'),
    ('0001031296', 'FE'),
    ('0000788784', 'PEG'),
    ('0001047862', 'ED'),
    ('0000072741', 'ES'),
    ('0001109357', 'EXC'),
    ('0000827052', 'EIX'),
    ('0001004980', 'PCG'),
    ('0001032208', 'SRE'),
    ('0000764622', 'PNW'),
    ('0000784977', 'POR'),
    ('0001057877', 'IDA'),
    ('0001993004', 'NWE'),
    ('0001130464', 'BKH'),
    ('0000104918', 'AVA'),
    ('0001021635', 'OGE'),
    ('0001130310', 'CNP'),
    ('0001692819', 'VST'),
    ('0001013871', 'NRG'),
    ('0000354707', 'HE'),
    ('0000066756', 'ALE'),
    ('0001466593', 'OTTR'),
    ('0001161728', 'MGEE'),
    ('0000755001', 'UTL'),
    ('0001108426', 'TXNM'),
    ('0000715957', 'D'),
    ('0001868275', 'CEG'),
    ('0001111711', 'NI'),
    ('0001193311', ''),
    ('0000100122', ''),
    ('0000096271', '')
  AS seed(cik, ticker)
) t ON t.cik = u.cik;

CACHE TABLE cw.seed_utilities;

-- Next: verify with 05_cw_seeds_select.sql
