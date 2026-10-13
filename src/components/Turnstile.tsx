"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";

type TurnstileApi = {
  render(container: HTMLElement, options: { sitekey: string; theme?: "auto" | "light" | "dark" }): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Cloudflare's bot check. The widget adds a hidden `cf-turnstile-response`
 * input to the form it sits in, which the server verifies.
 *
 * A token is single-use, so the widget must issue a fresh one after every
 * submission, refused or not: change `resetKey` to do that.
 */
export function Turnstile({ siteKey, resetKey }: { siteKey: string; resetKey: unknown }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const api = window.turnstile;
    if (!ready || !api || !container.current) return;
    const id = api.render(container.current, { sitekey: siteKey, theme: "auto" });
    widgetId.current = id;
    return () => {
      api.remove(id);
      widgetId.current = null;
    };
  }, [ready, siteKey]);

  useEffect(() => {
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  return (
    <>
      {/* onReady, not onLoad: it also fires when the script was already loaded by an earlier visit to the page. */}
      <Script src={SCRIPT_URL} strategy="afterInteractive" onReady={() => setReady(true)} />
      <div ref={container} className="flex min-h-[65px] justify-center" />
    </>
  );
}
