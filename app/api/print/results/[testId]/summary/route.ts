import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { listPrintableAttempts, loadResultPrintouts, PrintAccessError } from "@/lib/result-printout";

// GET /api/print/results/<testId>/summary?subs=<id,…>  → CSV (UTF-8 with BOM, opens in Excel)
// Student, class, SAT score, Module 1 and Module 2 correct counts, date —
// the same score display as the results screens. Teachers/admins only.
export async function GET(req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "teacher" && user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    const lines = [
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
    ].map((row) => row.map(cell).join(","));
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
