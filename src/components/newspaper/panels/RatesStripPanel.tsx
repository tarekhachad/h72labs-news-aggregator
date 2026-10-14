import { getRatesStrip } from "@/lib/panels/rates";
import { RatesStrip } from "./RatesStrip";

/**
 * The Markets & Investing page's panel. Async: on a cache miss it waits on
 * the Treasury, Frankfurter and the EIA, so it must sit inside the topic
 * page's Suspense slot. No figures, no strip.
 */
export async function RatesStripPanel() {
  const data = await getRatesStrip();
  return data ? <RatesStrip data={data} /> : null;
}
