import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

export type ProfileField =
  | "email"
  | "grade"
  | "school"
  | "campus"
  | "classGroup"
  | "classes"
  | "targetScore"
  | "level"
  | "parent"
  | "parentContact";

/**
 * Profile tab of the student page: label/value grid plus the notes. Each
 * page passes only the fields its viewer may see (a teacher gets no parent
 * contact or notes).
 */
export default async function StudentProfileCard({
  fields,
  notes,
}: {
  fields: [ProfileField, ReactNode][];
  notes?: string | null;
}) {
  const t = await getTranslations("studentTabs.profile");
  return (
    <>
      <div className="bg-surface border border-divider rounded-2xl p-6 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        {fields.map(([field, value]) => (
          <div key={field} className="min-w-0">
            <p className="text-soft-mute text-xs mb-0.5">{t(field)}</p>
            <p className="text-charcoal font-medium break-words">{value == null || value === "" ? "—" : value}</p>
          </div>
        ))}
      </div>
      {notes && (
        <div className="bg-warm-amber/10 border border-warm-amber/20 rounded-xl px-4 py-3 text-sm text-charcoal">
          <p className="text-xs uppercase tracking-wider text-warm-amber font-semibold mb-1">{t("notes")}</p>
          {notes}
        </div>
      )}
    </>
  );
}
