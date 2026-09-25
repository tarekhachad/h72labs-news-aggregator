import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safeNext";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_OPTIONS,
  recoverySecret,
  signRecoveryMarker,
} from "@/lib/recoveryMarker";

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
    const { data, error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) {
      // Only a verified recovery link earns the marker /reset-password asks
      // for. A signup confirmation lands here too and must not get one.
      const secret = recoverySecret();
      const userId = data.user?.id;
      if (type === "recovery" && userId) {
        if (secret) {
          const cookieStore = await cookies();
          cookieStore.set(
            RECOVERY_COOKIE,
            signRecoveryMarker(userId, Math.floor(Date.now() / 1000), secret),
            RECOVERY_COOKIE_OPTIONS
          );
        } else {
          console.error("[auth/confirm] RECOVERY_MARKER_SECRET is missing or too short; reset stays closed");
        }
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link_expired`);
}
