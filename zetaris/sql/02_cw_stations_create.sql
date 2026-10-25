-- =============================================================================
-- Source: NOAA GHCN-Daily station inventory ghcnd-stations.txt on the public
-- AWS bucket: s3a://noaa-ghcn-pds/ghcnd-stations.txt (about 11 MB, one
-- fixed-width 85-character line per station, about 133,000 stations).
-- Columns (1-based, from readme.txt): ID 1-11, LATITUDE 13-20, LONGITUDE
-- 22-30, ELEVATION 32-37, STATE 39-40 (US and Canadian stations only),
-- NAME 42-71, GSN FLAG 73-75, HCN/CRN FLAG 77-79, WMO ID 81-85.
-- Licence: CC0-1.0 (public domain), https://registry.opendata.aws/noaa-ghcn/
-- Format: fixed width, so it is registered as a ONE-column CSV: a delimiter
-- that never occurs in the file ('|', checked over every line of the file
-- downloaded 2026-10-25), no header, no schema inference, quoting off (24
-- lines contain a double quote in the name). The single column is _c0; a
-- SchemaStore view parses it with SUBSTR.
-- Docs: https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt
--       https://docs.opendata.aws/noaa-ghcn-pds/readme.html
-- Rate limit: none (anonymous S3). An uncached read scans the file from S3
-- on every query, so the parsed view is cached.
-- Status: run live 2026-10-25 against Zetaris 2.4.3.1; counts and timings in
-- ../README.md.
-- =============================================================================
--
-- Caveats:
--   1. CREATE LIGHTNING DATABASE accepts no IF NOT EXISTS on 2.4.3.1; rerun
--      with --skip-exists. CW_GHCN is also the database of the GHCN parquet
--      tables (09_cw_ghcn_create.sql, or register_source at run time).
--   2. The STATE column is blank for stations outside the US and Canada; the
--      view keeps every station and the join map filters on id LIKE 'US%'.
--   3. Trailing spaces in NAME are trimmed in the view.
-- =============================================================================

-- Step 0: the Lightning database. No source call.
CREATE LIGHTNING DATABASE CW_GHCN DESCRIBE BY "Crosswalk - NOAA GHCN-Daily station inventory as a one-column CSV and parquet by year and element, public S3 filestore";

-- Step 1: the inventory as a one-column CSV filestore table.
CREATE LIGHTNING FILESTORE TABLE ghcnd_stations_txt FROM CW_GHCN FORMAT CSV OPTIONS (
  PATH "s3a://noaa-ghcn-pds/ghcnd-stations.txt",
  delimiter "|",
  quote "",
  header "false",
  inferSchema "false",
  isS3BucketPublic "true",
  useS3PathStyleAccess "true",
  s3Endpoint "s3.us-east-1.amazonaws.com"
);

-- Step 2: the parsed view (1-based SUBSTR positions from readme.txt).
CREATE SCHEMASTORE VIEW stations WITH CONTAINER cw AS
SELECT SUBSTR(_c0, 1, 11) AS id,
       SUBSTR(_c0, 39, 2) AS state,
       TRIM(SUBSTR(_c0, 42, 30)) AS name,
       CAST(TRIM(SUBSTR(_c0, 13, 8)) AS DOUBLE) AS latitude,
       CAST(TRIM(SUBSTR(_c0, 22, 9)) AS DOUBLE) AS longitude
FROM CW_GHCN.ghcnd_stations_txt;

-- Step 3: cache the view (one S3 scan).
CACHE TABLE cw.stations;

-- Next: verify with 02_cw_stations_select.sql
