"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  FIELD_HINT_CLASS,
  FIELD_HINT_STYLE,
  INPUT_CLASS,
  INPUT_STYLE,
  NEW_PASSWORD_RULE,
  PASSWORD_TOGGLE_CLASS,
  PASSWORD_TOGGLE_STYLE,
} from "@/components/authStyles";

/**
 * A password field with a show/hide button. The input's own attributes are
 * passed through untouched, so password managers and the server actions see
 * exactly the field they saw before the button existed.
 *
 * The button's name changes with what it will do ("Show password" / "Hide
 * password") instead of carrying `aria-pressed`: a toggle whose label also
 * flips would be announced as "Hide password, pressed", a double negative.
 */
export function PasswordInput({
  name,
  placeholder,
  autoComplete,
  required,
  minLength,
  showRule = false,
  className = INPUT_CLASS,
  style = INPUT_STYLE,
}: {
  name: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  /** Shows the minimum-length rule under the field, for fields that set a new password. */
  showRule?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const ruleId = useId();

  // Back to dots once the form is sent, so the password isn't left on screen
  // while the action runs or after the page comes back.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const hide = () => setVisible(false);
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type={visible ? "text" : "password"}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-describedby={showRule ? ruleId : undefined}
          className={cn(className, "w-full pr-16")}
          style={style}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-controls={inputId}
          className={PASSWORD_TOGGLE_CLASS}
          style={PASSWORD_TOGGLE_STYLE}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {showRule && (
        <p id={ruleId} className={FIELD_HINT_CLASS} style={FIELD_HINT_STYLE}>
          {NEW_PASSWORD_RULE}
        </p>
      )}
    </div>
  );
}
