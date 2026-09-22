import { requestPasswordReset } from "@/app/auth/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { INPUT_CLASS, INPUT_STYLE, SUBMIT_CLASS, SUBMIT_STYLE } from "@/components/authStyles";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; expired?: string }>;
}) {
  const { sent, expired } = await searchParams;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Reset your password</h1>
        {sent ? (
          <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            If that address has an account, a reset link is on its way. The link works once and expires in an hour.
          </p>
        ) : (
          <>
            <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
              {expired
                ? "That reset link has expired or was already used. Ask for a new one."
                : "Type your email and we'll send you a link to set a new password."}
            </p>
            <form action={requestPasswordReset} className="flex flex-col gap-4">
              <input
                name="email"
                type="email"
                required
                placeholder="Email"
                className={INPUT_CLASS}
                style={INPUT_STYLE}
              />
              <SubmitButton pendingLabel="Sending…" className={SUBMIT_CLASS} style={SUBMIT_STYLE}>
                Send reset link
              </SubmitButton>
            </form>
          </>
        )}
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          <a href="/login" className="underline">
            Back to log in
          </a>
        </p>
      </main>
    </div>
  );
}
