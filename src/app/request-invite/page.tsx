import { connection } from "next/server";
import { RequestInviteForm } from "./RequestInviteForm";

export default async function RequestInvitePage() {
  // Rendered per request, so the key is read from the server's environment
  // at request time rather than frozen into a page built ahead of time, and
  // nothing is inlined into the browser bundle (see .env.example).
  await connection();
  const siteKey = process.env.TURNSTILE_SITE_KEY;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="font-heading text-center text-2xl font-semibold">Request an invite</h1>
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Sign-up is by invite while the app is tested with a small group. Tell me a little about yourself, and I&apos;ll
          read every request myself.
        </p>
        {siteKey ? (
          <RequestInviteForm siteKey={siteKey} />
        ) : (
          <p className="text-center text-sm">Requests aren&apos;t open right now. Try again later.</p>
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
