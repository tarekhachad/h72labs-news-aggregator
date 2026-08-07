const PALETTE_SIZE = 6;

// FNV-1a — cheap, deterministic, well-distributed for short strings; no
// cryptographic properties needed, this is purely a stable "same label
// always maps to the same bucket" hash, not a security primitive.
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (FNV prime), done via shifts to stay in 32-bit
    // integer math without ever needing BigInt.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash;
}

/**
 * Deterministic label -> {background, color} pair, from the 6-color
 * palette defined in globals.css (--label-bg-1..6 / --label-fg-1..6).
 * The same label string always renders the same color with zero
 * lookup-table maintenance as new free-form, LLM-generated labels appear
 * over time — the whole point of hashing instead of a curated map.
 *
 * Normalizes (trim + lowercase) before hashing so "AI", "ai", and " AI "
 * — different capitalizations/whitespace the LLM might produce for what
 * is semantically the same label across different cards/runs — still
 * always land on the same color. Without this, the same real-world label
 * could visually appear as two different colors just from incidental
 * capitalization drift, defeating the "same label, same color" guarantee
 * this function exists to provide.
 */
export function labelColor(label: string): { background: string; color: string } {
  const normalized = label.trim().toLowerCase();
  const index = (fnv1aHash(normalized) % PALETTE_SIZE) + 1;
  return {
    background: `var(--label-bg-${index})`,
    color: `var(--label-fg-${index})`,
  };
}
