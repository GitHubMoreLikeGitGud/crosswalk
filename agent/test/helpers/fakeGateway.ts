// A GatewayClient over an in-memory fetch: canned template replies keyed by template id and
// parameters, a registrar that records its calls, and a call log for assertions. Synthetic
// data only (no SEC or NOAA values).
import { createHash } from "node:crypto";
import { GatewayClient, type TemplateResponse } from "../../src/zetaris/client.ts";

export type Reply = { columns: string[]; rows: unknown[][]; elapsed_ms?: number; cache_state?: string } | { error: string; status: number };

export type Resolver = (templateId: string, params: Record<string, string>) => Reply | undefined;

export interface FakeGateway {
  client: GatewayClient;
  calls: { template_id: string; params: Record<string, string> }[];
  registrarCalls: { action: string; params: Record<string, string> }[];
  /** Objects the registrar has "created": a template that resolved to missing before becomes available after. */
  registered: Set<string>;
}

export function missing(object: string): Reply {
  return { error: `TABLE_OR_VIEW_NOT_FOUND: ${object}`, status: 502 };
}

export function fakeGateway(resolve: Resolver, opts: { registrarOk?: boolean } = {}): FakeGateway {
  const calls: FakeGateway["calls"] = [];
  const registrarCalls: FakeGateway["registrarCalls"] = [];
  const registered = new Set<string>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/health") return new Response(JSON.stringify({ ok: true, templates: [] }), { status: 200 });
    if (u.pathname.startsWith("/registrar/")) {
      const action = decodeURIComponent(u.pathname.slice("/registrar/".length));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const { contract, ...params } = body;
      registrarCalls.push({ action, params: params as Record<string, string> });
      if (!contract || typeof contract !== "object") return new Response(JSON.stringify({ error: "missing contract", code: "missing" }), { status: 403 });
      if (opts.registrarOk === false) return new Response(JSON.stringify({ error: "registrar refused", code: "refused" }), { status: 502 });
      registered.add(`${action}:${JSON.stringify(params)}`);
      const sql = `CREATE ${action} ${JSON.stringify(params)}`;
      return new Response(
        JSON.stringify({
          action,
          params,
          contract_id: (contract as { contractId?: string }).contractId ?? "c-test",
          steps: [
            { template_id: `registrar_${action.replace("register_", "")}_table`, kind: "register", sql, sql_sha256: sha(sql), objects: [], elapsed_ms: 5 },
            { template_id: `registrar_${action.replace("register_", "")}_cache`, kind: "register", sql: `CACHE ${sql}`, sql_sha256: sha(`CACHE ${sql}`), objects: [], elapsed_ms: 7 },
          ],
          skipped: [],
        }),
        { status: 200 },
      );
    }
    const body = JSON.parse(String(init?.body)) as { template_id: string; params: Record<string, string> };
    calls.push({ template_id: body.template_id, params: body.params });
    const r = resolve(body.template_id, body.params);
    if (!r) return new Response(JSON.stringify({ error: `no fake reply for ${body.template_id} ${JSON.stringify(body.params)}` }), { status: 500 });
    if ("error" in r) return new Response(JSON.stringify({ ...empty(body.template_id), error: r.error }), { status: r.status });
    const sql = `SELECT * FROM fake.${body.template_id} WHERE ${JSON.stringify(body.params)}`;
    const resp: TemplateResponse = {
      ...empty(body.template_id),
      columns: r.columns,
      rows: r.rows,
      row_count: r.rows.length,
      elapsed_ms: r.elapsed_ms ?? 12,
      sql,
      sql_sha256: sha(sql),
      objects: [`fake.${body.template_id}`],
      raw_objects: [`cw.fake_${body.template_id}`],
      cache_state: r.cache_state ?? "hit",
      source_cached_at: { [`cw.fake_${body.template_id}`]: "2026-10-24T00:00:00+08:00" },
    };
    return new Response(JSON.stringify(resp), { status: 200 });
  }) as typeof fetch;
  return { client: new GatewayClient({ baseUrl: "http://127.0.0.1:8803", fetchImpl, warmRetries: 0 }), calls, registrarCalls, registered };
}

function empty(templateId: string): TemplateResponse {
  return {
    template_id: templateId,
    role: "reader",
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    elapsed_ms: 0,
    sql: null,
    sql_sha256: null,
    objects: [],
    raw_objects: [],
    executed_at: "2026-10-24T20:00:00+08:00",
    cache_state: "unknown",
    cache_detail: {},
    source_cached_at: {},
    error: null,
  };
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
