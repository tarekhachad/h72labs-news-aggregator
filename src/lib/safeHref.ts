/**
 * A source link as a safe `href`, or undefined when it isn't one.
 *
 * Source URLs are copied from third-party RSS items, and a card's sources can
 * also be written by its owner through persist_generated_cards, so neither is
 * trusted. React renders a `javascript:` href as-is, which would run script on
 * click, so only http and https survive.
 */
export function safeExternalHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}
