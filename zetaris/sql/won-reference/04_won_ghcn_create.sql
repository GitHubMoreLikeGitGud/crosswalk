-- =============================================================================
-- Source: NOAA Global Historical Climatology Network - Daily (GHCN-Daily),
-- Parquet partitions by year and element on the public AWS bucket:
--   s3a://noaa-ghcn-pds/parquet/by_year/YEAR=<yyyy>/ELEMENT=<TMAX|TMIN>/
-- One Lightning filestore table per (year, element): 2024 and 2025, TMAX and TMIN.
-- Each partition is 9 Parquet files (about 15 MB, roughly 4.3 to 4.4 million rows,
-- every station worldwide; one station's days are spread over the 9 files).
--
-- Licence: CC0-1.0 (public domain), https://registry.opendata.aws/noaa-ghcn/
--
-- Format: Parquet, FILESTORE table with Zetaris's public-bucket options (no
-- credentials). Schema as inferred: ID string, DATE string yyyymmdd, DATA_VALUE
-- bigint (tenths of a degree C), M_FLAG, Q_FLAG, S_FLAG, OBS_TIME strings.
--
-- Docs: https://docs.opendata.aws/noaa-ghcn-pds/readme.html
--       https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt (column spec)
--
-- Rate limit: none (anonymous S3). Every uncached query scans the 9 files of a
-- partition from S3 (about 30 s for a filtered COUNT), so the station-filtered
-- SchemaStore views below are cached and every reader template reads the views.
--
-- Status: verified live on Zetaris 2.4.3.1 (2026-10-24): the four tables
-- registered (4.5 to 7.0 s each), DESCRIBE shows the 7 columns above, and
-- COUNT(*) WHERE ID = 'USW00013740' on ghcn_2025_tmax equals the independent
-- pyarrow count over the same 9 files (365). Counts and timings: ../README.md.
--
-- Caveats:
--   1. The views keep the 56 first-order airport stations in seeds/stations.json
--      plus USW00013740 (Richmond, VA), the validation station used by the
--      degree-day check in 04_won_ghcn_select.sql. No seed utility uses it.
--   2. CREATE SCHEMASTORE CONTAINER has no IF NOT EXISTS. The container `won`
--      is shared with the SEC views; run this file with --skip-exists when it
--      already exists.
--   3. The Zetaris cache is driver-wide and is lost on a driver restart; the
--      gateway warm-up and scripts/warmup.py re-cache the views in order.
--   4. The raw tables are never cached (4.3 million rows each); the agent only
--      reads the views.
-- =============================================================================

-- Step 0: the logical database for the raw filestore tables. Run once.
CREATE LIGHTNING DATABASE WON_GHCN DESCRIBE BY "Weather-or-Not - NOAA GHCN-Daily parquet by year and element, public S3 filestore";

-- Step 1: one filestore table per (year, element) partition. No source call
-- beyond listing the partition and inferring the schema.
CREATE LIGHTNING FILESTORE TABLE ghcn_2025_tmax FROM WON_GHCN FORMAT PARQUET OPTIONS (
  PATH "s3a://noaa-ghcn-pds/parquet/by_year/YEAR=2025/ELEMENT=TMAX/",
  inferSchema "true",
  isS3BucketPublic "true",
  useS3PathStyleAccess "true",
  s3Endpoint "s3.us-east-1.amazonaws.com"
);

CREATE LIGHTNING FILESTORE TABLE ghcn_2025_tmin FROM WON_GHCN FORMAT PARQUET OPTIONS (
  PATH "s3a://noaa-ghcn-pds/parquet/by_year/YEAR=2025/ELEMENT=TMIN/",
  inferSchema "true",
  isS3BucketPublic "true",
  useS3PathStyleAccess "true",
  s3Endpoint "s3.us-east-1.amazonaws.com"
);

CREATE LIGHTNING FILESTORE TABLE ghcn_2024_tmax FROM WON_GHCN FORMAT PARQUET OPTIONS (
  PATH "s3a://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=TMAX/",
  inferSchema "true",
  isS3BucketPublic "true",
  useS3PathStyleAccess "true",
  s3Endpoint "s3.us-east-1.amazonaws.com"
);

CREATE LIGHTNING FILESTORE TABLE ghcn_2024_tmin FROM WON_GHCN FORMAT PARQUET OPTIONS (
  PATH "s3a://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=TMIN/",
  inferSchema "true",
  isS3BucketPublic "true",
  useS3PathStyleAccess "true",
  s3Endpoint "s3.us-east-1.amazonaws.com"
);

-- Step 2: the SchemaStore container for every Weather-or-Not view (shared with
-- the SEC views). No IF NOT EXISTS: skip when it already exists.
CREATE SCHEMASTORE CONTAINER won;

-- Step 3: station-filtered views, one per raw table, same columns. The filter
-- is the seed station list (seeds/stations.json) plus USW00013740 (caveat 1).
CREATE SCHEMASTORE VIEW ghcn_2025_tmax WITH CONTAINER won AS
SELECT ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG, S_FLAG, OBS_TIME
FROM WON_GHCN.ghcn_2025_tmax
WHERE ID IN ('USW00003017', 'USW00003927', 'USW00003940', 'USW00012839', 'USW00012842', 'USW00012916', 'USW00012960', 'USW00013722', 'USW00013737', 'USW00013739', 'USW00013740', 'USW00013781', 'USW00013866', 'USW00013874', 'USW00013876', 'USW00013883', 'USW00013963', 'USW00013967', 'USW00013994', 'USW00013996', 'USW00014734', 'USW00014739', 'USW00014740', 'USW00014745', 'USW00014765', 'USW00014820', 'USW00014821', 'USW00014836', 'USW00014837', 'USW00014839', 'USW00014842', 'USW00014913', 'USW00014922', 'USW00014933', 'USW00014944', 'USW00022521', 'USW00023050', 'USW00023174', 'USW00023183', 'USW00023234', 'USW00024011', 'USW00024018', 'USW00024033', 'USW00024090', 'USW00024131', 'USW00024229', 'USW00024233', 'USW00093720', 'USW00093721', 'USW00093730', 'USW00093817', 'USW00093819', 'USW00093821', 'USW00094728', 'USW00094823', 'USW00094846', 'USW00094847');

CREATE SCHEMASTORE VIEW ghcn_2025_tmin WITH CONTAINER won AS
SELECT ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG, S_FLAG, OBS_TIME
FROM WON_GHCN.ghcn_2025_tmin
WHERE ID IN ('USW00003017', 'USW00003927', 'USW00003940', 'USW00012839', 'USW00012842', 'USW00012916', 'USW00012960', 'USW00013722', 'USW00013737', 'USW00013739', 'USW00013740', 'USW00013781', 'USW00013866', 'USW00013874', 'USW00013876', 'USW00013883', 'USW00013963', 'USW00013967', 'USW00013994', 'USW00013996', 'USW00014734', 'USW00014739', 'USW00014740', 'USW00014745', 'USW00014765', 'USW00014820', 'USW00014821', 'USW00014836', 'USW00014837', 'USW00014839', 'USW00014842', 'USW00014913', 'USW00014922', 'USW00014933', 'USW00014944', 'USW00022521', 'USW00023050', 'USW00023174', 'USW00023183', 'USW00023234', 'USW00024011', 'USW00024018', 'USW00024033', 'USW00024090', 'USW00024131', 'USW00024229', 'USW00024233', 'USW00093720', 'USW00093721', 'USW00093730', 'USW00093817', 'USW00093819', 'USW00093821', 'USW00094728', 'USW00094823', 'USW00094846', 'USW00094847');

CREATE SCHEMASTORE VIEW ghcn_2024_tmax WITH CONTAINER won AS
SELECT ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG, S_FLAG, OBS_TIME
FROM WON_GHCN.ghcn_2024_tmax
WHERE ID IN ('USW00003017', 'USW00003927', 'USW00003940', 'USW00012839', 'USW00012842', 'USW00012916', 'USW00012960', 'USW00013722', 'USW00013737', 'USW00013739', 'USW00013740', 'USW00013781', 'USW00013866', 'USW00013874', 'USW00013876', 'USW00013883', 'USW00013963', 'USW00013967', 'USW00013994', 'USW00013996', 'USW00014734', 'USW00014739', 'USW00014740', 'USW00014745', 'USW00014765', 'USW00014820', 'USW00014821', 'USW00014836', 'USW00014837', 'USW00014839', 'USW00014842', 'USW00014913', 'USW00014922', 'USW00014933', 'USW00014944', 'USW00022521', 'USW00023050', 'USW00023174', 'USW00023183', 'USW00023234', 'USW00024011', 'USW00024018', 'USW00024033', 'USW00024090', 'USW00024131', 'USW00024229', 'USW00024233', 'USW00093720', 'USW00093721', 'USW00093730', 'USW00093817', 'USW00093819', 'USW00093821', 'USW00094728', 'USW00094823', 'USW00094846', 'USW00094847');

CREATE SCHEMASTORE VIEW ghcn_2024_tmin WITH CONTAINER won AS
SELECT ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG, S_FLAG, OBS_TIME
FROM WON_GHCN.ghcn_2024_tmin
WHERE ID IN ('USW00003017', 'USW00003927', 'USW00003940', 'USW00012839', 'USW00012842', 'USW00012916', 'USW00012960', 'USW00013722', 'USW00013737', 'USW00013739', 'USW00013740', 'USW00013781', 'USW00013866', 'USW00013874', 'USW00013876', 'USW00013883', 'USW00013963', 'USW00013967', 'USW00013994', 'USW00013996', 'USW00014734', 'USW00014739', 'USW00014740', 'USW00014745', 'USW00014765', 'USW00014820', 'USW00014821', 'USW00014836', 'USW00014837', 'USW00014839', 'USW00014842', 'USW00014913', 'USW00014922', 'USW00014933', 'USW00014944', 'USW00022521', 'USW00023050', 'USW00023174', 'USW00023183', 'USW00023234', 'USW00024011', 'USW00024018', 'USW00024033', 'USW00024090', 'USW00024131', 'USW00024229', 'USW00024233', 'USW00093720', 'USW00093721', 'USW00093730', 'USW00093817', 'USW00093819', 'USW00093821', 'USW00094728', 'USW00094823', 'USW00094846', 'USW00094847');

-- Step 4: cache the views (each CACHE scans the 9 files of its partition once;
-- about 40 s each). Order: the 2025 pair first (the demo period), then 2024.
CACHE TABLE won.ghcn_2025_tmax;
CACHE TABLE won.ghcn_2025_tmin;
CACHE TABLE won.ghcn_2024_tmax;
CACHE TABLE won.ghcn_2024_tmin;

-- Next: verify with 04_won_ghcn_select.sql
