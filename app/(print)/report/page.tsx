import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { formatDate } from "@/lib/datetime";
import PrintableReport from "@/components/analytics/PrintableReport";
import { getStudentBreakdownRows, getStudentProgressOccasions } from "@/lib/student-analytics";

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
  if (me.role === "admin" && sp.student) {
    studentId = sp.student;
  } else if (me.role === "teacher" && sp.student) {
    // Teacher may only print a student who shares one of their classes.
    const { data: myClasses } = await db.from("class_group_teachers").select("class_group_id").eq("teacher_id", me.userId);
    const ids = (myClasses ?? []).map((c) => c.class_group_id);
    if (ids.length) {
      const { data: member } = await db
        .from("class_group_members")
        .select("id")
        .eq("student_id", sp.student)
        .in("class_group_id", ids)
        .maybeSingle();
      if (member) studentId = sp.student;
      else redirect("/teacher");
    } else redirect("/teacher");
  } else if (me.role !== "student" && !sp.student) {
    // teacher/admin with no target → nothing to show
    redirect(me.role === "admin" ? "/admin" : "/teacher");
  }

  const { data: student } = await db.from("users").select("display_name, email").eq("id", studentId).maybeSingle();
  const [breakdownRows, occasions] = await Promise.all([
    getStudentBreakdownRows(studentId),
    getStudentProgressOccasions(studentId),
  ]);

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
