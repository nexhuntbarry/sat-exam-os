# Printed tests missing diagrams — 2026-11-07

Reports: Premier teachers ("diagrams missing when they print tests"); Michelle K, admin ("the printed copy of each student's tests don't contain diagrams or graphs again").

Evidence folder: `/private/tmp/claude-501/-Users-barrychuang/32fe3b05-8de6-45cf-a4f5-1106b3e3ab56/scratchpad/print/`
(PDF = Chromium `page.pdf()`, Letter, print media; image counts = image XObjects in the PDF via `pdfimages -list`, compared with the `/api/blob-image` figures on the page.)

## Short answer

The diagrams go missing on the **student's printed copy** (teacher/admin "View detail" → *Print / Save PDF*, and Ctrl/Cmd+P on the student's own result page). The blank test / answer-key print page (`/print/tests/…`) keeps every diagram once the page has loaded; it only loses them when someone prints before the images arrive.

| Where | Browser | Diagrams in the PDF (prod, before fix) | Why |
|---|---|---|---|
| Teacher/admin result detail `/teacher/tests/[id]/results/[sub]` → **Print / Save PDF** button | Chromium (Chrome/Edge) | **0 of 4** (12 pages, Test #20 M1, 2 submissions) — also 0 of 4 after waiting 15 s | Figures are `loading="lazy"` and only mount when a row is expanded. The button expands every row and calls `window.print()` two animation frames later: the freshly mounted lazy images are off-screen, so they never even start loading. Same in Safari (lazy images below the fold aren't fetched for print). |
| Same page, **Ctrl/Cmd+P** | all | **0 of 4, 1 page** — no questions at all | Collapsed rows aren't in the DOM (React state), so the print shows the score card only. |
| Student result page `/student/tests/[id]/result`, Ctrl/Cmd+P | all | **0 of 4, 3 pages** (summaries only) | Questions sit in closed `<details>`; a closed `<details>` body is never laid out, whatever the print CSS says (`details > * {display:block}` doesn't reach it). Figures were also `loading="lazy"`. |
| Blank test / answer key `/print/tests/[id]`, page loaded | Chromium + WebKit | **all present**: 67 Chromium PDFs over every published test (blank + key), PDF count = page count, no figure split across pages; WebKit: 74 print-media checks, every figure loaded and visible | — |
| Same, printed right after opening (before images arrive) | Chromium | **0 of 11** [Test #12] blank, **0 of 6** [Test #20] blank, 0 of 7 [Test #25], 0 of 8 Oct 2024 Math … (17 tests lost all/most figures) | Images are fetched through the authenticated proxy after first paint; the plain Print button / Cmd+P doesn't wait. The answer-key copy was always fine in the run only because it was opened second (images cached). |

"Again": commit `367054c` (Oct 3, "Show question figures in post-submission review views") added the figures to the student's result views — but as `loading="lazy"` inside collapsed rows, and `935f907`'s print button (expand + print after 2 frames) predates it. So the figures came back on screen but never on paper.

Not a cause (checked): blob proxy auth/expiry (all 200s; `Cache-Control: private, max-age=600`), next/image (not used), `max-height`/overflow in print CSS, print CSS hiding image containers, KaTeX/SVG, break-inside (no figure split across pages in any of the 67 PDFs).

Graph answer choices: no published test currently has image answer choices on screen; QA test `5d582978` (#25 M1) does and is now in the nightly check (min width enforced).

Student report `/report`: no figures (charts only). Teacher class review `/teacher/tests/[id]/review` and student review: `ReviewQuestionCard` figures were also `loading="lazy"` (same risk for Cmd+P on long pages) — now eager. Take page: shows one question at a time; printing it is not a supported path.

## Fix (no deploy)

- `components/analytics/SubmissionDetailPanel.tsx` — question bodies are always rendered (collapsed rows are only `hidden` on screen, `print:block` on paper), so figures load with the page and Cmd+P prints every question with its figures. No `loading="lazy"`. The source-page PDF `<iframe>` fallback only mounts when a row is opened (each fetches the module PDF) and never prints (an embedded PDF prints as an empty box); paper shows "[Figure is on page N of the source test PDF.]" for those (image questions only — table questions already print the table text).
- `app/(teacher)/teacher/tests/[id]/results/[submission_id]/page.tsx` — Print / Save PDF waits for every image (`Loading images… 3/4`, button disabled), then prints; any image that fails/times out (20 s) is named in a red warning.
- `lib/print-images.ts` (new) — `waitForImages()` (complete + `decode()`, lazy→eager, timeout, failed list).
- `components/analytics/PrintButton.tsx` — same wait + progress + failure warning (used by `/print/tests` and `/report`); `PrintPendingNotice`: if someone presses Ctrl/Cmd+P before figures finish, the paper says so at the top instead of silently missing diagrams.
- `components/PrintOpenDetails.tsx` (new, mounted in `app/layout.tsx`) — opens every closed `<details>` on `beforeprint`, closes them on `afterprint` (student result page Cmd+P).
- `ReviewQuestionCard.tsx`, student result page, teacher question analytics — dropped `loading="lazy"` / `decoding="async"` on figures.
- `components/tests/PrintableTest.tsx` — figure block and each choice `break-inside: avoid` (a very tall question may break before its figure, never through it), figures capped at 7in on paper; graph answer choices in a 2-column grid at 1.6–3in wide.

## Verification (local `next dev` :3471, same DB/blob)

| Case | Before (prod) | After (local) |
|---|---|---|
| Result detail, Print button (sub 62d004ea / 20602008) | 0/4, 0/4 | **4/4, 4/4** |
| Result detail, Ctrl/Cmd+P | 1 page, 0/4 | **12–13 pages, 4/4** |
| Student result page, Ctrl/Cmd+P (TEST Student 017) | 3 pages, 0/4 | **23 pages, 4/4** |
| `/print/tests` Test #20 copy, Print pressed right after load | (Cmd+P cold: 4/6) | **6/6** (button waits) |
| New nightly `PRINT-PDF` + `PRINT-WEBKIT` | **FAIL** on prod: result Cmd+P 0 of 4 figures on the page / 1 page; adaptive blank 5/7, #25 M1 blank 5/7 (Print pressed before load); WebKit PASS | **PASS** (6/6, 7/7, 7/7 blank+key; result Cmd+P 4/4, button 4/4; WebKit all loaded) |

Files: `prod-student-*-{cmdP,button,button-wait15}.pdf`, `local-student-*.pdf`, `prod-student-result-cmdP.pdf`, `local-student-result-cmdP.pdf`, `local-printtest-button-cold.pdf`, `prod-chromium-<test>-<blank|key>[-immediate].pdf`, summaries `prod-print-tests.jsonl`, `prod-webkit.jsonl`, `nightly-prod.txt`.

`npx tsc --noEmit`: clean.

## Nightly check

`.omc/qa/harness/nightly/print-checks.mjs` (wired into `run.mjs` before PROD-HEALTH; plain-language lines in `pdf.mjs`; standalone `node nightly/print-checks.mjs`, `QA_BASE=` for local):
- **PRINT-PDF** (Chromium): QA admin prints `/print/tests` blank + key for the QA Test #20 copy, the adaptive test and any QA test with graph answer choices — Print pressed as soon as the page is interactive; plus the newest QA submission's result detail via Ctrl/Cmd+P and via the button. Counts image XObjects per PDF with pdf-lib and fails on: fewer images in the PDF than figures on the page, blank/degenerate images, an image spanning two pages, graph choices < 1.5in wide. PDFs kept in `.omc/qa/nightly/print-pdfs/`.
- **PRINT-WEBKIT**: WebKit has no `page.pdf()`; checks under print media that every figure is loaded and laid out (> 20px).

Limitation: Safari itself isn't scriptable here; WebKit (Playwright 2227) is the closest engine and has no PDF output, so the WebKit check is a print-media layout check, not a PDF count.
