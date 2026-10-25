import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  entriesFromCatalogue,
  entriesFromFemaCatalogue,
  entriesFromGettingStarted,
  entriesFromManifest,
  objectOf,
  searchCatalogue,
  tokenize,
  type CatalogueEntry,
} from "../src/tools/catalogueSearch.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-discovery.json", import.meta.url), "utf8"),
) as {
  synthetic: boolean;
  search: {
    inputs: {
      catalogue: unknown;
      manifest: unknown;
      fema_catalogue_rows: Record<string, unknown>[];
      getting_started: unknown;
    };
    entries: CatalogueEntry[];
    tokenize: { text: string; expected: string[] }[];
    cases: {
      query: string;
      limit: number;
      expected: CatalogueEntry[] &
        { score: number; negative: boolean }[];
    }[];
  };
};

const { search } = fixture;

describe("tokenize", () => {
  it("reproduces every search.tokenize case", () => {
    for (const { text, expected } of search.tokenize) {
      expect(tokenize(text)).toEqual(expected);
    }
  });
});

describe("entry builders", () => {
  it("concatenates the four builders in order to equal search.entries", () => {
    const got = [
      ...entriesFromCatalogue(search.inputs.catalogue),
      ...entriesFromManifest(search.inputs.manifest),
      ...entriesFromFemaCatalogue(search.inputs.fema_catalogue_rows),
      ...entriesFromGettingStarted(search.inputs.getting_started),
    ];
    expect(got).toEqual(search.entries);
  });

  it("throws on malformed catalogue or manifest", () => {
    expect(() => entriesFromCatalogue({})).toThrow();
    expect(() => entriesFromManifest({ sources: "x" })).toThrow();
  });
});

describe("objectOf", () => {
  it("parses arrow and parenthetical zetaris_object lines", () => {
    expect(
      objectOf(
        "CW_FEMA.declarations_dr_2025q1 -> cw.fema_declarations_dr_2025q1 (cached; ...)",
      ),
    ).toBe("cw.fema_declarations_dr_2025q1");
    expect(
      objectOf(
        "lightning.metastore.crosswalk.crosswalk_usl (7 tables, ...)",
      ),
    ).toBe("lightning.metastore.crosswalk.crosswalk_usl");
    expect(objectOf(undefined)).toBeNull();
    expect(objectOf("   ")).toBeNull();
  });
  it("keeps everything after the first arrow (a second arrow stays in the name)", () => {
    expect(objectOf("A.raw -> cw.view->x (note)")).toBe("cw.view->x");
    expect(objectOf("A.raw ->")).toBeNull();
  });
});

describe("searchCatalogue", () => {
  it("reproduces every search.cases hit list", () => {
    for (const { query, limit, expected } of search.cases) {
      expect(searchCatalogue(query, search.entries, limit).hits).toEqual(
        expected,
      );
    }
  });

  it("marks pudl hits as negative known_to_fail", () => {
    const { hits } = searchCatalogue(
      "electric utility data PUDL",
      search.entries,
      6,
    );
    const pudl = hits.filter((h) => h.id === "pudl" || h.id === "gs:pudl");
    expect(pudl.length).toBeGreaterThan(0);
    for (const h of pudl) {
      expect(h.negative).toBe(true);
      expect(h.status).toBe("known_to_fail");
    }
  });

  it("returns empty hits when no query token overlaps", () => {
    expect(searchCatalogue("zzz nothing matches qqq", search.entries).hits).toEqual(
      [],
    );
  });
});
