import { redirect } from "next/navigation";
import { resetPassword } from "@/app/auth/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { INPUT_CLASS, INPUT_STYLE, SUBMIT_CLASS, SUBMIT_STYLE } from "@/components/authStyles";
import { RESET_ERROR_MESSAGES, isResetErrorCode } from "@/lib/authErrors";
import { isRecoverySession } from "@/lib/recoverySession";
import { createClient } from "@/lib/supabase/server";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = isResetErrorCode(error) ? RESET_ERROR_MESSAGES[error] : null;

  // An ordinary logged-in session must not reach this form: saving here also
  // signs every other session out. Only a session the recovery link itself
  // established qualifies, which is what isRecoverySession reads out of the
  // signed token. The action re-checks it — this is the door, not the lock.
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!isRecoverySession(claims?.claims)) {
    redirect("/forgot-password?expired=1");
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Set a new password</h1>
        <form action={resetPassword} className="flex flex-col gap-4">
          <input
            name="password"
            type="password"
            required
            minLength={6}
            placeholder="New password"
            className={INPUT_CLASS}
            style={INPUT_STYLE}
          />
          {errorMessage && (
            <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
              {errorMessage}
            </p>
          )}
          <SubmitButton pendingLabel="Saving…" className={SUBMIT_CLASS} style={SUBMIT_STYLE}>
            Save password
          </SubmitButton>
        </form>
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Saving signs you out everywhere else.
        </p>
      </main>
    </div>
  );
}
