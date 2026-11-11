"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Students wait on the test page before it opens. When the open time
// arrives, re-render the page from the server so Start Test appears without
// a reload (D-20261110-1). The server decides: while it still says "not open
// yet" this stays mounted and asks again every few seconds.
export default function RefreshAtOpenTime({ openAt, serverNow }: { openAt: string; serverNow: number }) {
  const router = useRouter();
  useEffect(() => {
    // Server clock minus this device's clock, so a device whose clock is
    // off still refreshes when the server will let the test start.
    const skew = serverNow - Date.now();
    const openMs = Date.parse(openAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      clearTimeout(timer);
      const wait = openMs - (Date.now() + skew);
      if (wait > 0) {
        // setTimeout overflows past ~24.8 days; re-check at most hourly.
        timer = setTimeout(tick, Math.min(wait + 1000, 3_600_000));
        return;
      }
      router.refresh();
      timer = setTimeout(tick, 5000);
    };
    tick();
    // Background tabs get their timers throttled; catch up on return.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [openAt, serverNow, router]);
  return null;
}
