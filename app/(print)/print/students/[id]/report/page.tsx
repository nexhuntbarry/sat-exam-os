import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { PrintAccessError, type Viewer } from "@/lib/result-printout";
import { readReportTicket } from "@/lib/print-token";
import { watermarkOn, watermarkOption } from "@/lib/print-watermark";
import { loadOnePageReport } from "@/lib/one-page-report-data";
import PrintPreview from "@/components/print/PrintPreview";
import OnePageReport, { ONE_PAGE_REPORT_PAGE_CSS, OnePageReportStyles, type ReportLang } from "@/components/print/OnePageReport";

export const dynamic = "force-dynamic";

// GET /print/students/<studentId>/report?lang=en|zh&wm=0
// The one-page parent report (support a05ff7b7): one Letter page, in English
// or Chinese (default: the viewer's app language). Admins: any student on
// their side; teachers: a student in one of their classes (their subjects);
// same watermark rule as the other printouts. `pt` = a ticket minted by
// /api/print/students/<id>/report/pdf for the server's headless browser.
export default async function OnePageReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string | string[]; wm?: string | string[]; pt?: string | string[] }>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const pt = one(raw.pt);

  let viewer: Viewer;
  let lang: ReportLang;
  let watermark: boolean;
  if (pt) {
    const ticket = readReportTicket(pt);
    if (!ticket || ticket.studentId !== id) notFound();
    viewer = ticket.viewer;
    lang = ticket.lang;
    // Decided (and role-checked) by the PDF route that minted the ticket.
    watermark = watermarkOn(viewer.role, ticket.wm === false ? "0" : null);
  } else {
    const user = await getCurrentUser();
    if (!user) redirect("/sign-in");
    if (user.role === "teacher" && user.accountStatus !== "approved") redirect("/teacher");
    viewer = { userId: user.userId, role: user.role, isQa: user.isQa };
    const l = one(raw.lang);
    lang = l === "en" || l === "zh" ? l : (await getLocale()) === "en" ? "en" : "zh";
    // Only admins can turn the watermark off.
    watermark = watermarkOn(viewer.role, one(raw.wm));
  }

  let data;
  try {
    data = await loadOnePageReport(getServiceClient(), viewer, id);
  } catch (e) {
    if (e instanceof PrintAccessError) notFound();
    throw e;
  }

  const qs = new URLSearchParams({ lang, ...(watermark ? {} : { wm: "0" }) });
  return (
    <>
      <OnePageReportStyles />
      <PrintPreview
        title={`${data.studentName} – SAT Score Report`}
        pageCss={ONE_PAGE_REPORT_PAGE_CSS}
        options={[
          {
            param: "lang",
            label: "Language",
            value: lang,
            choices: [
              { value: "en", label: "English" },
              { value: "zh", label: "中文" },
            ],
          },
          ...(viewer.role === "admin" ? [watermarkOption(watermark)] : []),
        ]}
        pdfUrl={pt ? undefined : `/api/print/students/${id}/report/pdf?${qs}`}
        watermark={watermark}
      >
        <OnePageReport
          lang={lang}
          studentName={data.studentName}
          sections={data.sections}
          assessments={data.assessments}
          reportDate={new Date()}
        />
      </PrintPreview>
    </>
  );
}
