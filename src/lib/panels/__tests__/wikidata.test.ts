import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuery, fetchWikidataFacts, parseWikidataResponse, MAX_VALUES_PER_FACT } from "../wikidata";
import { PanelFetchError } from "../fetchJson";
import { jsonResponse, wdBinding, wdBody, wdMorocco, wdNetherlands } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DAY = "2026-10-13";

describe("buildQuery", () => {
  it("looks the country up by its ISO code and asks only for current statements", () => {
    const query = buildQuery("MA");
    expect(query).toContain('?c wdt:P297 "MA"');
    for (const property of ["P38", "P35", "P6"]) expect(query).toContain(`p:${property} ?st`);
    // Inside each branch: hoisted out, the planner scans all of Wikidata.
    expect(query.match(/FILTER NOT EXISTS \{ \?st pq:P582 \[\] \}/g)).toHaveLength(3);
  });

  it.each(['MA" } ?x ?y ?z . { "', "ma", "MAR", ""])("refuses %j", (code) => {
    expect(() => buildQuery(code)).toThrow(PanelFetchError);
  });
});

describe("parseWikidataResponse", () => {
  it("reads currency, head of state and head of government", () => {
    expect(parseWikidataResponse(wdMorocco, DAY)).toEqual({
      entity: "Q1028",
      retrievedOn: DAY,
      currency: [{ id: "Q200192", label: "Moroccan dirham" }],
      headOfState: [{ id: "Q57553", label: "Mohammed VI of Morocco" }],
      headOfGovernment: [{ id: "Q3378813", label: "Aziz Akhannouch" }],
    });
  });

  it(`shows no currency when there are more than ${MAX_VALUES_PER_FACT} current ones (the Netherlands)`, () => {
    const facts = parseWikidataResponse(wdNetherlands, DAY);
    expect(facts?.entity).toBe("Q29999");
    expect(facts?.currency).toEqual([]);
    expect(facts?.headOfGovernment).toEqual([{ id: "Q28860866", label: "Rob Jetten" }]);
  });

  it("keeps up to two values, joined by the box (co-princes)", () => {
    const facts = parseWikidataResponse(
      wdBody([
        wdBinding({ prop: "headOfState", value: "Q1", label: "First" }),
        wdBinding({ prop: "headOfState", value: "Q2", label: "Second" }),
      ]),
      DAY
    );
    expect(facts?.headOfState.map((p) => p.label)).toEqual(["First", "Second"]);
  });

  it("drops a value with no English label rather than showing its Q-id", () => {
    const facts = parseWikidataResponse(
      wdBody([
        wdBinding({ prop: "currency", value: "Q4916", label: null }),
        wdBinding({ prop: "headOfState", value: "Q9", label: "Someone" }),
      ]),
      DAY
    );
    expect(facts?.currency).toEqual([]);
    expect(facts?.headOfState).toEqual([{ id: "Q9", label: "Someone" }]);
  });

  it("prefers preferred-rank statements over normal ones", () => {
    const facts = parseWikidataResponse(
      wdBody([
        wdBinding({ prop: "headOfGovernment", value: "Q10", label: "Outgoing", rank: "Normal" }),
        wdBinding({ prop: "headOfGovernment", value: "Q11", label: "Current", rank: "Preferred" }),
      ]),
      DAY
    );
    expect(facts?.headOfGovernment).toEqual([{ id: "Q11", label: "Current" }]);
  });

  it("uses normal-rank statements when none is preferred", () => {
    const facts = parseWikidataResponse(
      wdBody([wdBinding({ prop: "currency", value: "Q12", label: "Coin", rank: "Normal" })]),
      DAY
    );
    expect(facts?.currency).toEqual([{ id: "Q12", label: "Coin" }]);
  });

  it("counts one item once, whatever rows repeat it", () => {
    const row = wdBinding({ prop: "headOfState", value: "Q5", label: "Repeated" });
    expect(parseWikidataResponse(wdBody([row, row, row]), DAY)?.headOfState).toEqual([{ id: "Q5", label: "Repeated" }]);
  });

  it("picks the most linked of two items sharing the code, then the older Q-id", () => {
    const facts = parseWikidataResponse(
      wdBody([
        wdBinding({ entity: "Q756617", links: 80, prop: "headOfState", value: "Q1", label: "From the kingdom" }),
        wdBinding({ entity: "Q35", links: 300, prop: "headOfState", value: "Q2", label: "From the country" }),
      ]),
      DAY
    );
    expect(facts?.entity).toBe("Q35");
    expect(facts?.headOfState).toEqual([{ id: "Q2", label: "From the country" }]);

    const tie = parseWikidataResponse(
      wdBody([
        wdBinding({ entity: "Q900", links: 50, prop: "currency", value: "Q1", label: "A" }),
        wdBinding({ entity: "Q90", links: 50, prop: "currency", value: "Q2", label: "B" }),
      ]),
      DAY
    );
    expect(tie?.entity).toBe("Q90");
  });

  it("skips an unknown-value statement (a blank node) and anything not an item", () => {
    const facts = parseWikidataResponse(
      wdBody([
        wdBinding({ prop: "headOfState", value: "t123", valueType: "bnode" }),
        wdBinding({ prop: "headOfState", value: "javascript:alert(1)", valueType: "literal" }),
        wdBinding({ prop: "headOfGovernment", value: "Q7", label: "Kept" }),
      ]),
      DAY
    );
    expect(facts?.headOfState).toEqual([]);
    expect(facts?.headOfGovernment).toEqual([{ id: "Q7", label: "Kept" }]);
  });

  it("drops an over-long label", () => {
    const facts = parseWikidataResponse(
      wdBody([wdBinding({ prop: "headOfState", value: "Q8", label: "x".repeat(101) })]),
      DAY
    );
    expect(facts?.headOfState).toEqual([]);
  });

  it("throws, so nothing is cached, when no value at all has an English label", () => {
    const body = wdBody([
      wdBinding({ prop: "currency", value: "Q200192", label: null }),
      wdBinding({ prop: "headOfState", value: "Q57553", label: null }),
    ]);
    expect(() => parseWikidataResponse(body, DAY)).toThrow(PanelFetchError);
  });

  it("answers null when no item carries the code", () => {
    expect(parseWikidataResponse(wdBody([]), DAY)).toBeNull();
  });

  it.each([
    ["no results", { head: {} }],
    ["bindings not an array", { results: { bindings: {} } }],
    ["a binding missing its value", { results: { bindings: [{ c: { type: "uri", value: "x" } }] } }],
    ["an HTML error page parsed as a string", "<html>"],
    ["too many rows", wdBody(Array(201).fill(wdBinding({ prop: "currency", value: "Q1" })))],
  ])("throws on %s", (_name, body) => {
    expect(() => parseWikidataResponse(body, DAY)).toThrow(PanelFetchError);
  });
});

describe("fetchWikidataFacts", () => {
  it("queries the public SPARQL endpoint for JSON and stamps the UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T23:30:00-04:00"));
    const fetchMock = vi.fn(async () => jsonResponse(wdMorocco));
    vi.stubGlobal("fetch", fetchMock);

    const facts = await fetchWikidataFacts("MA");
    expect(facts?.retrievedOn).toBe("2026-10-14");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://query.wikidata.org/sparql");
    expect(parsed.searchParams.get("query")).toBe(buildQuery("MA"));
    expect((init.headers as Record<string, string>).Accept).toBe("application/sparql-results+json");
  });
});
