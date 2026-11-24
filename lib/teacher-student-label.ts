// Server-side: the viewer's translation of "Unnamed student" (common.unnamedStudent)
// for teacher pages, API routes and exports. Falls back to English.
import { getTranslations } from "next-intl/server";
import { UNNAMED_STUDENT } from "@/lib/teacher-student-view";

export async function unnamedStudentLabel(): Promise<string> {
  try {
    return (await getTranslations("common"))("unnamedStudent");
  } catch {
    return UNNAMED_STUDENT;
  }
}
