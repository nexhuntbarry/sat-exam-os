// node --env-file=.env.local --import tsx scripts/try-reextract.ts <question id>... — print what Re-extract from PDF returns (read-only).

async function main() {
  const { reextractQuestionFromPdf } = await import("../lib/repair-ops");
  for (const id of process.argv.slice(2)) {
    const t = Date.now();
    const r = await reextractQuestionFromPdf(id);
    console.log(`== ${id} (${((Date.now() - t) / 1000).toFixed(1)}s)`, JSON.stringify(r, null, 1));
  }
}
main();
