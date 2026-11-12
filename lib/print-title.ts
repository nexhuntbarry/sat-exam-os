// document.title reads back normalised by the browser (HTML whitespace
// stripped and collapsed), so "Math  Test" is read as "Math Test". The print
// preview's title keeper (a MutationObserver on <head>) compared the raw
// string with what the browser reported, never matched, rewrote the title
// forever and froze the tab ("Loading images… 0/0") for any test or student
// name with a double, leading or trailing space.
//
// The keeper below doesn't predict the browser's normalisation at all: it
// remembers what the title read back as after its own write, and only writes
// again when the title has changed from that. One write per real change, for
// any name (NBSP, ideographic spaces, tabs…).
export function makeTitleKeeper(doc: { title: string }, title: string): () => void {
  let readBack: string | null = null;
  return () => {
    if (readBack !== null && doc.title === readBack) return;
    doc.title = title;
    readBack = doc.title;
  };
}
