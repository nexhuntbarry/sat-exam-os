import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { listPrintableAttempts, loadResultPrintouts, PrintAccessError } from "@/lib/result-printout";

// GET /api/print/results/<testId>/summary?subs=<id,…>  → CSV (UTF-8 with BOM, opens in Excel)
// Student, class, SAT score, Module 1 and Module 2 correct counts, date —
// the same score display as the results screens. A full-length SAT gets
// Total, R&W and Math with each section's module counts. Teachers/admins only.
export async function GET(req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "teacher" && user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (user.role === "teacher" && user.accountStatus !== "approved") return NextResponse.json({ error: "Account not active" }, { status: 403 });
  const { testId } = await params;
  const viewer = { userId: user.userId, role: user.role, isQa: user.isQa };
  const db = getServiceClient();
  try {
    let subs = (new URL(req.url).searchParams.get("subs") ?? "").split(",").filter(Boolean);
    if (subs.length === 0) subs = (await listPrintableAttempts(db, viewer, testId)).map((a) => a.submissionId);
    const rows = subs.length
      ? await loadResultPrintouts(db, viewer, testId, subs, { mode: "full", explanations: false, explanationsAt: "inline", summaryOnly: true })
      : [];
    const cell = (v: string | number | null | undefined) => {
      let s = v == null ? "" : String(v);
      // Spreadsheet formula injection: a student-chosen name like =HYPERLINK(...)
      if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const mod = (r: (typeof rows)[number], n: number) => {
      const m = r.attempt.modules.find((x) => x.number === n);
      return m ? (m.graded ? `${m.correct ?? 0}/${m.total ?? 0}` : "—") : "";
    };
    const date = (r: (typeof rows)[number]) =>
      r.takenAt ? new Date(r.takenAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "";
    // Full-length SAT: the same top-level columns as the results CSV
    // (a single-subject teacher gets the total plus their own section).
    const fl = rows.find((r) => r.fullLength)?.fullLength;
    const flMod = (a: NonNullable<(typeof rows)[number]["fullLength"]>["rw"], n: number) => {
      const m = a.modules.find((x) => x.number === n);
      return m ? (m.graded ? `${m.correct ?? 0}/${m.total ?? 0}` : "—") : "";
    };
    const lines = (fl ? [
      [
        "Student", "Class", "Test", "Total (400–1600)",
        ...(fl.scope.rw ? ["R&W (200–800)", "R&W M1", "R&W M2"] : []),
        ...(fl.scope.math ? ["Math (200–800)", "Math M1", "Math M2"] : []),
        "Status", "Date",
      ],
      ...rows.map((r) => {
        const f = r.fullLength!;
        return [
          r.studentName,
          r.className,
          r.testName,
          f.total ?? "",
          ...(fl.scope.rw ? [f.rw.score?.sat ?? "", flMod(f.rw, 1), flMod(f.rw, 2)] : []),
          ...(fl.scope.math ? [f.math.score?.sat ?? "", flMod(f.math, 1), flMod(f.math, 2)] : []),
          f.status,
          date(r),
        ];
      }),
    ] : [
      ["Student", "Class", "Test", "SAT score", "Module 1", "Module 2", "Status", "Date"],
      ...rows.map((r) => [
        r.studentName,
        r.className,
        r.testName,
        r.attempt.score?.sat ?? "",
        mod(r, 1),
        mod(r, 2),
        r.attempt.status,
        r.takenAt ? new Date(r.takenAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "",
      ]),
    ]).map((row) => row.map(cell).join(","));
    const testName = rows[0]?.testName ?? "results";
    const file = `${testName} – score summary.csv`;
    return new Response("﻿" + lines.join("\r\n") + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="score-summary.csv"; filename*=UTF-8''${encodeURIComponent(file)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof PrintAccessError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
