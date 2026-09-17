import { signUp } from "@/app/auth/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { INVITE_TOKEN_PATTERN, SIGNUP_ERROR_MESSAGES, isSignupErrorCode } from "@/lib/invite";

const INPUT_CLASS = "rounded-xl border px-4 py-3 text-sm";
const INPUT_STYLE = {
  borderColor: "var(--color-border)",
  background: "var(--color-card)",
  color: "var(--color-card-foreground)",
} as const;

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invite?: string }>;
}) {
  const { error, invite } = await searchParams;
  // Only codes this app defines are rendered; anything else in the URL is ignored.
  const errorMessage = isSignupErrorCode(error) ? SIGNUP_ERROR_MESSAGES[error] : null;
  // Showing the form without a well-formed token would only lead to a rejection
  // after the user has typed everything. Validity (expired, spent) is not
  // checked here: that needs a database read open to anonymous visitors, and
  // the hook reports it on submit anyway.
  const hasInvite = typeof invite === "string" && INVITE_TOKEN_PATTERN.test(invite);

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Sign up</h1>
        {hasInvite ? (
          <form action={signUp} className="flex flex-col gap-4">
            <input type="hidden" name="invite" value={invite} />
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
              minLength={6}
              placeholder="Password"
              className={INPUT_CLASS}
              style={INPUT_STYLE}
            />
            {errorMessage && (
              <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
                {errorMessage}
              </p>
            )}
            <SubmitButton
              pendingLabel="Signing up…"
              className="cursor-pointer self-center rounded-full px-8 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
            >
              Sign up
            </SubmitButton>
          </form>
        ) : (
          <p className="text-center text-sm">
            {errorMessage ?? SIGNUP_ERROR_MESSAGES.invite_required}
          </p>
        )}
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Already have an account?{" "}
          <a href="/login" className="underline">
            Log in
          </a>
        </p>
      </main>
    </div>
  );
}
