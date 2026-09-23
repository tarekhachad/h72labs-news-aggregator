// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// TimeZoneSync's whole job is a side effect: on a mismatch between the
// device's zone and the stored one, write the device zone and refresh so the
// server re-renders against the new day. Its guard against looping lives in
// module-scope state (`lastAttempted`), not component state, specifically so
// a page that never gets a fresh read-back (e.g. because getUserTimeZone
// degraded to UTC on an error) doesn't write-and-refresh forever. That means
// this file has to get a genuinely fresh module per test — vi.resetModules()
// plus a dynamic import — or one test's write would poison the next.
//
// This needs a real React client render (not a server render, which never
// runs effects) to prove the mismatch/refresh/no-loop contract and React
// StrictMode's double-invoke behavior actually hold for the component as
// written, rather than for a hand description of it.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  syncTimeZone: vi.fn(),
  deviceTimeZone: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/app/(paper)/actions", () => ({
  syncTimeZone: mocks.syncTimeZone,
}));

vi.mock("@/lib/localDate", () => ({
  deviceTimeZone: mocks.deviceTimeZone,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

async function mount(el: React.ReactElement) {
  await act(async () => {
    root.render(el);
  });
}

async function freshTimeZoneSync() {
  const mod = await import("@/components/TimeZoneSync");
  return mod.TimeZoneSync;
}

describe("TimeZoneSync", () => {
  it("does not write or refresh when the device zone matches the stored one", async () => {
    mocks.deviceTimeZone.mockReturnValue("America/New_York");
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="America/New_York" />);

    expect(mocks.syncTimeZone).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does nothing when the device reports no zone", async () => {
    mocks.deviceTimeZone.mockReturnValue(null);
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);

    expect(mocks.syncTimeZone).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("writes the device zone and refreshes on a mismatch that succeeds", async () => {
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockResolvedValue({ ok: true });
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);

    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.syncTimeZone).toHaveBeenCalledWith("Africa/Casablanca");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the write fails", async () => {
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockResolvedValue({ ok: false });
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);

    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh when the write throws", async () => {
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockRejectedValue(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not attempt a second write for the same mismatch across remounts when the stored value never changes", async () => {
    // Simulates the exact scenario the module-scope guard exists for: a
    // write whose result never reads back as changed (e.g. getUserTimeZone
    // degrading to UTC on a persistent read error), across every page this
    // session visits (each one mounts its own TimeZoneSync).
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockResolvedValue({ ok: true });
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);

    // Unmount (as a real navigation would) and mount a brand new instance of
    // the SAME component with the SAME stale stored value -- module scope
    // persists across this because it is not reset by unmount, only by a
    // full module reload (e.g. a real page reload, which this test does not
    // do).
    await act(async () => {
      root.unmount();
    });
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(<TimeZoneSync storedTimeZone="UTC" />);
    });

    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
  });

  it("retries after the device reports a different zone than the last attempt", async () => {
    mocks.syncTimeZone.mockResolvedValue({ ok: true });
    const TimeZoneSync = await freshTimeZoneSync();

    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.syncTimeZone).toHaveBeenNthCalledWith(1, "Africa/Casablanca");

    // The device moves again (still travelling), and the stored value is
    // still stale from the caller's point of view within this same render
    // pass -- a genuinely new device zone must still be attempted.
    mocks.deviceTimeZone.mockReturnValue("Asia/Tokyo");
    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(2);
    expect(mocks.syncTimeZone).toHaveBeenNthCalledWith(2, "Asia/Tokyo");
  });

  it("under React StrictMode's double-invoked effect, writes only once", async () => {
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockResolvedValue({ ok: true });
    const TimeZoneSync = await freshTimeZoneSync();
    const { StrictMode } = await import("react");

    await mount(
      <StrictMode>
        <TimeZoneSync storedTimeZone="UTC" />
      </StrictMode>
    );

    // StrictMode (dev only) mounts, cleans up, and mounts again synchronously
    // to surface effects that aren't idempotent. There is no cleanup function
    // here (deliberately, per the component's own comment), so the guard
    // that actually has to hold is lastAttempted being set BEFORE the async
    // call -- if it were set only in the .then(), both invocations would race
    // past the check and double-write.
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  // The following three tests target the fix in ed02e10: `lastAttempted`
  // must be cleared after a FAILED write (rejected or `{ ok: false }`) so a
  // later page in the same tab retries, but ONLY when it still names the
  // zone that failed -- clearing unconditionally would also erase the guard
  // for a newer, still-in-flight or already-succeeded attempt.

  it("retries on a later page after a failed write reports the same stale zone again", async () => {
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockResolvedValueOnce({ ok: false });
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();

    // A later page in the same tab, same stale stored value, same device
    // zone -- this must be retried, not silently dropped forever.
    mocks.syncTimeZone.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      root.unmount();
    });
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(<TimeZoneSync storedTimeZone="UTC" />);
    });

    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("retries on a later page after a rejected write reports the same stale zone again", async () => {
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    mocks.syncTimeZone.mockRejectedValueOnce(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const TimeZoneSync = await freshTimeZoneSync();

    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();

    mocks.syncTimeZone.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      root.unmount();
    });
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(<TimeZoneSync storedTimeZone="UTC" />);
    });

    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("does not erase a newer attempt's guard when an older failed write resolves after it", async () => {
    // The race the conditional in `forget` exists for: the device moves
    // (Casablanca -> Tokyo) while Casablanca's write is still pending, so a
    // second write for Tokyo fires and becomes the current `lastAttempted`.
    // When Casablanca's write THEN resolves as a failure, it must not clear
    // Tokyo's still-in-flight guard -- otherwise a page reporting Tokyo again
    // before that write resolves would fire a duplicate write for it.
    const TimeZoneSync = await freshTimeZoneSync();

    let resolveFirst!: (value: { ok: boolean }) => void;
    const firstCall = new Promise<{ ok: boolean }>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.syncTimeZone.mockReturnValueOnce(firstCall);
    mocks.deviceTimeZone.mockReturnValue("Africa/Casablanca");
    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(1);

    let resolveSecond!: (value: { ok: boolean }) => void;
    const secondCall = new Promise<{ ok: boolean }>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.syncTimeZone.mockReturnValueOnce(secondCall);
    mocks.deviceTimeZone.mockReturnValue("Asia/Tokyo");
    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(2);

    // The FIRST (Casablanca) write now fails, well after Tokyo became the
    // current attempt.
    await act(async () => {
      resolveFirst({ ok: false });
      await firstCall.catch(() => {});
    });

    // A page mounts again still reporting Tokyo, whose write has not
    // resolved yet -- this must NOT fire a third write.
    mocks.deviceTimeZone.mockReturnValue("Asia/Tokyo");
    await mount(<TimeZoneSync storedTimeZone="UTC" />);
    expect(mocks.syncTimeZone).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond({ ok: true });
      await secondCall;
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
