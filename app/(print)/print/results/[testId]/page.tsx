import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import {
  listPrintableAttempts,
  loadResultPrintouts,
  parsePrintOptions,
  PrintAccessError,
  type PrintableAttempt,
  type PrintOptions,
  type Viewer,
} from "@/lib/result-printout";
import { readPrintTicket } from "@/lib/print-token";
import { inlineBlobImages } from "@/lib/blob-inline";
import { printPageCss } from "@/lib/print-page-css";
import { imgSrc } from "@/components/tests/PrintableTest";
import ResultPrintout from "@/components/print/ResultPrintout";
import PrintPreview, { type PreviewOption } from "@/components/print/PrintPreview";

export const dynamic = "force-dynamic";

// GET /print/results/<testId>?subs=<submissionId,…>&mode=full|short&expl=1&at=inline|end
// A student's printed result (or several: "Print all", one student per
// section). Teachers: their classes' students; admins: everyone; students:
// their own latest attempt. QA isolation and answer visibility are enforced
// in lib/result-printout. `pt` = a server-minted ticket used only by the
// PDF download's headless browser (see /api/print/results/[testId]/pdf).
export default async function PrintResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ testId: string }>;
  searchParams: Promise<{ subs?: string | string[]; mode?: string | string[]; expl?: string | string[]; at?: string | string[]; pt?: string | string[] }>;
}) {
  const { testId } = await params;
  const raw = await searchParams;
  // A repeated query param arrives as an array; take the first value.
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const sp = { subs: one(raw.subs), mode: one(raw.mode), expl: one(raw.expl), at: one(raw.at), pt: one(raw.pt) };

  let viewer: Viewer;
  let opts: PrintOptions;
  // Cap one render at 100 attempts (bulk downloads go one student per request).
  let subs = (sp.subs ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const ticketMode = Boolean(sp.pt);
  if (ticketMode) {
    const ticket = readPrintTicket(sp.pt);
    if (!ticket || ticket.testId !== testId) notFound();
    viewer = ticket.viewer;
    opts = ticket.opts;
    subs = ticket.subs;
  } else {
    const user = await getCurrentUser();
    if (!user) redirect("/sign-in");
    if (user.role === "teacher" && user.accountStatus !== "approved") redirect("/teacher");
    viewer = { userId: user.userId, role: user.role, isQa: user.isQa };
    opts = parsePrintOptions(sp);
  }

  const db = getServiceClient();
  let candidates: PrintableAttempt[] = [];
  try {
    if (viewer.role !== "student" && !ticketMode) {
      candidates = await listPrintableAttempts(db, viewer, testId);
      if (subs.length === 0) subs = candidates.map((c) => c.submissionId);
    }
    if (viewer.role !== "student" && subs.length === 0) {
      return <p className="p-10 text-center text-mid-gray">No student has finished this test yet.</p>;
    }
    const printouts = await loadResultPrintouts(db, viewer, testId, subs, opts);
    if (printouts.length === 0) notFound();

    // The server's headless browser has no session for the image proxy.
    let src = imgSrc;
    if (ticketMode) {
      const urls = printouts.flatMap((p) => p.modules.flatMap((m) => m.questions.flatMap((q) => [...q.imageUrls, ...q.choices.map((c) => c.image_url ?? "")])));
      const inlined = await inlineBlobImages(urls.filter(Boolean));
      src = (url: string) => inlined.get(url) ?? imgSrc(url);
    }

    const single = printouts.length === 1;
    const explAllowed = printouts.some((p) => p.visibility.answers && p.visibility.explanations);
    const options: PreviewOption[] = [
      {
        param: "mode",
        label: "Version",
        value: opts.mode,
        choices: [
          { value: "full", label: "Full (every question)" },
          { value: "short", label: "Short (summary + missed)" },
        ],
      },
      {
        param: "expl",
        label: "Explanations",
        value: opts.explanations ? "1" : "",
        choices: [
          { value: "", label: "Off" },
          { value: "1", label: "On" },
        ],
        disabledReason: explAllowed ? undefined : single ? "not released to this student" : "not released to these students",
      },
      ...(opts.explanations && explAllowed
        ? [{
            param: "at",
            label: "Place",
            value: opts.explanationsAt,
            choices: [
              { value: "inline", label: "Under each question" },
              { value: "end", label: "At the end" },
            ],
          }]
        : []),
    ];
    const qs = new URLSearchParams({ sub: printouts[0].submissionId, mode: opts.mode, ...(opts.explanations ? { expl: "1", at: opts.explanationsAt } : {}) });

    return (
      <PrintPreview
        title={single ? `${printouts[0].studentName} – ${printouts[0].testName}` : `${printouts.length} students – ${printouts[0].testName}`}
        pageCss={printPageCss({ header: { studentName: true }, totalPages: single })}
        options={options}
        students={candidates.length > 1 ? candidates.map((c) => ({ id: c.submissionId, name: c.studentName, classNames: c.classNames, checked: printouts.some((p) => p.studentId === c.studentId) })) : undefined}
        pdfUrl={single && !ticketMode ? `/api/print/results/${testId}/pdf?${qs}` : undefined}
      >
        <div className="bg-white text-charcoal">
          {printouts.map((p, i) => (
            <ResultPrintout key={p.submissionId} p={p} opts={opts} first={i === 0} src={src} />
          ))}
        </div>
      </PrintPreview>
    );
  } catch (e) {
    if (e instanceof PrintAccessError) notFound();
    throw e;
  }
}
