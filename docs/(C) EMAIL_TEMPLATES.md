# Email templates

The copy Supabase sends for signup confirmation and password recovery. Supabase stores these in the dashboard (Authentication → Emails → Templates), which is outside version control, so the canonical text lives here and is pasted there. Changing one means changing both.

These are **external-facing text**: the confirmation email is the first thing an invitee ever sees from H72 Labs, so the vault root's *Writing Style — External-Facing Content* rules apply. Run `external-writing-check` before changing a word of them.

The provider (Resend, chosen 2026-09-22) is not referenced anywhere in the templates or the app. A provider switch changes SMTP credentials in the Supabase dashboard and DNS records, and leaves this file untouched.

## The link

Both templates point at `/auth/confirm`, the `token_hash` route in `src/app/auth/confirm/route.ts` — never at `{{ .ConfirmationURL }}`, which uses the PKCE flow and fails when the link is opened on a different device than the one that started it. An invitee signing up on a laptop and opening the email on a phone is the normal case, not an edge case.

`type` must be `email` or `recovery`; the route rejects anything else. `next` must be a same-origin path.

## Confirm signup

Subject:

```text
Confirm your email to finish signing up
```

Body:

```html
<p>You created an account on H72 Labs News, a daily news digest that takes each story from several sources and writes it up as one card.</p>

<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/onboarding">Confirm my email</a></p>

<p>The link works once and expires in an hour. After that you can ask for a new one from the login page.</p>

<p>If you didn't sign up, ignore this email. No account is active until the link is used.</p>
```

## Reset password

Subject:

```text
Reset your H72 Labs News password
```

Body:

```html
<p>Someone asked to reset the password for {{ .Email }} on H72 Labs News.</p>

<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password">Set a new password</a></p>

<p>The link works once and expires in an hour. Saving a new password also signs you out on every other device.</p>

<p>If this wasn't you, ignore this email and your password stays as it is.</p>
```

## The hour

Both templates tell the reader the link lasts an hour. That number is a dashboard setting (Authentication → Emails → Email OTP Expiration), not something the code controls, so changing the setting means changing this copy in the same sitting. A link that dies before the email says it will is the kind of thing a tester reports as "the app is broken".
