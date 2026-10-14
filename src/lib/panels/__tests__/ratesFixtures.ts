// Response bodies shaped after live answers from home.treasury.gov,
// api.frankfurter.dev and api.eia.gov, read 2026-10-13. Values are trimmed;
// shapes are not.

type TreasuryRow = { id?: number; date: string; tenYear: string | null };

function treasuryEntry({ id = 328, date, tenYear }: TreasuryRow): string {
  const ten =
    tenYear === null
      ? '<d:BC_10YEAR m:type="Edm.Double" m:null="true" />'
      : `<d:BC_10YEAR m:type="Edm.Double">${tenYear}</d:BC_10YEAR>`;
  return `<entry>
<id>https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml-item?data=daily_treasury_yield_curve&amp;id=${id}</id>
<title type="text"></title>
<updated>2026-10-13T15:45:31Z</updated>
<author><name /></author>
<link rel="edit" title="DailyTreasuryYieldCurveRateDatum" href="/resource-center/data-chart-center/interest-rates/pages/xml-item?data=daily_treasury_yield_curve&amp;id=${id}" />
<category term="TreasuryDataWarehouseModel.DailyTreasuryYieldCurveRateDatum" scheme="http://schemas.microsoft.com/ado/2007/08/dataservices/scheme" />
<content type="application/xml">
<m:properties>
<d:Id m:type="Edm.Int32">${id}</d:Id>
<d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>
<d:BC_1MONTH m:type="Edm.Double">4.06</d:BC_1MONTH>
<d:BC_7YEAR m:type="Edm.Double">5.12</d:BC_7YEAR>
${ten}
<d:BC_20YEAR m:type="Edm.Double">5.64</d:BC_20YEAR>
<d:BC_30YEARDISPLAY m:type="Edm.Double">5.61</d:BC_30YEARDISPLAY>
</m:properties>
</content>
</entry>`;
}

/** One month's feed; a month with no rows yet is the same feed with no entries. */
export function treasuryFeed(rows: TreasuryRow[]): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<feed xml:base="https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns="http://www.w3.org/2005/Atom">
<title type="text">DailyTreasuryYieldCurveRateData</title>
<id>https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml-item?data=daily_treasury_yield_curve</id>
  <updated>2026-10-13T15:45:31Z</updated>
  <link rel="self" title="DailyTreasuryYieldCurveRateData" href="DailyTreasuryYieldCurveRateData"/>
${rows.map((row, i) => treasuryEntry({ id: 328 + i, ...row })).join("\n")}
</feed>`;
}

export const treasuryOctober = treasuryFeed([
  { date: "2026-10-01", tenYear: "5.24" },
  { date: "2026-10-09", tenYear: "5.24" },
  { date: "2026-10-13", tenYear: "5.21" },
]);

export function frankfurterPair(base: string, quote: string, rate: number, date = "2026-10-13") {
  return { date, base, quote, rate };
}

type EiaRow = { period: string; series: "RBRTE" | "RWTC"; value: string | number | null };

export function eiaBody(rows: EiaRow[]) {
  return {
    // Sent whenever the series' total is over 5,000 rows, however few were asked for.
    warnings: [
      {
        warning: "incomplete return",
        description:
          "The API can only return 5000 rows in JSON format.  Please consider constraining your request with facet, start, or end, or using offset to paginate results.",
      },
    ],
    response: {
      total: "20257",
      dateFormat: "YYYY-MM-DD",
      frequency: "daily",
      data: rows.map(({ period, series, value }) => ({
        period,
        duoarea: series === "RWTC" ? "YCUOK" : "ZEU",
        "area-name": "NA",
        product: series === "RWTC" ? "EPCWTI" : "EPCBRENT",
        "product-name": series === "RWTC" ? "WTI Crude Oil" : "UK Brent Crude Oil",
        process: "PF4",
        "process-name": "Spot Price FOB",
        series,
        "series-description":
          series === "RWTC"
            ? "Cushing, OK WTI Spot Price FOB (Dollars per Barrel)"
            : "Europe Brent Spot Price FOB (Dollars per Barrel)",
        value,
        units: "$/BBL",
      })),
    },
    request: { command: "/v2/petroleum/pri/spt/data/", params: { frequency: "daily", data: ["value"] } },
    apiVersion: "2.1.14",
    ExcelAddInVersion: "2.1.0",
  };
}

export const eiaLatest = eiaBody([
  { period: "2026-10-06", series: "RWTC", value: "96.24" },
  { period: "2026-10-06", series: "RBRTE", value: "125.44" },
  { period: "2026-10-05", series: "RWTC", value: "96.13" },
  { period: "2026-10-05", series: "RBRTE", value: "125.51" },
]);

export function xmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "text/xml; charset=UTF-8" }, ...init });
}
