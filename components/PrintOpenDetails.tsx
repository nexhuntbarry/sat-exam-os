"use client";

import { useEffect } from "react";

// Ctrl/Cmd+P on a page with collapsed <details> rows (e.g. the student
// result page) printed only the one-line summaries: a closed <details> keeps
// its body out of layout no matter what print CSS says. Open the ones marked
// data-print-open (question rows; other pages keep their collapsed sections) for
// the print and close the ones we opened afterwards.
export default function PrintOpenDetails() {
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      opened = Array.from(document.querySelectorAll<HTMLDetailsElement>("details[data-print-open]:not([open])"));
      opened.forEach((d) => (d.open = true));
    };
    const after = () => {
      opened.forEach((d) => (d.open = false));
      opened = [];
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  return null;
}
