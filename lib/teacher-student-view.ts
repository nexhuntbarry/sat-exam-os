// What a TEACHER may see about a student: name, grade and the classes the
// teacher teaches. Never email, school, campus, parent contact, phone or
// notes (support ticket: teacher-side student privacy). Teacher pages, API
// routes and shared loaders called for a teacher select only these columns
// and label students with teacherStudentLabel, so no contact field is
// fetched, serialized to a client component or exported.
// Pure module (no server imports): unit-tested in .omc/qa/unit.

/** users columns a teacher query may select. */
export const TEACHER_STUDENT_SELECT = "id, display_name";
/** The same, as an embedded join (`users!inner(${TEACHER_STUDENT_EMBED})`). */
export const TEACHER_STUDENT_EMBED = "display_name";
/** student_profiles columns a teacher query may select. */
export const TEACHER_STUDENT_PROFILE_SELECT = "grade";

/** English fallback; pages pass the translated common.unnamedStudent. */
export const UNNAMED_STUDENT = "Unnamed student";

/**
 * A student's name for the teacher side: the display name, or "Unnamed
 * student" when there is none. Never the email or an email prefix, even
 * when the passed object happens to carry one.
 */
export function teacherStudentLabel(
  profile: { display_name?: string | null } | null | undefined,
  unnamed: string = UNNAMED_STUDENT,
): string {
  const name = profile?.display_name?.trim();
  return name ? name : unnamed;
}

/** Teacher search: matches the student's name only, never email. */
export function teacherNameMatches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

/** The teacher results CSV's student columns, exactly these three. */
export const TEACHER_CSV_STUDENT_COLUMNS = ["Student", "Grade", "Class"] as const;

/** Header of the teacher section-test results CSV (api/teacher/tests/[id]/export). */
export function sectionCsvHeader(twoModules: boolean, questionHeaders: string[]): string[] {
  return [
    ...TEACHER_CSV_STUDENT_COLUMNS, "Attempt", "Status", "SAT Score",
    ...(twoModules ? ["M1 Correct", "M2 Correct"] : ["Correct"]),
    "% Correct", "Time Spent", "Left Tab", "Submitted At", ...questionHeaders,
  ];
}

/** A row's cells under TEACHER_CSV_STUDENT_COLUMNS. */
export function teacherCsvStudentCells(s: { name: string; grade: string | null | undefined; className: string | null | undefined }): string[] {
  return [s.name, s.grade ?? "", s.className ?? ""];
}
