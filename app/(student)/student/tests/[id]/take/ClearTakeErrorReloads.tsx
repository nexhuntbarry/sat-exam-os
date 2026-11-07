"use client";

import { useEffect } from "react";
import { clearTakeErrorReloads } from "@/lib/take-error-reloads";

// The take page loaded: reset the error screen's reload counter.
export default function ClearTakeErrorReloads({ testId }: { testId: string }) {
  useEffect(() => clearTakeErrorReloads(testId), [testId]);
  return null;
}
