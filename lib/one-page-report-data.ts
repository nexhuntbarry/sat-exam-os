// Loads the one-page parent report (lib/one-page-report) for a viewer, with
// the same access rules as the /report page: admins → any student on their
// QA side; approved teachers → a student in one of their classes, limited to
// the subject(s) they teach that student. Students can't print it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getQaUserIds, onSide } from "@/lib/qa";
import { getTeacherSubjectsForStudent } from "@/lib/teacher-access";
import { getStudentProgressOccasions } from "@/lib/student-analytics";
import { PrintAccessError, type Viewer } from "@/lib/result-printout";
import { buildAssessments, MATH, RW, type Assessment, type ReportSection } from "@/lib/one-page-report";

export interface OnePageReportData {
  studentId: string;
  studentName: string;
  /** Sections shown (a teacher of one subject: that one). */
  sections: ReportSection[];
  assessments: Assessment[];
}

/** Throws PrintAccessError (403/404) when the viewer may not see this student. */
export async function loadOnePageReport(db: SupabaseClient, viewer: Viewer, studentId: string): Promise<OnePageReportData> {
  let subjects: string[] | null = null;
  if (viewer.role === "teacher") {
    const scope = await getTeacherSubjectsForStudent(db, viewer.userId, studentId);
    if (!scope.teaches) throw new PrintAccessError(403, "Not your student");
    subjects = scope.subjects;
  } else if (viewer.role !== "admin") {
    throw new PrintAccessError(403, "Not allowed");
  }
  // QA isolation: never show a student from the other side.
  if (!onSide(studentId, await getQaUserIds(), viewer.isQa)) throw new PrintAccessError(404, "Not found");

  const { data: student } = await db.from("users").select("display_name, email, role").eq("id", studentId).maybeSingle();
  if (!student || student.role !== "student") throw new PrintAccessError(404, "Not found");

  const sections = ([RW, MATH] as ReportSection[]).filter((s) => subjects === null || subjects.includes(s));
  const occasions = await getStudentProgressOccasions(studentId);
  return {
    studentId,
    studentName: (student.display_name as string | null) || (student.email as string) || "Student",
    sections,
    assessments: buildAssessments(occasions, sections),
  };
}
