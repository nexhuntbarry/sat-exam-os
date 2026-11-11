// Pure: does a test reach a class teacher through their classes? Same rule
// as getTeacherTestScope (lib/teacher-access.ts) for one test: the test (or
// its full-length parent / section children) is on teacher_ids, assigned to
// one of their class groups, assigned to one of their students
// individually, or taken by one of their students — each path counted only
// when the subject it reaches the teacher under matches the test's section
// (a NULL subject means "both"; a NULL section, e.g. a full-length parent,
// matches any subject). No imports, so unit tests can load it directly.

export interface ClassReachInput {
  teacherId: string;
  /** teacher's class_group id → subject taught there (null = both) */
  groupSubject: Map<string, string | null>;
  /** teacher's student id → subjects the teacher teaches them */
  studentSubjects: Map<string, (string | null)[]>;
  /** test_assignments rows of the test, its parent and its section children */
  assignments: {
    test_id: string;
    teacher_ids?: unknown;
    class_group_ids?: unknown;
    student_ids?: unknown;
  }[];
  /** submissions on those tests (any student; non-students are ignored) */
  takenBy: { test_id: string; student_id: string }[];
  /** test id → section ("Math" | "Reading & Writing"), null when none */
  sections: Map<string, string | null>;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export function reachesClassTeacher(i: ClassReachInput): boolean {
  const fits = (testId: string, subjects: (string | null)[]) => {
    const sec = i.sections.get(testId) ?? null;
    return !sec || subjects.some((s) => !s || s === sec);
  };
  const allSubjects = Array.from(i.groupSubject.values());
  for (const a of i.assignments) {
    const subjects: (string | null)[] = [];
    if (ids(a.teacher_ids).includes(i.teacherId)) subjects.push(...allSubjects);
    for (const gid of ids(a.class_group_ids)) {
      if (i.groupSubject.has(gid)) subjects.push(i.groupSubject.get(gid) ?? null);
    }
    for (const sid of ids(a.student_ids)) subjects.push(...(i.studentSubjects.get(sid) ?? []));
    if (subjects.length > 0 && fits(a.test_id, subjects)) return true;
  }
  for (const s of i.takenBy) {
    const subjects = i.studentSubjects.get(s.student_id);
    if (subjects && fits(s.test_id, subjects)) return true;
  }
  return false;
}
