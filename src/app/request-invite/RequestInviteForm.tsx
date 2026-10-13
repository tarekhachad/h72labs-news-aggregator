"use client";

import { useActionState, useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { INPUT_CLASS, INPUT_STYLE, SUBMIT_CLASS, SUBMIT_STYLE } from "@/components/authStyles";
import { requestInvite } from "./actions";
import {
  REQUEST_ERROR_MESSAGES,
  REQUEST_LIMITS,
  type InviteRequestField,
  type RequestFormState,
} from "@/lib/inviteRequest";

const IDLE: RequestFormState = { status: "idle" };

const EMPTY: Record<InviteRequestField, string> = {
  name: "",
  email: "",
  referral: "",
  interests: "",
  note: "",
  link: "",
};

const LABEL_CLASS = "flex flex-col gap-1.5 text-sm";

export function RequestInviteForm({ siteKey }: { siteKey: string }) {
  const [state, formAction, pending] = useActionState(requestInvite, IDLE);
  // Controlled, so a refused submission keeps everything typed: React resets
  // uncontrolled fields after every form action.
  const [values, setValues] = useState(EMPTY);

  if (state.status === "sent") {
    return (
      <p role="status" className="text-center text-sm">
        Thanks, your request is in. If there&apos;s room, your invite will arrive by email.
      </p>
    );
  }

  const fieldErrors = state.status === "error" && !pending ? state.fieldErrors : {};
  const formError = state.status === "error" && !pending ? REQUEST_ERROR_MESSAGES[state.code] : null;

  function field(name: InviteRequestField, label: string, options: { type?: string; multiline?: boolean; required?: boolean; placeholder?: string } = {}) {
    const { type = "text", multiline = false, required = true, placeholder } = options;
    const error = fieldErrors[name];
    const errorId = `${name}-error`;
    const shared = {
      name,
      required,
      placeholder,
      maxLength: REQUEST_LIMITS[name],
      value: values[name],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setValues((v) => ({ ...v, [name]: e.target.value })),
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? errorId : undefined,
      className: INPUT_CLASS,
      style: INPUT_STYLE,
    };
    return (
      <label className={LABEL_CLASS}>
        <span>
          {label}
          {!required && <span style={{ color: "var(--color-muted-foreground)" }}> (optional)</span>}
        </span>
        {multiline ? <textarea rows={3} {...shared} /> : <input type={type} {...shared} />}
        {error && (
          <span id={errorId} className="text-xs" style={{ color: "var(--color-destructive)" }}>
            {error}
          </span>
        )}
      </label>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {field("name", "Name")}
      {field("email", "Email", { type: "email" })}
      {field("referral", "How did you hear about it, or who referred you?")}
      {field("interests", "What would you like to read about?", { multiline: true, placeholder: "Topics, countries, kinds of stories" })}
      {field("note", "Why would you like to try it?", { multiline: true })}
      {field("link", "LinkedIn or website", { type: "url", required: false, placeholder: "https://" })}
      <Turnstile siteKey={siteKey} resetKey={state} />
      {formError && (
        <p role="alert" className="text-sm" style={{ color: "var(--color-destructive)" }}>
          {formError}
        </p>
      )}
      <button type="submit" disabled={pending} className={SUBMIT_CLASS} style={SUBMIT_STYLE}>
        {pending ? "Sending…" : "Request an invite"}
      </button>
    </form>
  );
}
