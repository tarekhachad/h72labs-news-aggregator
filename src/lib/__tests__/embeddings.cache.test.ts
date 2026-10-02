import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The loaded model is cached per server instance, and the cache is filled
// before the load settles. A load that fails must not stay cached, or one bad
// first attempt fails every later digest on that warm instance at clustering.
// Each test re-imports the module so it starts with an empty cache.

const mocks = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock("@xenova/transformers", () => ({
  env: { allowRemoteModels: true, allowLocalModels: true, useFSCache: true, localModelPath: "" },
  pipeline: mocks.pipeline,
}));
vi.mock("onnxruntime-node", () => ({ version: "test" }));

async function freshEmbed() {
  vi.resetModules();
  return (await import("@/lib/embeddings")).embed;
}

const fakeEmbedder = async (batch: string[]) => ({
  dims: [batch.length, 2],
  data: new Float32Array(batch.flatMap(() => [1, 0])),
});

beforeEach(() => {
  mocks.pipeline.mockReset();
  mocks.pipeline.mockResolvedValue(fakeEmbedder);
});

afterEach(() => {
  vi.doUnmock("onnxruntime-node");
  vi.restoreAllMocks();
});

describe("embed with a dead console", () => {
  it("still embeds, and keeps embedding, when the backend log line throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console is dead");
    });
    const embed = await freshEmbed();

    await expect(embed(["first"])).resolves.toEqual([[1, 0]]);
    await expect(embed(["second"])).resolves.toEqual([[1, 0]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("onnx backend=native"));
  });

  it("still embeds when the native runtime is missing and the fallback log line throws", async () => {
    vi.doMock("onnxruntime-node", () => {
      throw new Error("no native binding");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console is dead");
    });
    const embed = await freshEmbed();

    await expect(embed(["first"])).resolves.toEqual([[1, 0]]);
    await expect(embed(["second"])).resolves.toEqual([[1, 0]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("onnx backend=wasm fallback"));
  });
});

describe("the embedder cache", () => {
  it("retries a failed model load on the next call instead of caching the failure", async () => {
    mocks.pipeline.mockRejectedValueOnce(new Error("ENOENT model.onnx"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const embed = await freshEmbed();

    await expect(embed(["first"])).rejects.toThrow("ENOENT model.onnx");
    await expect(embed(["second"])).resolves.toEqual([[1, 0]]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  it("has already dropped the failed load by the time its caller sees the error", async () => {
    mocks.pipeline.mockRejectedValueOnce(new Error("ENOENT model.onnx"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const embed = await freshEmbed();

    // A retry straight from the first call's catch gets a fresh load.
    await expect(embed(["first"]).catch(() => embed(["retry"]))).resolves.toEqual([[1, 0]]);
  });

  it("gives every caller waiting on a failing load the same rejection", async () => {
    mocks.pipeline.mockRejectedValueOnce(new Error("ENOENT model.onnx"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const embed = await freshEmbed();

    const results = await Promise.allSettled([embed(["a"]), embed(["b"])]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });

  it("loads the model once and reuses it while the load keeps working", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const embed = await freshEmbed();

    await Promise.all([embed(["a"]), embed(["b"])]);
    await embed(["c"]);

    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });
});
