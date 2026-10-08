import { describe } from "vitest";
import { MAX_HTML_BYTES } from "@/lib/extract";

/**
 * Wall-clock room a real-thread test allows past the parser thread's time
 * limit (PARSE_TIMEOUT_MS) or a caller's deadline before it fails: the
 * thread's start, the fetch and decode of a 3 MB page, terminate(), and the
 * other test files sharing the CPU. Measured at about 200 ms on an idle
 * laptop; GitHub's Linux runners are slower, so the default is several times
 * that. Raise it on a slower machine with EXTRACT_SLOW_CPU_SLACK_MS=<ms>.
 */
export const SLOW_CPU_SLACK_MS = Number(process.env.EXTRACT_SLOW_CPU_SLACK_MS) || 1_500;

/**
 * The real-thread stress tests take minutes, so they run only with
 * EXTRACT_STRESS=1 (CI sets it). A fast real-thread test stays in the default
 * suite (extract.worker.test.ts), so a broken worker still fails `vitest run`.
 */
export const describeStress = describe.skipIf(!process.env.EXTRACT_STRESS);

/**
 * A page only the parser thread's time limit stops: under both element
 * limits (about 19,975 elements, 64 deep) and well inside the thread's heap,
 * but about 6 s of Readability on an idle laptop, twice PARSE_TIMEOUT_MS, so
 * it can't finish in time on a fast CPU. The class on every div is what makes
 * it slow (Readability weighs every element's class on each of its passes);
 * the same chains without it took about 2.9 s, too close to the limit.
 */
export const SLOW_PAGE = (() => {
  const div = '<div class="a b c d e f g h i j k l m n o p q r s t">';
  const chain = div.repeat(62) + "x<br>" + "</div>".repeat(62);
  const page = `<!doctype html><html><head><title>t</title></head><body>${chain.repeat(317)}</body></html>`;
  if (page.length > MAX_HTML_BYTES) throw new Error("SLOW_PAGE is past MAX_HTML_BYTES");
  return page;
})();
