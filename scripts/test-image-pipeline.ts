// End-to-end image extraction smoke test.
// Run from repo root with:
//   npx tsx --env-file=.env.prod scripts/test-image-pipeline.ts
//
// Loads the real SAT PDF Barry uploaded over Telegram, runs the parser to
// produce questions + image_regions, runs the cropper/uploader, and verifies
// at least one resulting URL serves a real image_<x>/png response.
//
// Hard requirement from the task: actual outputs must be pasted into the
// final report. Don't add try/catch that swallows errors — fail loud.

import { readFile } from "node:fs/promises";
import { parsePdfToQuestions } from "../lib/ai/parse-pdf";
import { extractAndUploadQuestionImages } from "../lib/ai/extract-images";

const PDF_PATH =
  "/Users/barrychuang/.claude/channels/telegram/inbox/1777146391203-AgAD5ggAAnBwaUc.pdf";

async function main() {
  console.log(`[test-image-pipeline] reading PDF: ${PDF_PATH}`);
  const pdfBuffer = await readFile(PDF_PATH);
  const pdfBase64 = pdfBuffer.toString("base64");
  console.log(`[test-image-pipeline] PDF size: ${pdfBuffer.length} bytes`);

  // Stash a tmp public URL by uploading the PDF to Vercel Blob? Not needed —
  // parsePdfToQuestions accepts a URL OR we can dodge the fetch step. The
  // function does its own fetch internally; for the test we'd need a URL.
  // Workaround: write a data: URL? fetch() in Node supports data: URLs via
  // undici, but that requires a roundtrip. Simpler: monkey-patch global
  // fetch so the URL we pass returns our local buffer. Cleanest: just upload
  // it to Blob first.
  const { put } = await import("@vercel/blob");
  // Both stores are configured as private. The PDF upload path used by the
  // real /parse route also uses the private store; fetchPdfAsBase64 inside
  // parsePdfToQuestions adds the bearer auth header automatically when the
  // URL points at *.blob.vercel-storage.com.
  const privateToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!privateToken) {
    throw new Error("Need BLOB_READ_WRITE_TOKEN in env");
  }
  const stamp = Date.now();
  const tmpKey = `test-image-pipeline/${stamp}.pdf`;
  // Both production blob stores are private — `access:"public"` is rejected.
  // Use `access:"private"`; fetchPdfAsBase64 in parsePdfToQuestions adds the
  // bearer token automatically for *.blob.vercel-storage.com URLs.
  const uploaded = await put(tmpKey, pdfBuffer, {
    access: "private",
    addRandomSuffix: true,
    contentType: "application/pdf",
    token: privateToken,
  });
  console.log(`[test-image-pipeline] uploaded test PDF: ${uploaded.url}`);

  console.log("[test-image-pipeline] running parsePdfToQuestions...");
  const t0 = Date.now();
  const questions = await parsePdfToQuestions(
    uploaded.url,
    {
      section: "Math",
      difficulty_hint: "Mixed",
      moduleNumber: null,
    },
    undefined,
  );
  const parseElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[test-image-pipeline] parsed ${questions.length} questions in ${parseElapsed}s`,
  );

  // Per-question image_regions summary.
  let withImage = 0;
  let withRegions = 0;
  let totalRegions = 0;
  for (const q of questions) {
    if (q.has_image || q.has_table) withImage++;
    const regions = q.image_regions ?? [];
    if (regions.length > 0) withRegions++;
    totalRegions += regions.length;
    console.log(
      `  q${q.original_question_number}: has_image=${q.has_image} has_table=${q.has_table} regions=${regions.length} page=${q.page_number}`,
    );
  }
  console.log(
    `[test-image-pipeline] summary: ${withImage} questions need visuals, ${withRegions} have image_regions, ${totalRegions} total regions`,
  );

  const moduleId = `test-${stamp}`;
  console.log(
    `[test-image-pipeline] running extractAndUploadQuestionImages (moduleId=${moduleId})...`,
  );
  const t1 = Date.now();
  const result = await extractAndUploadQuestionImages(
    pdfBase64,
    questions,
    moduleId,
  );
  const extractElapsed = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(
    `[test-image-pipeline] extract done in ${extractElapsed}s: totalUploaded=${result.totalUploaded}, errors=${result.errors.length}`,
  );
  if (result.errors.length > 0) {
    console.log("[test-image-pipeline] errors:");
    for (const e of result.errors.slice(0, 5)) console.log("  - " + e);
  }

  if (result.totalUploaded === 0) {
    console.error(
      "[test-image-pipeline] FAIL: 0 images uploaded — extraction is still broken",
    );
    process.exit(1);
  }

  // Pick the first uploaded URL and curl it.
  let sampleUrl: string | null = null;
  let sampleQuestion: number | null = null;
  for (const [num, info] of result.byQuestion) {
    if (info.urls.length > 0) {
      sampleUrl = info.urls[0];
      sampleQuestion = num;
      break;
    }
  }
  if (!sampleUrl || sampleQuestion === null) {
    console.error(
      "[test-image-pipeline] FAIL: byQuestion map empty despite totalUploaded>0",
    );
    process.exit(1);
  }
  console.log(
    `[test-image-pipeline] sample URL (q${sampleQuestion}): ${sampleUrl}`,
  );

  console.log("[test-image-pipeline] HEAD-checking sample URL...");
  const fetchToken =
    process.env.PUBLIC_BLOB_READ_WRITE_TOKEN ?? process.env.BLOB_READ_WRITE_TOKEN;
  const fetchHeaders: Record<string, string> = {};
  if (fetchToken && sampleUrl.includes(".blob.vercel-storage.com")) {
    fetchHeaders.Authorization = `Bearer ${fetchToken}`;
  }
  const headRes = await fetch(sampleUrl, { headers: fetchHeaders });
  console.log(
    `[test-image-pipeline] HTTP ${headRes.status} content-type=${headRes.headers.get("content-type")} content-length=${headRes.headers.get("content-length")}`,
  );
  if (!headRes.ok) {
    console.error("[test-image-pipeline] FAIL: image URL did not return 200");
    process.exit(1);
  }
  const ct = headRes.headers.get("content-type") ?? "";
  if (!ct.startsWith("image/")) {
    console.error(
      `[test-image-pipeline] FAIL: content-type ${ct} is not image/*`,
    );
    process.exit(1);
  }
  // Drain the body so the connection closes cleanly.
  await headRes.arrayBuffer();

  console.log("\n[test-image-pipeline] PASS");
  console.log(
    `  parsed: ${questions.length} questions, ${withRegions} with regions, ${totalRegions} total regions`,
  );
  console.log(
    `  uploaded: ${result.totalUploaded} images across ${result.byQuestion.size} questions`,
  );
  console.log(`  sample: ${sampleUrl}`);
}

main().catch((err) => {
  console.error("[test-image-pipeline] fatal:", err);
  process.exit(1);
});
