"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { syncTimeZone } from "@/app/(paper)/actions";
import { deviceTimeZone } from "@/lib/localDate";

// The zone last sent from this tab. Module scope, not a ref, because each
// page mounts its own TimeZoneSync: a ref would reset on every navigation,
// and if the stored value ever failed to read back (getUserTimeZone degrades
// to UTC on an error) each page would write and refresh again, forever.
let lastAttempted: string | null = null;

/**
 * Keeps the stored timezone equal to the device's. The stored value is what
 * the server uses to decide which calendar day is "today", so when a reader's
 * device moves to another zone, their today moves with it.
 *
 * Renders nothing. On a mismatch it writes the device zone and refreshes, so
 * the server-rendered page is recomputed against the new day.
 */
export function TimeZoneSync({ storedTimeZone }: { storedTimeZone: string }) {
  const router = useRouter();

  useEffect(() => {
    const device = deviceTimeZone();
    if (device === null || device === storedTimeZone || device === lastAttempted) return;
    lastAttempted = device;

    // No cleanup cancelling the refresh: under React's development double
    // mount the first effect's cleanup would cancel it and the second would
    // return early on lastAttempted, so the refresh would never run. A
    // refresh after navigating away is harmless.
    //
    // Cleared on failure so the next page retries; kept on success, which is
    // what stops a write-refresh loop if the value then fails to read back.
    const forget = () => {
      if (lastAttempted === device) lastAttempted = null;
    };
    syncTimeZone(device)
      .then(({ ok }) => {
        if (ok) router.refresh();
        else forget();
      })
      .catch((err) => {
        forget();
        console.error("[TimeZoneSync] failed to store time zone:", err);
      });
  }, [storedTimeZone, router]);

  return null;
}
