import { cookies } from "next/headers";
import { signIn } from "@/app/auth/actions";
import { CONFIRMED_EMAIL_COOKIE, confirmedEmailFromCookie } from "@/app/login/confirmedEmail";
import { PasswordInput } from "@/components/PasswordInput";
import { SubmitButton } from "@/components/SubmitButton";
import { INPUT_CLASS, INPUT_STYLE, SUBMIT_CLASS, SUBMIT_STYLE } from "@/components/authStyles";
import { LOGIN_ERROR_MESSAGES, isLoginErrorCode } from "@/lib/authErrors";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; confirmed?: string }>;
}) {
  const { error, confirmed } = await searchParams;
  // Only codes this app defines are rendered; anything else in the URL is ignored.
  const errorMessage = isLoginErrorCode(error) ? LOGIN_ERROR_MESSAGES[error] : null;
  const needsConfirmation = error === "email_not_confirmed" || error === "link_expired";
  const confirmedEmail = confirmedEmailFromCookie((await cookies()).get(CONFIRMED_EMAIL_COOKIE)?.value);

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Log in</h1>
        {confirmed === "1" && (
          <p role="status" className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            Your email is confirmed. Sign in with the password you just chose.
          </p>
        )}
        <form action={signIn} className="flex flex-col gap-4">
          <input
            name="email"
            type="email"
            required
            defaultValue={confirmedEmail ?? undefined}
            placeholder="Email"
            className={INPUT_CLASS}
            style={INPUT_STYLE}
          />
          <PasswordInput name="password" required placeholder="Password" />
          {errorMessage && (
            <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
              {errorMessage}
              {needsConfirmation && (
                <>
                  {" "}
                  <a href="/signup/check-email" className="underline">
                    Send it again
                  </a>
                </>
              )}
            </p>
          )}
          <SubmitButton pendingLabel="Logging in…" className={SUBMIT_CLASS} style={SUBMIT_STYLE}>
            Log in
          </SubmitButton>
        </form>
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          <a href="/forgot-password" className="underline">
            Forgot your password?
          </a>
        </p>
        {/* Signup is invite-only, so a link to /signup would only reach the refusal. */}
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Have an invite? Use the link in your invite email.
        </p>
      </main>
    </div>
  );
}
