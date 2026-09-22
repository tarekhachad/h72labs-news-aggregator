import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safeNext";

// Where every emailed link lands: signup confirmation and password recovery
// both point here, at {{ .SiteURL }}/auth/confirm?token_hash=…&type=…&next=…
//
// This is the token_hash flow, NOT the PKCE code flow that /auth/callback
// implements. PKCE stores a verifier cookie in the browser that started the
// flow, so a link opened on a different device than the one that signed up
// cannot be completed — which is the normal case for an emailed link.
const VERIFIABLE_TYPES: readonly string[] = ["email", "recovery"];

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNextPath(searchParams.get("next"));

  // Only the two types this app emails are accepted. Passing an arbitrary
  // caller-supplied type through to verifyOtp would widen this route to
  // every OTP flow Supabase supports, including ones nothing here sends.
  if (tokenHash && type && VERIFIABLE_TYPES.includes(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link_expired`);
}
