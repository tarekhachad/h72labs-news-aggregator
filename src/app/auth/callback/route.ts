import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Exchanges a confirmation-link code for a session. Only load-bearing if
// email confirmation is enabled in the Supabase dashboard (it's disabled
// for now, per docs/(C) ROADMAP.md's Phase 2 notes — dev/friends-testing
// stage doesn't need it) — built regardless since it's cheap and
// future-proofs the account for when email confirmation gets turned on
// before a public launch.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const requestedNext = searchParams.get("next") ?? "/";
  // Only allow same-origin relative paths — naive string concatenation of
  // an unvalidated `next` into a redirect target is an open-redirect risk
  // (e.g. "@evil.example/" turns "${origin}${next}" into a URL the parser
  // reads as pointing at evil.example). "//" is also rejected since browsers
  // treat a leading "//" as protocol-relative, i.e. an external origin.
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=Could not verify email`);
}
