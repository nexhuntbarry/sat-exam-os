// Section-based title colour, shared by the Modules and Tests lists:
// Math = dark blue, Reading & Writing = dark gold (the SubjectTag text colours
// in lib/subject-colors.ts; Tailwind needs the literal class names here).
export function sectionTitleClass(section: string | null | undefined): string {
  if (section === "Math") return "text-[#1E4E8C]";
  if (section === "Reading & Writing") return "text-[#7A5A12]";
  return "text-charcoal";
}
