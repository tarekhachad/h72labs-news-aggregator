import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { TOPICS } from "@/types";

// The front page tells FrontPage whether the reader has ever had an edition,
// from getLatestGeneratedAtForUser (non-null exactly when a run has
// completed). The page is an async server component, called as a function.

const mocks = vi.hoisted(() => ({
  getLatestGeneratedAtForUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
  })),
}));
vi.mock("@/lib/profile", () => ({
  getUserProfile: vi.fn(async () => ({ topics: TOPICS.slice(0, 2), preferredSources: [], timeZone: "UTC" })),
}));
vi.mock("@/lib/digests", () => ({
  getTodayDigest: vi.fn(async () => null),
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
}));
vi.mock("@/components/newspaper/FrontPage", () => ({ FrontPage: () => null }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { default: Home } = await import("@/app/(paper)/page");
const { FrontPage } = await import("@/components/newspaper/FrontPage");

function frontPageProps(tree: ReactNode): { firstEdition?: boolean } | undefined {
  const children = (tree as ReactElement<{ children: ReactNode[] }>).props.children;
  const element = (children as ReactElement[]).find((c) => c?.type === FrontPage) as
    | ReactElement<{ firstEdition?: boolean }>
    | undefined;
  return element?.props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("front page: first-edition flag", () => {
  it("is true when the reader has never had an edition", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
    expect(frontPageProps(await Home())?.firstEdition).toBe(true);
  });

  it("is false once any edition has completed", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-07T07:12:00Z");
    expect(frontPageProps(await Home())?.firstEdition).toBe(false);
  });

  it("is false, and the page still renders, when the lookup fails", async () => {
    mocks.getLatestGeneratedAtForUser.mockRejectedValue(new Error("db down"));
    expect(frontPageProps(await Home())?.firstEdition).toBe(false);
  });
});
