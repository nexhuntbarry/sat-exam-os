// @page rules for the paginated print preview (Paged.js polyfills the
// margin boxes, so page numbers and the running name print in every browser).
const cssString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

export function printPageCss({
  header,
  totalPages = true,
  landscape = false,
}: {
  header: { text: string } | { studentName: true };
  totalPages?: boolean;
  /** Wide tables (the class gradebook). */
  landscape?: boolean;
}): string {
  const top = "studentName" in header ? "string(student)" : cssString(header.text);
  return `
@page {
  size: letter${landscape ? " landscape" : ""};
  margin: 0.5in 0.5in 0.55in 0.5in;
  @top-left { content: ${top}; font-size: 8pt; color: #555; vertical-align: bottom; padding-bottom: 6pt; }
  @bottom-right { content: "Page " counter(page)${totalPages ? ' " of " counter(pages)' : ""}; font-size: 8pt; color: #555; }
}
.print-student-name { string-set: student content(text); }
.break-before-page { break-before: page; }
/* Double-sided: the next student starts on a front side (Paged.js adds a blank page). */
.break-before-recto { break-before: recto; }
/* Keep together only what must stay together: a figure (with the stem
   just above it) and the choice list. Stems and passages flow. */
.break-inside-avoid, .print-keep, .print-figure, .print-choices, .mathmd table { break-inside: avoid; }
.print-module-head { break-after: avoid; }
/* 1/3 of the 10in content height, given back after the heading (~0.45in). */
.print-module-reserve { break-inside: avoid; height: 3.3in; margin-bottom: -2.85in; }
p { orphans: 3; widows: 3; }

`;
}
