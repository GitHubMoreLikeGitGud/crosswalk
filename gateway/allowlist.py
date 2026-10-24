"""Statement allowlist for the gateway's Zetaris connections.

Adapted from ClearShelf (same author, Apache-2.0).

Roles, each a superset of the one before:
- reader:    SELECT, SHOW (SHOW DQ included), DESCRIBE, LOAD USL, LIST DQ, RUN DQ
- registrar: + CREATE LIGHTNING DATABASE WON_*, CREATE SCHEMASTORE CONTAINER won,
               CREATE [OR REPLACE] SCHEMASTORE VIEW ... WITH CONTAINER won AS SELECT ...,
               CREATE LIGHTNING REST TABLE ... FROM WON_* (allowlisted https hosts only),
               CREATE LIGHTNING FILESTORE TABLE ... FROM WON_* (the noaa-ghcn-pds bucket only),
               CACHE / UNCACHE TABLE won.* and WON_*.*, UNCACHE LIGHTNING FILESTORE TABLE,
               CREATE NAMESPACE IF NOT EXISTS lightning.metastore[.weatherornot],
               COMPILE USL weather_or_not_usl DEPLOY NAMESPACE lightning.metastore.weatherornot,
               ACTIVATE USL TABLE lightning.metastore.weatherornot.*, REGISTER DQ on that USL
- onboard:   + UPDATE USL ... SET DESCRIPTION, UPDATE DQ (expression only, same name),
               REMOVE USL weather_or_not_usl (the CLI's role; the HTTP gateway never uses it)

Always refused: DROP, GRANT, REVOKE, INVALIDATE CACHE, OFFSITE*, port 8889, more than one
statement, and a trailing semicolon. The one multi-part statement is COMPILE USL, and every
part after its DDL keyword must be a CREATE TABLE.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

ROLES = ("reader", "registrar", "onboard")
REST_HOSTS = {
    "data.sec.gov": "https",
    "company-dns.mediumroast.io": "https",
}
FILESTORE_BUCKETS = ("s3a://noaa-ghcn-pds/",)
CONTAINER = "won"
DB = r"WON_[A-Z]+"
NAMESPACE = "lightning.metastore.weatherornot"
USL_NAME = "weather_or_not_usl"
USL = f"{NAMESPACE}.{USL_NAME}"

_ID = r"[A-Za-z_][A-Za-z0-9_]*"
_NS = re.escape(NAMESPACE)
_USL_TABLE = rf"{_NS}(?:\.{_ID}){{1,2}}"  # namespace.usl.table
_QUOTED = r"(?:\"[^\"]*\"|'[^']*')"
_ALWAYS_REFUSED = re.compile(r"^\s*(DROP|GRANT|REVOKE|INVALIDATE\s+CACHE|OFFSITE)\b", re.I)
_READER = re.compile(r"^\s*(SELECT|SHOW|DESCRIBE|LOAD\s+USL|LIST\s+DQ|RUN\s+DQ)\b", re.I)
_WRITE = re.compile(r"\b(DROP|GRANT|REVOKE|TRUNCATE|ALTER|INSERT|DELETE|UPDATE|MERGE|REMOVE|OFFSITE|INVALIDATE)\b", re.I)
_COMPILE_HEAD = re.compile(
    rf"^\s*COMPILE\s+USL\s+(IF\s+NOT\s+EXISTS\s+)?{USL_NAME}\s+DEPLOY\s+NAMESPACE\s+{_NS}\s+DDL\s+", re.I)
_COMPILE_PART = re.compile(rf"^\s*CREATE\s+TABLE\s+{_ID}\s*\(", re.I)
_SUBQUERY_OR_WRITE = re.compile(
    r"\b(SELECT|FROM|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|REMOVE)\b", re.I)

_REST = re.compile(rf"^\s*CREATE\s+LIGHTNING\s+REST\s+TABLE\s+{_ID}\s+FROM\s+{DB}\s+REQUEST\s*\(", re.I)
_FILESTORE = re.compile(
    rf"^\s*CREATE\s+LIGHTNING\s+FILESTORE\s+TABLE\s+{_ID}\s+FROM\s+{DB}\s+FORMAT\s+(PARQUET|CSV)\s+OPTIONS\s*\(", re.I)
_DATABASE = re.compile(
    rf"^\s*CREATE\s+LIGHTNING\s+DATABASE\s+(IF\s+NOT\s+EXISTS\s+)?{DB}(\s+DESCRIBE\s+BY\s+{_QUOTED})?\s*$", re.I)
_CONTAINER = re.compile(rf"^\s*CREATE\s+SCHEMASTORE\s+CONTAINER\s+{CONTAINER}\s*$", re.I)
_VIEW = re.compile(
    rf"^\s*CREATE\s+(OR\s+REPLACE\s+)?SCHEMASTORE\s+VIEW\s+"
    rf"(?:{_ID}\s+WITH\s+CONTAINER\s+{CONTAINER}|{CONTAINER}\.{_ID})\s+AS\s+SELECT\b", re.I)
_NAMESPACE = re.compile(r"^\s*CREATE\s+NAMESPACE\s+IF\s+NOT\s+EXISTS\s+lightning\.metastore(\.weatherornot)?\s*$", re.I)
_CACHE = re.compile(rf"^\s*(CACHE|UNCACHE)\s+TABLE\s+(IF\s+EXISTS\s+)?(?:{CONTAINER}|{DB})\.{_ID}\s*$", re.I)
_UNCACHE_FILESTORE = re.compile(rf"^\s*UNCACHE\s+LIGHTNING\s+FILESTORE\s+TABLE\s+{_ID}\s+FROM\s+{DB}\s*$", re.I)
_ACTIVATE = re.compile(rf"^\s*ACTIVATE\s+USL\s+TABLE\s+{_USL_TABLE}\s+AS\s+SELECT\b", re.I)
_REGISTER_DQ = re.compile(rf"^\s*REGISTER\s+DQ\s+{_ID}\s+TABLE\s+{_USL_TABLE}\s+AS\s+(\S.*)$", re.I | re.S)
_UPDATE_DQ = re.compile(
    rf"^\s*UPDATE\s+DQ\s+({_ID})\s+TABLE\s+{_USL_TABLE}\s+SET\s+NAME\s*=\s*({_ID})\s*,\s*EXPRESSION\s*=\s*(\S.*)$",
    re.I | re.S)
_UPDATE_USL_DESCRIPTION = re.compile(
    rf"^\s*UPDATE\s+USL\s+{re.escape(USL)}(\.{_ID}){{0,2}}\s+SET\s+((TABLE|COLUMN)\s+)?DESCRIPTION\s", re.I)
_REMOVE_USL = re.compile(rf"^\s*REMOVE\s+USL\s+{USL_NAME}\s+NAMESPACE\s+{_NS}\s*$", re.I)


class Refused(ValueError):
    pass


def _strip_literals(sql: str) -> str:
    """The statement with quoted text blanked, for structural checks."""
    out, quote = [], None
    for c in sql:
        if quote:
            if c == quote:
                quote = None
                out.append(c)
            else:
                out.append(" ")
        elif c in "'\"`":
            quote = c
            out.append(c)
        else:
            out.append(c)
    return "".join(out)


def _check_compile(bare: str) -> None:
    """COMPILE USL weather_or_not_usl ... DDL CREATE TABLE ...; CREATE TABLE ...
    `bare` has literals blanked, so semicolons inside quotes do not split."""
    head = _COMPILE_HEAD.match(bare)
    if not head:
        raise Refused(f"COMPILE USL only for {USL_NAME} in the {NAMESPACE} namespace")
    for part in bare[head.end():].split(";"):
        if not _COMPILE_PART.match(part):
            raise Refused("every COMPILE USL part must be a CREATE TABLE: " + " ".join(part.split())[:60])
    if _WRITE.search(bare):
        raise Refused("write keyword inside COMPILE USL")


def _rest_ok(sql: str, bare: str) -> bool:
    if not _REST.match(sql):
        return False
    endpoints = re.findall(r"\bendpoint\s+[\"']([^\"']+)[\"']", sql, re.I)
    if len(endpoints) != 1:
        raise Refused("a REST table needs exactly one endpoint")
    u = urlsplit(endpoints[0])
    try:
        port = u.port
    except ValueError:
        port = -1
    if REST_HOSTS.get(u.hostname or "") != u.scheme or port is not None:
        raise Refused(f"endpoint host not allowlisted: {u.scheme}://{u.netloc}")
    if re.search(r"\bAUTH\s+BY\b", bare, re.I):
        raise Refused("AUTH BY is not used by Weather-or-Not")
    return True


def _filestore_ok(sql: str, bare: str) -> bool:
    if not _FILESTORE.match(sql):
        return False
    paths = re.findall(r"\bpath\s+[\"']([^\"']+)[\"']", sql, re.I)
    if len(paths) != 1:
        raise Refused("a FILESTORE table needs exactly one PATH")
    if not any(paths[0].startswith(b) for b in FILESTORE_BUCKETS):
        raise Refused(f"filestore path not allowlisted: {paths[0][:80]}")
    if re.search(r"accesskey|secretkey|sessiontoken|credential", bare.replace("_", ""), re.I):
        raise Refused("credentials never appear in a FILESTORE statement (public bucket)")
    if re.search(r"\bsourceTable\b", bare, re.I):
        raise Refused("sourceTable writes to the path")
    return True


def _registrar_ok(sql: str, bare: str) -> bool:
    if _rest_ok(sql, bare) or _filestore_ok(sql, bare):
        return True
    if _DATABASE.match(sql) or _CONTAINER.match(sql) or _NAMESPACE.match(sql):
        return True
    if _CACHE.match(sql) or _UNCACHE_FILESTORE.match(sql):
        return True
    if _VIEW.match(sql) or _ACTIVATE.match(sql):
        if _WRITE.search(bare):
            raise Refused("write keyword inside a view or activation query")
        return True
    if _COMPILE_HEAD.match(sql):
        return True  # parts checked by _check_compile
    m = _REGISTER_DQ.match(bare)
    if m:
        if _SUBQUERY_OR_WRITE.search(m.group(1)):
            raise Refused("REGISTER DQ expression must be a plain predicate (no subquery or write keyword)")
        return True
    return False


def _update_dq_ok(sql: str, bare: str) -> bool:
    """UPDATE DQ <rule> TABLE <usl table> SET NAME = <rule>, EXPRESSION = <predicate>.
    Onboarding only, and only to change a rule's expression: the name must stay the same
    (Zetaris requires NAME in the statement), and the expression must be a plain predicate
    on the table (no subquery or write keyword, checked with literals blanked)."""
    m = _UPDATE_DQ.match(sql)
    if not m:
        return False
    if m.group(1).lower() != m.group(2).lower():
        raise Refused("UPDATE DQ may change a rule's expression only, not its name")
    bm = _UPDATE_DQ.match(bare)
    if not bm or _SUBQUERY_OR_WRITE.search(bm.group(3)):
        raise Refused("UPDATE DQ expression must be a plain predicate (no subquery or write keyword)")
    return True


def _onboard_ok(sql: str, bare: str) -> bool:
    if _update_dq_ok(sql, bare):
        return True
    return bool(_UPDATE_USL_DESCRIPTION.match(sql) or _REMOVE_USL.match(sql))


def check(sql: str, role: str) -> str:
    """Return the statement kind (read, register, onboard) if `role` may run `sql`, else raise Refused."""
    if role not in ROLES:
        raise Refused(f"unknown role: {role}")
    if not sql or not sql.strip():
        raise Refused("empty statement")
    bare = _strip_literals(sql)
    if "8889" in sql:
        raise Refused("port 8889 is never called")
    if bare.rstrip().endswith(";"):
        raise Refused("no trailing semicolon")
    is_compile = re.match(r"^\s*COMPILE\s+USL\b", sql, re.I) is not None
    if ";" in bare and not is_compile:
        raise Refused("one statement per call")
    if is_compile:
        _check_compile(bare)
    if _ALWAYS_REFUSED.match(sql):
        raise Refused("statement kind is always refused")
    if _READER.match(sql):
        if re.match(r"^\s*SELECT\b", sql, re.I) and re.search(r"\b(INSERT|DROP|GRANT|REVOKE|TRUNCATE|ALTER)\b", bare, re.I):
            raise Refused("write keyword inside a SELECT")
        return "read"
    if role in ("registrar", "onboard") and _registrar_ok(sql, bare):
        return "register"
    if role == "onboard" and _onboard_ok(sql, bare):
        return "onboard"
    raise Refused(f"not allowed for role {role}: {' '.join(sql.split())[:80]}")
