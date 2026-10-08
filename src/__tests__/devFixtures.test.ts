import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The fixture page shows sample cards with no account. It must be reachable
// only under `next dev`: in a production build the page is a 404 and the
// proxy sends a signed-out visitor to /login as for any other page.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

const signedOut = (path: string) => new NextRequest(new Request(`https://news.h72labs.com${path}`));

describe("dev fixture page", () => {
  it("is a 404 outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: DevFixturesPage } = await import("@/app/dev/fixtures/page");
    await expect(DevFixturesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is a 404 under plain next dev with the real keys loaded", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnop.supabase.co");
    const { default: DevFixturesPage } = await import("@/app/dev/fixtures/page");
    await expect(DevFixturesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sends a signed-out visitor to /login in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_dummy");
    const { proxy } = await import("@/proxy");
    const res = await proxy(signedOut("/dev/fixtures"));
    expect(new URL(res.headers.get("location") ?? "", "https://x").pathname).toBe("/login");
  });

  it("lets a signed-out visitor through under next dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_dummy");
    const { proxy } = await import("@/proxy");
    const res = await proxy(signedOut("/dev/fixtures"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps every other page behind sign-in under next dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_dummy");
    const { proxy } = await import("@/proxy");
    for (const path of ["/", "/dev/fixtures/other", "/dev", "/saved"]) {
      const res = await proxy(signedOut(path));
      expect(new URL(res.headers.get("location") ?? "", "https://x").pathname).toBe("/login");
    }
  });
});
