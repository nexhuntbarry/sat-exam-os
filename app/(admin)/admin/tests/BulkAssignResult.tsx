"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { BulkAssignResult, BulkAssignTestResult } from "@/lib/test-assign";

export type { BulkAssignResult, BulkAssignTestResult };

/** POST /api/admin/tests/bulk-assign; throws the server's message on failure. */
export async function postBulkAssign(body: {
  testIds: string[];
  studentIds?: string[];
  classGroupIds?: string[];
  teacherIds?: string[];
  publishAt?: string | null;
}): Promise<BulkAssignResult> {
  let res: Response;
  try {
    res = await fetch("/api/admin/tests/bulk-assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Network error");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? `Failed (HTTP ${res.status})`);
  return j as BulkAssignResult;
}

/** The one-line summary, then only the tests that need a look. */
export default function BulkAssignResultView({ result }: { result: BulkAssignResult }) {
  const issues = result.results.filter((r) => r.error || r.notReady);
  return (
    <div className="space-y-2" role="status">
      <p className="flex items-start gap-2 text-sm text-charcoal">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-status-success" />
        <span>{result.summary}</span>
      </p>
      {issues.length > 0 && (
        <ul className="space-y-1 text-xs">
          {issues.map((r) => (
            <li key={r.testId} className={r.outcome === "assigned" && !r.error ? "text-status-warning" : "text-status-error"}>
              <span className="inline-flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">{r.name}</span>: {r.error ?? `scheduled, but not ready yet — ${r.notReady} It won't publish until that's fixed.`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
