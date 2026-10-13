# Email templates

The copy Supabase sends for signup confirmation and password recovery. Supabase stores these in the dashboard (Authentication → Emails → Templates), which is outside version control, so the canonical text lives here and is pasted there. Changing one means changing both.

These are **external-facing text**: the confirmation email is the first thing an invitee ever sees from H72 Labs, so the vault root's *Writing Style — External-Facing Content* rules apply. Run `external-writing-check` before changing a word of them.

**Sender**, set in the dashboard (Authentication → Emails → SMTP Settings): name `Your Daily Brief by H72 Labs`, address `no-reply@h72labs.com`. It matches the app's own sender, `EMAIL_FROM` in `src/lib/email.ts`, so every email a reader gets comes from the same name. Keep the name plain ASCII: a character like `·` needs header encoding that not every sending path applies.

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
<p>You created an account on Your Daily Brief, H72 Labs' daily news digest that takes each story from several sources and writes it up as one card.</p>

<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/onboarding">Confirm my email</a></p>

<p>The link works once and expires in an hour. After that you can ask for a new one from the login page.</p>

<p>If you didn't sign up, ignore this email. No account is active until the link is used.</p>
```

## Reset password

Subject:

```text
Reset your password for Your Daily Brief
```

Body:

```html
<p>Someone asked to reset the password for {{ .Email }} on Your Daily Brief.</p>

<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password">Set a new password</a></p>

<p>The link works once and expires in an hour.</p>

<p>If this wasn't you, ignore this email and your password stays as it is.</p>
```

## Invite requests

These three are not Supabase's: the app sends them through Resend's HTTP API, as plain text, from `Your Daily Brief by H72 Labs <no-reply@h72labs.com>`. The product's name comes from `PRODUCT_NAME` in `src/config/brand.ts`. The canonical text is in code, `src/lib/inviteEmails.ts`, because each one is built per send; this section is the readable copy. Change both together. `{name}`, `{link}` and `{to}` are filled in at send time.

**Invite (on approve).** Subject: `Your Daily Brief: your invite`.

```text
Hi {name},

Thanks for asking to try Your Daily Brief. Here's your invite link:

{link}

It works once, for {to}, and expires in 7 days. After you sign up, you pick the topics and countries you want to follow, and the app writes the day's stories on them as short cards, each one drawn from several outlets' reporting.

Tarek
H72 Labs
```

**Decline (only when the box is ticked).** Subject: `Your Daily Brief: your request`. It carries none of the requester's words, not even the name: anyone can put a stranger's address on a request.

```text
Hi,

Thanks for asking to try Your Daily Brief. It's a small invite-only test for now, and I can't add more readers at this stage. You're welcome to ask again later.

Tarek
H72 Labs
```

**New request (to Tarek, internal).** Lists the request's fields and links to `/admin/requests`. Not external-facing.

## The hour

Both templates tell the reader the link lasts an hour. That number is a dashboard setting (Authentication → Emails → Email OTP Expiration), not something the code controls, so changing the setting means changing this copy in the same sitting. A link that dies before the email says it will is the kind of thing a tester reports as "the app is broken".
