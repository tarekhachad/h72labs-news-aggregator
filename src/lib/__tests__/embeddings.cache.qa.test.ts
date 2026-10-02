import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA gap tests for the embedder cache: concurrent callers around a failed
// load, a retry load shared by concurrent callers, no unhandled rejections,
// and the import-failure diagnostic with an error that throws when read.

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), importError: null as unknown }));
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function watchUnhandled(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

beforeEach(() => {
  mocks.pipeline.mockReset();
  mocks.pipeline.mockResolvedValue(fakeEmbedder);
});

afterEach(() => {
  vi.doUnmock("onnxruntime-node");
  vi.restoreAllMocks();
});

describe("concurrent callers around a failed load", () => {
  it("callers that joined the failed load all reject; the next call after them retries and succeeds", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const firstLoad = deferred<typeof fakeEmbedder>();
    mocks.pipeline.mockReturnValueOnce(firstLoad.promise);
    const embed = await freshEmbed();

    const joined = [embed(["a"]), embed(["b"]), embed(["c"])];
    // Let reportBackend's dynamic import settle so pipeline() is reached.
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(1));
    firstLoad.reject(new Error("ENOENT model.onnx"));
    const settled = await Promise.allSettled(joined);

    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    await expect(embed(["d"])).resolves.toEqual([[1, 0]]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers arriving during the retry load share it rather than starting a third", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.pipeline.mockRejectedValueOnce(new Error("ENOENT model.onnx"));
    const retryLoad = deferred<typeof fakeEmbedder>();
    mocks.pipeline.mockReturnValueOnce(retryLoad.promise);
    const embed = await freshEmbed();

    await expect(embed(["first"])).rejects.toThrow("ENOENT");
    const during = [embed(["x"]), embed(["y"])];
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(2));
    retryLoad.resolve(fakeEmbedder);

    await expect(Promise.all(during)).resolves.toEqual([[[1, 0]], [[1, 0]]]);
    await embed(["z"]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  it("keeps failing loads retryable: two failures in a row, then success", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.pipeline
      .mockRejectedValueOnce(new Error("load 1"))
      .mockRejectedValueOnce(new Error("load 2"));
    const embed = await freshEmbed();

    await expect(embed(["a"])).rejects.toThrow("load 1");
    await expect(embed(["b"])).rejects.toThrow("load 2");
    await expect(embed(["c"])).resolves.toEqual([[1, 0]]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(3);
  });

  it("raises no unhandled rejection when a load fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.pipeline.mockRejectedValueOnce(new Error("ENOENT model.onnx"));
    const embed = await freshEmbed();

    const unhandled = await watchUnhandled(async () => {
      await Promise.allSettled([embed(["a"]), embed(["b"])]);
    });

    expect(unhandled).toEqual([]);
  });

  it("does not drop a working cached load when a later embed call fails inside the model run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    mocks.pipeline.mockResolvedValue(async (batch: string[]) => {
      calls += 1;
      if (calls === 2) throw new Error("inference blew up");
      return fakeEmbedder(batch);
    });
    const embed = await freshEmbed();

    await embed(["a"]);
    await expect(embed(["b"])).rejects.toThrow("inference blew up");
    await embed(["c"]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });
});

describe("the import-failure diagnostic", () => {
  // A throwing mock factory's error is wrapped by vitest before it reaches the
  // code, so the hostile value is thrown from the module's `version` getter
  // instead, which reportBackend reads inside the same try as the import.
  function mockHostileVersion(hostile: unknown) {
    vi.doMock("onnxruntime-node", () => ({
      get version(): string {
        throw hostile;
      },
    }));
  }

  it("still loads the model, and reports the fallback, when the error's message getter throws", async () => {
    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("message getter blew up");
      },
    });
    mockHostileVersion(hostile);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const embed = await freshEmbed();

    await expect(embed(["first"])).resolves.toEqual([[1, 0]]);
    expect(log).toHaveBeenCalledWith(
      "[mem] onnx backend=wasm fallback — onnxruntime-node did not load: unknown error",
    );
  });

  it("still loads the model when `instanceof Error` itself throws on the thrown value", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap blew up");
        },
      },
    );
    mockHostileVersion(hostile);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const embed = await freshEmbed();

    await expect(embed(["first"])).resolves.toEqual([[1, 0]]);
    expect(log).toHaveBeenCalledWith(
      "[mem] onnx backend=wasm fallback — onnxruntime-node did not load: unknown error",
    );
  });
});
