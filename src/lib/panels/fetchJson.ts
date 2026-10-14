import "server-only";

/**
 * Wikimedia's policy asks every client for a descriptive User-Agent with a
 * way to reach its operator; the World Bank gets the same one.
 */
export const PANEL_USER_AGENT = "H72NewsAggregator/0.1 (https://news.h72labs.com)";

/** Covers the whole exchange, body included: a slow upstream costs at most this. */
export const PANEL_TIMEOUT_MS = 4_000;

/**
 * Any way an upstream call can fail: network error, timeout, non-OK status,
 * an oversized or unparseable body, or a body of the wrong shape. Panel
 * fetchers throw it rather than return a fallback, so a cache wrapped around
 * them never stores a failure as the day's answer.
 */
export class PanelFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PanelFetchError";
  }
}

type FetchOptions = {
  maxBytes: number;
  accept?: string;
  /** Longer than PANEL_TIMEOUT_MS only for an upstream measured to be slow. */
  timeoutMs?: number;
  /** Extra request headers, such as an API key. Never echoed into an error message. */
  headers?: Record<string, string>;
};

/**
 * GETs a JSON document from an upstream data API with a timeout and a size
 * cap, and returns it parsed but unvalidated: callers check its shape. Not
 * cached here; the caller's `unstable_cache` is the only cache, so only a
 * validated answer is ever stored.
 */
export async function fetchCappedJson(
  url: string,
  { accept = "application/json", ...options }: FetchOptions
): Promise<unknown> {
  const text = await fetchCappedText(url, { accept, ...options });
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new PanelFetchError(`unparseable JSON: ${hostOf(url)}`, { cause: err });
  }
}

/**
 * fetchCappedJson's rules for a text body such as XML: the same timeout
 * covering the body, size cap and no-redirect rule, and only PanelFetchError
 * thrown. Returns the body unparsed.
 */
export async function fetchCappedText(
  url: string,
  { maxBytes, accept = "text/plain", timeoutMs = PANEL_TIMEOUT_MS, headers = {} }: FetchOptions
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers, "User-Agent": PANEL_USER_AGENT, Accept: accept },
    });
  } catch (err) {
    throw new PanelFetchError(`request failed: ${hostOf(url)}`, { cause: err });
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new PanelFetchError(`status ${res.status}: ${hostOf(url)}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new PanelFetchError(`body over ${maxBytes} bytes: ${hostOf(url)}`);
  }

  return readCappedText(res, maxBytes, url);
}

async function readCappedText(res: Response, maxBytes: number, url: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PanelFetchError(`body over ${maxBytes} bytes: ${hostOf(url)}`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PanelFetchError) throw err;
    // The timeout signal also aborts a body still arriving.
    throw new PanelFetchError(`body read failed: ${hostOf(url)}`, { cause: err });
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
}
