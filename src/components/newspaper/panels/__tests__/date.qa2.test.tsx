// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CountryFactsBox } from "../CountryFactsBox";

const render = (retrievedOn: unknown) =>
  renderToStaticMarkup(
    <CountryFactsBox
      facts={{
        country: "Morocco",
        worldBank: null,
        wikidata: {
          entity: "Q1028",
          retrievedOn: retrievedOn as string,
          currency: [{ id: "Q1", label: "Dirham" }],
          headOfState: [],
          headOfGovernment: [],
        },
      }}
    />
  );

describe("Wikidata source line", () => {
  it("valid day", () => expect(render("2026-10-13")).toContain("Wikidata, as of Oct 13, 2026"));
  it("leap day / year edges", () => {
    expect(render("2028-02-29")).toContain("Feb 29, 2028");
    expect(render("2026-12-31")).toContain("Dec 31, 2026");
  });
  it.each(["", "garbage", "2026-13-45", "2026-00-10", "2026-10-00", "2026-10-13T00:00:00Z", " 2026-10-13", "20261013", "2026-10-13\n"])(
    "bad value %j does not throw and degrades to plain Wikidata",
    (v) => {
      const html = render(v);
      expect(html).toContain("Dirham");
      expect(html).not.toContain("as of");
    }
  );
  it("non-string stored value (undefined/null/number) does not throw", () => {
    for (const v of [undefined, null, 20261013]) expect(() => render(v)).not.toThrow();
  });
  it("Feb 30 does not throw", () => {
    expect(render("2026-02-30")).toContain("Dirham");
  });
});
