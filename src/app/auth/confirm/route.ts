import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safeNext";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_OPTIONS,
  markerSubject,
  recoverySecret,
  sessionIdOfFreshToken,
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
    // Checked before verifyOtp, not after: verifying signs the user in and
    // spends the link, and a signed-in user sent to /login is bounced to /
    // by the proxy, so the message would never show and the link would be
    // gone. Refusing first leaves the link usable once the secret is fixed.
    const secret = recoverySecret();
    if (type === "recovery" && !secret) {
      console.error("[auth/confirm] RECOVERY_MARKER_SECRET is missing or too short; reset stays closed");
      return NextResponse.redirect(`${origin}/login?error=reset_unavailable`);
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) {
      // Auth exempts any session made by an emailed link from its "current
      // password" check, so the session a confirmation link creates could
      // change the password without knowing it. Only a reset needs that; a
      // confirmation ends the session at once and the user signs in with the
      // password they chose. Signing in lands on /, which sends a user with no
      // topics yet to /onboarding.
      if (type === "email") {
        try {
          const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
          if (signOutError) console.error("[auth/confirm] ending the confirmation session failed:", signOutError);
        } catch (err) {
          console.error("[auth/confirm] ending the confirmation session threw:", err);
        }
        return NextResponse.redirect(`${origin}/login?confirmed=1`);
      }

      // Only a verified recovery link earns the marker /reset-password asks
      // for. A signup confirmation lands here too and must not get one.
      if (type === "recovery" && secret) {
        const userId = data.user?.id;
        const sessionId = sessionIdOfFreshToken(data.session?.access_token);
        if (userId && sessionId) {
          const cookieStore = await cookies();
          cookieStore.set(
            RECOVERY_COOKIE,
            signRecoveryMarker(markerSubject(userId, sessionId), Math.floor(Date.now() / 1000), secret),
            RECOVERY_COOKIE_OPTIONS
          );
        }
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link_expired`);
}
