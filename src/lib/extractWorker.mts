/**
 * The parser thread for full-text extraction: turns one page's HTML into its
 * article text with linkedom and Readability.
 *
 * Both run synchronously, and a crafted page (deep nesting, millions of text
 * nodes) can keep them busy for seconds. Here that blocks only this thread:
 * the server's own event loop keeps answering, and `extract.ts` terminates
 * this thread when a page runs past its time.
 *
 * Self-contained on purpose: the thread runs this file on its own, so it
 * imports only packages, never the app's other modules. Its limits arrive as
 * `workerData` from `extract.ts`, which owns them.
 *
 * Messages: `{ html }` in; `{ ok: true, text }` or `{ ok: false, reason }`
 * out, with the text cut to `maxChars`, so a page's full text never crosses
 * back to the server's thread.
 */

import { parentPort, workerData } from "node:worker_threads";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export type ParserLimits = {
  /** Elements in the parsed page, past which it is refused before Readability. */
  maxElements: number;
  /** Levels of nesting below <html>, past which it is refused before Readability. */
  maxDepth: number;
  /** The most characters of text posted back. */
  maxChars: number;
};

export type ParserReply = { ok: true; text: string } | { ok: false; reason: "too_large" | "no_content" | "error" };

class Refused extends Error {
  readonly reason: "too_large" | "no_content";
  constructor(reason: "too_large" | "no_content") {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Readability's reading of the page, whitespace collapsed. Readability slows
 * with the cube of nesting depth and runs once per element, so the two checks
 * before it keep a page that parsed quickly from then running for minutes.
 * Readability's own `maxElemsToParse` can't do this: it counts with
 * getElementsByTagName("*"), which linkedom answers with an empty list.
 */
function articleText(html: string, limits: ParserLimits): string {
  const { document } = parseHTML(html);
  // A body with no markup at all gives linkedom nothing to build a page from.
  if (!document?.documentElement) throw new Refused("no_content");
  if (document.querySelectorAll("*").length > limits.maxElements) throw new Refused("too_large");
  if (deeperThan(document.documentElement, limits.maxDepth)) throw new Refused("too_large");
  const article = new Readability(document as unknown as Document).parse();
  return (article?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Whether any element sits more than `limit` levels below `root`. Iterative, so depth can't overflow the stack. */
function deeperThan(root: { firstElementChild: unknown }, limit: number): boolean {
  type El = { firstElementChild: El | null; nextElementSibling: El | null };
  const stack: [El, number][] = [[root as El, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > limit) return true;
    for (let child = node.firstElementChild; child; child = child.nextElementSibling) stack.push([child, depth + 1]);
  }
  return false;
}

function reply(html: unknown, limits: ParserLimits): ParserReply {
  if (typeof html !== "string") return { ok: false, reason: "error" };
  try {
    return { ok: true, text: articleText(html, limits).slice(0, limits.maxChars) };
  } catch (err) {
    return { ok: false, reason: err instanceof Refused ? err.reason : "error" };
  }
}

if (parentPort) {
  const port = parentPort;
  const limits = workerData as ParserLimits;
  port.on("message", (message: { html?: unknown }) => {
    port.postMessage(reply(message?.html, limits));
  });
  // Sent once the parser libraries have loaded, so a page's time limit
  // counts its parse and not this thread's start.
  port.postMessage({ ready: true });
}
