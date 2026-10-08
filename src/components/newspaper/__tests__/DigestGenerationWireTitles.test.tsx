// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DigestGenerationProvider,
  useDigestGeneration,
} from "@/components/newspaper/DigestGenerationContext";
import { stubDigestFetch, makeCard, type ScriptedStream } from "./editionTestKit";

// The run's gathered titles arrive once, on the `clustering` event, and must
// outlive the later events that replace `stageEvent`, so the loaders can keep
// showing them for the whole run.

type Ctx = ReturnType<typeof useDigestGeneration>;
const latest: { ctx: Ctx | null } = { ctx: null };
function Probe() {
  const value = useDigestGeneration();
  useEffect(() => {
    latest.ctx = value;
  });
  return null;
}
const ctx = new Proxy({} as Ctx, { get: (_t, key) => latest.ctx![key as keyof Ctx] });

let container: HTMLDivElement;
let root: Root;
let streams: ScriptedStream[];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  ({ streams } = stubDigestFetch());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <DigestGenerationProvider>
        <Probe />
      </DigestGenerationProvider>
    );
  });
  await act(async () => ctx.seed([], "2026-10-08"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start() {
  await act(async () => ctx.startGeneration());
  await flush();
}

describe("DigestGenerationContext: wireTitles", () => {
  it("is empty before any run", () => {
    expect(ctx.wireTitles).toEqual([]);
  });

  it("takes the clustering event's titles and keeps them through later stages", async () => {
    await start();
    streams[0].send({ stage: "ingesting" });
    await flush();
    expect(ctx.wireTitles).toEqual([]);

    streams[0].send({ stage: "clustering", articleCount: 2, sampleTitles: ["One", "Two"] });
    await flush();
    expect(ctx.wireTitles).toEqual(["One", "Two"]);

    streams[0].send({ stage: "triaging", clusterCount: 2 });
    streams[0].send({ stage: "writing", notableCount: 1 });
    streams[0].send({ stage: "ranking" });
    await flush();
    expect(ctx.stageEvent?.stage).toBe("ranking");
    expect(ctx.wireTitles).toEqual(["One", "Two"]);
  });

  it("clears when the run ends", async () => {
    await start();
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["One"] });
    streams[0].send({ stage: "done", cards: [makeCard("c1")], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(ctx.loading).toBe(false);
    expect(ctx.wireTitles).toEqual([]);
  });

  it("clears when a new run starts", async () => {
    await start();
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Old"] });
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    expect(ctx.error).toBe("boom");

    await start();
    expect(ctx.wireTitles).toEqual([]);
    streams[1].send({ stage: "clustering", articleCount: 1, sampleTitles: ["New"] });
    await flush();
    expect(ctx.wireTitles).toEqual(["New"]);
  });

  it("clears on a date change, and a stale run's titles never land", async () => {
    await start();
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Yesterday"] });
    await flush();
    expect(ctx.wireTitles).toEqual(["Yesterday"]);

    await act(async () => ctx.seed([], "2026-10-09"));
    expect(ctx.wireTitles).toEqual([]);

    // The old run carries on server-side and sends more; none of it is today's.
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Stale"] });
    streams[0].send({ stage: "triaging", clusterCount: 1 });
    await flush();
    expect(ctx.wireTitles).toEqual([]);
    expect(ctx.stageEvent).toBeNull();
  });

  it("reads a missing or malformed sampleTitles as no titles", async () => {
    await start();
    streams[0].send({ stage: "clustering", articleCount: 3 });
    await flush();
    expect(ctx.wireTitles).toEqual([]);

    streams[0].send({ stage: "clustering", articleCount: 3, sampleTitles: "not a list" });
    await flush();
    expect(ctx.wireTitles).toEqual([]);

    streams[0].send({ stage: "clustering", articleCount: 3, sampleTitles: ["Kept", 7, null, { a: 1 }, "  "] });
    await flush();
    expect(ctx.wireTitles).toEqual(["Kept"]);
  });
});
