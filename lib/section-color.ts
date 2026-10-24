// Section-based title colour, shared by the Modules and Tests lists:
// Math = blue, Reading & Writing (English) = red.
export function sectionTitleClass(section: string | null | undefined): string {
  if (section === "Math") return "text-blue-600";
  if (section === "Reading & Writing") return "text-red-600";
  return "text-charcoal";
}
