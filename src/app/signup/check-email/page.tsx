import { resendConfirmation } from "@/app/auth/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { INPUT_CLASS, INPUT_STYLE, SUBMIT_CLASS, SUBMIT_STYLE } from "@/components/authStyles";

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; sent?: string }>;
}) {
  const { email, sent } = await searchParams;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Check your email</h1>
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          We sent you a link to confirm your address. Open it and you&apos;ll be signed in and ready to pick your topics.
        </p>
        {sent && (
          <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            If that address has an account waiting to be confirmed, another link is on its way.
          </p>
        )}
        <form action={resendConfirmation} className="flex flex-col gap-4">
          <input
            name="email"
            type="email"
            required
            defaultValue={email ?? ""}
            placeholder="Email"
            className={INPUT_CLASS}
            style={INPUT_STYLE}
          />
          <SubmitButton pendingLabel="Sending…" className={SUBMIT_CLASS} style={SUBMIT_STYLE}>
            Send it again
          </SubmitButton>
        </form>
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Already confirmed?{" "}
          <a href="/login" className="underline">
            Log in
          </a>
        </p>
      </main>
    </div>
  );
}
