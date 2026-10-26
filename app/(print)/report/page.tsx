import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, onSide } from "@/lib/qa";
import { formatDate } from "@/lib/datetime";
import PrintableReport from "@/components/analytics/PrintableReport";
import { getStudentBreakdownRows, getStudentProgressOccasions } from "@/lib/student-analytics";
import { getTeacherSubjectsForStudent, inSubjects } from "@/lib/teacher-access";

export const dynamic = "force-dynamic";

// GET /report?student=<id>
// Student → their own report. Teacher/admin → any student they may view
// (teacher: a student in one of their classes; admin: anyone).
export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ student?: string }>;
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/sign-in");
  const sp = await searchParams;
  const db = getServiceClient();

  let studentId = me.userId;
  // Teacher → only the subject(s) they teach this student (null = all).
  let subjects: string[] | null = null;
  if (me.role === "admin" && sp.student) {
    studentId = sp.student;
  } else if (me.role === "teacher" && sp.student) {
    // Teacher may only print a student who shares one of their classes.
    const scope = await getTeacherSubjectsForStudent(db, me.userId, sp.student);
    if (!scope.teaches) redirect("/teacher");
    studentId = sp.student;
    subjects = scope.subjects;
  } else if (me.role !== "student" && !sp.student) {
    // teacher/admin with no target → nothing to show
    redirect(me.role === "admin" ? "/admin" : "/teacher");
  }

  // QA isolation: never render a student from the other side.
  if (!onSide(studentId, await getQaUserIds(), me.isQa)) {
    redirect(me.role === "admin" ? "/admin" : me.role === "teacher" ? "/teacher" : "/student");
  }

  const { data: student } = await db.from("users").select("display_name, email").eq("id", studentId).maybeSingle();
  const [allBreakdownRows, allOccasions] = await Promise.all([
    getStudentBreakdownRows(studentId),
    getStudentProgressOccasions(studentId),
  ]);
  const breakdownRows = allBreakdownRows.filter((r) => inSubjects(r.section, subjects));
  const occasions = allOccasions
    .map((o) => ({ ...o, rows: o.rows.filter((r) => inSubjects(r.section, subjects)) }))
    .filter((o) => o.rows.length > 0 && inSubjects(o.section, subjects));

  if (breakdownRows.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center text-soft-mute">
        No completed tests yet — a report will appear once this student has submitted a test.
      </div>
    );
  }

  return (
    <PrintableReport
      studentName={student?.display_name ?? student?.email ?? "Student"}
      breakdownRows={breakdownRows}
      occasions={occasions}
      generatedOn={formatDate(new Date().toISOString())}
    />
  );
}
