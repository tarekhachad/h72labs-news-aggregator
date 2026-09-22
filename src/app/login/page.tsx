import { signIn } from "@/app/auth/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { INPUT_CLASS, INPUT_STYLE, SUBMIT_CLASS, SUBMIT_STYLE } from "@/components/authStyles";
import { LOGIN_ERROR_MESSAGES, isLoginErrorCode } from "@/lib/authErrors";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  // Only codes this app defines are rendered; anything else in the URL is ignored.
  const errorMessage = isLoginErrorCode(error) ? LOGIN_ERROR_MESSAGES[error] : null;
  const needsConfirmation = error === "email_not_confirmed" || error === "link_expired";

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Log in</h1>
        <form action={signIn} className="flex flex-col gap-4">
          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            className={INPUT_CLASS}
            style={INPUT_STYLE}
          />
          <input
            name="password"
            type="password"
            required
            placeholder="Password"
            className={INPUT_CLASS}
            style={INPUT_STYLE}
          />
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
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Don&apos;t have an account?{" "}
          <a href="/signup" className="underline">
            Sign up
          </a>
        </p>
      </main>
    </div>
  );
}
