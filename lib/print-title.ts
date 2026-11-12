// document.title reads back with whitespace stripped and collapsed (HTML
// spec), so "Math  Test" is read as "Math Test". Comparing the raw string
// with what the browser reports never matches; the print preview's title
// keeper (a MutationObserver on <head>) then rewrote the title forever and
// froze the tab ("Loading images… 0/0") for any test or student name with a
// double, leading or trailing space. Compare in the browser's own form.
export function documentTitleForm(title: string): string {
  return title.replace(/[\t\n\f\r ]+/g, " ").trim();
}
