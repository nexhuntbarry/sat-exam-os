import { Noto_Sans_TC } from "next/font/google";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import zh from "@/messages/zh.json";
import { BRAND } from "@/lib/brand";
import { PremierBadge, PremierWordmark } from "@/components/brand/Premier";
import {
  assessmentType,
  chartLayout,
  domainRows,
  linePath,
  MATH,
  nyDay,
  reportCards,
  RW,
  STRONG_PCT,
  targetedReview,
  type Assessment,
  type CardValue,
  type ChartLayout,
  type ReportSection,
  type SeriesKey,
} from "@/lib/one-page-report";

// The one-page parent report (support a05ff7b7, batch 2): Letter, exactly
// one page, full-bleed header band. Every block has a fixed height and the
// page itself is a fixed-height box with overflow hidden, so long names,
// Chinese text or many assessments can never push it onto a second page.
// Rendered inside PrintPreview (Paged.js) like the other printouts.

// Chinese glyphs for the server's PDF (its Chromium has no CJK fonts):
// self-hosted by next/font, so it loads from our own origin.
// CJK glyphs load on demand via unicode-range; "latin" is the only named subset Google Fonts exposes for this family.
const notoTc = Noto_Sans_TC({ subsets: ["latin"], preload: false, display: "block", variable: "--font-noto-tc" });

export type ReportLang = "en" | "zh";

const NAVY = "#0c2a55";
const GOLD_RULE = "#d8a640";
const INK = "#13294b";
const MUTED = "#5f6b7a";
const GREEN = "#23925f";
const GOLD = "#d6a23a";
const SERIES: Record<SeriesKey, { color: string; label: string; width: number; dash?: string; r: number; hollow?: boolean }> = {
  total: { color: "#12376e", label: "#12376e", width: 3.6, r: 5 },
  math: { color: "#2f6fc4", label: "#2a64b2", width: 2.2, dash: "7 4", r: 3.8 },
  rw: { color: "#86afe2", label: "#5a88c4", width: 2.4, dash: "1.5 4", r: 3.8, hollow: true },
};

/** Page CSS: Letter, no margins (the header band runs to the edges). */
export const ONE_PAGE_REPORT_PAGE_CSS = `@page { size: letter; margin: 0; }`;

const CSS = `
/* White paper behind the page (the print layout's cream would print). */
@media print { html, body, .bg-cream { background: #fff !important; } }
.opr { width: 8.5in; height: 10.94in; overflow: hidden; display: flex; flex-direction: column; color: ${INK};
  font-family: var(--font-inter), var(--font-noto-tc), ui-sans-serif, system-ui, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.opr * { box-sizing: border-box; }
.opr-band { background: ${NAVY}; border-bottom: 5px solid ${GOLD_RULE}; height: 1.02in; flex: none;
  display: flex; align-items: center; justify-content: space-between; padding: 0 0.5in; }
.opr-brand { display: flex; align-items: center; gap: 12px; }
.opr-band-title { text-align: right; line-height: 1.15; }
.opr-band-title .a { color: #fff; font-weight: 800; font-size: 21px; letter-spacing: .02em; }
.opr-band-title .b { color: ${BRAND.gold}; font-weight: 700; font-size: 16px; letter-spacing: .04em; }
.opr-body { flex: 1; min-height: 0; padding: 0.22in 0.5in 0; display: flex; flex-direction: column; }
.opr-label { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: ${MUTED}; }
.opr-info { display: grid; grid-template-columns: 1.5fr 1.2fr .8fr; gap: 16px; height: 54px; flex: none; }
.opr-info > div { min-width: 0; }
.opr-info .v { margin-top: 3px; font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.opr-info .name { font-size: 22px; font-weight: 800; }
.opr-info .name.long { font-size: 17px; }
.opr-info .r { text-align: right; }
.opr-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; height: 88px; flex: none; margin-top: 10px; }
.opr-card { border: 1px solid #d9e0ea; border-radius: 10px; padding: 9px 12px 8px; display: flex; flex-direction: column; min-width: 0; }
.opr-card .num { display: flex; align-items: baseline; justify-content: space-between; margin-top: 2px; }
.opr-card .big { font-size: 32px; font-weight: 800; line-height: 1.05; }
.opr-card .of { font-size: 11px; color: ${MUTED}; }
.opr-card .cap { margin-top: auto; font-size: 9.5px; color: ${MUTED}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.opr-up { color: #1f63b8; } .opr-down { color: #b4513a; } .opr-flat { color: ${INK}; } .opr-none { color: #a3adba; }
.opr-chart { border: 1px solid #d9e0ea; border-radius: 10px; padding: 10px 14px 4px; margin-top: 12px; height: 3.55in; flex: none; display: flex; flex-direction: column; }
.opr-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.opr-h { font-size: 13.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.opr-legend { display: flex; gap: 14px; align-items: center; font-size: 10px; color: ${MUTED}; white-space: nowrap; }
.opr-legend span { display: inline-flex; align-items: center; gap: 5px; }
.opr-sub { font-size: 10px; color: ${MUTED}; margin-top: 1px; }
.opr-chart svg { display: block; width: 100%; flex: 1; min-height: 0; }
.opr-dhead { display: flex; justify-content: space-between; align-items: baseline; margin-top: 12px; height: 20px; flex: none; }
.opr-domains { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 6px; height: 2.45in; flex: none; }
.opr-domains.one { grid-template-columns: 1fr; }
.opr-dcard { border: 1px solid #d9e0ea; border-radius: 10px; padding: 10px 14px; min-width: 0; overflow: hidden; }
.opr-dcard h3 { margin: 0 0 4px; font-size: 12.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; padding-bottom: 6px; border-bottom: 1px solid #e3e8ef; }
.opr-drow { margin-top: 9px; }
.opr-drow .top { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; font-weight: 600; }
.opr-drow .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.opr-drow .pc { white-space: nowrap; font-weight: 700; font-size: 11px; }
.opr-bar { height: 7px; border-radius: 4px; background: #e6ebf2; margin-top: 4px; overflow: hidden; }
.opr-bar > div { height: 100%; border-radius: 4px; }
.opr-review { margin-top: 12px; background: rgba(214, 228, 247, .55); border-radius: 10px; padding: 9px 14px; height: 0.62in; flex: none; overflow: hidden; }
.opr-review .opr-label { color: #1f63b8; }
.opr-review .list { margin-top: 4px; font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.opr-review .sep { color: #9aa6b5; margin: 0 10px; font-weight: 400; }
.opr-foot { margin-top: auto; border-top: 1px solid #d9e0ea; padding: 8px 0 0.3in; font-size: 9.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: ${MUTED}; flex: none; }
.opr-empty { margin-top: 0.6in; text-align: center; color: ${MUTED}; font-size: 13px; }
`;

const fmt = (lang: ReportLang, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(lang === "zh" ? "zh-TW" : "en-US", { timeZone: "America/New_York", ...opts });

export default function OnePageReport({
  lang,
  studentName,
  sections,
  assessments,
  reportDate,
}: {
  lang: ReportLang;
  studentName: string;
  /** Sections the viewer may see (a teacher of one subject: that one). */
  sections: ReportSection[];
  assessments: Assessment[];
  reportDate: Date;
}) {
  const t = createTranslator({ locale: lang, messages: lang === "zh" ? zh : en, namespace: "onePageReport" });
  const longDate = fmt(lang, { year: "numeric", month: lang === "zh" ? "long" : "short", day: "numeric" });
  const day = (iso: string) => longDate.format(new Date(iso));
  const both = sections.includes(RW) && sections.includes(MATH);
  const cards = reportCards(assessments);
  const type = assessmentType(assessments);
  const domainName = (d: string) => t(`domain.${d}` as never) as string;
  const perSection = sections.map((s) => ({ s, rows: domainRows(assessments, s) }));
  const review = targetedReview(perSection.flatMap((x) => x.rows));
  const chart = chartLayout(assessments);
  // x-axis dates: "Nov 10" / "11/10"; with the year when the chart spans
  // years ("11/10/25"); a crowded chart (>12) then dates every other point.
  const multiYear = new Set(chart.columns.map((c) => nyDay(c.date).slice(0, 4))).size > 1;
  const dense = chart.columns.length > 12;
  const shortDate = fmt(
    lang,
    multiYear ? { year: "2-digit", month: "numeric", day: "numeric" } : lang === "zh" || dense ? { month: "numeric", day: "numeric" } : { month: "short", day: "numeric" },
  );
  const dateEvery = dense && multiYear ? 2 : 1;

  const scoreCard = (label: string, v: CardValue | null, of: number, empty: string) => (
    <div className="opr-card">
      <div className="opr-label">{label}</div>
      <div className="num">
        <span className={`big ${v ? "" : "opr-none"}`}>{v ? v.value : "—"}</span>
        <span className="of">/{of}</span>
      </div>
      <div className="cap">{v ? (v.fromLatest ? day(v.date) : t("fromDate", { date: day(v.date) })) : empty}</div>
    </div>
  );

  return (
    <div className={`opr ${notoTc.variable}`} lang={lang === "zh" ? "zh-TW" : "en"}>
      <div className="opr-band">
        <div className="opr-brand" aria-label="Premier">
          <PremierBadge height={60} color={BRAND.gold} />
          <PremierWordmark height={24} color={BRAND.gold} />
        </div>
        <div className="opr-band-title">
          <div className="a">{t("satPractice")}</div>
          <div className="b">{t("scoreReport")}</div>
        </div>
      </div>

      <div className="opr-body">
        <div className="opr-info">
          <div>
            <div className="opr-label">{t("student")}</div>
            <div className={`v name ${studentName.length > 26 ? "long" : ""}`}>{studentName}</div>
          </div>
          <div>
            <div className="opr-label">{t("assessment")}</div>
            <div className="v">{t(type === "full" ? "typeFull" : type === "sections" ? "typeSections" : "typeMixed")}</div>
          </div>
          <div className="r">
            <div className="opr-label">{t("reportDate")}</div>
            <div className="v">{day(reportDate.toISOString())}</div>
          </div>
        </div>

        {assessments.length === 0 ? (
          <p className="opr-empty">{t("empty")}</p>
        ) : (
          <>
            <div className="opr-cards">
              {scoreCard(t("latestTotal"), both ? cards.total : null, 1600, both ? t("noTotal") : "")}
              <div className="opr-card">
                <div className="opr-label">{t("scoreChange")}</div>
                <div className="num">
                  <span className={`big ${!both || !cards.change ? "opr-none" : cards.change.delta > 0 ? "opr-up" : cards.change.delta < 0 ? "opr-down" : "opr-flat"}`}>
                    {both && cards.change ? (cards.change.delta > 0 ? `+${cards.change.delta}` : cards.change.delta < 0 ? `−${-cards.change.delta}` : "±0") : "—"}
                  </span>
                  <span className="of">{t("points")}</span>
                </div>
                <div className="cap">
                  {both ? (cards.change ? t("sinceDate", { date: day(cards.change.since), score: cards.change.from }) : t("noChange")) : ""}
                </div>
              </div>
              {scoreCard(t("math"), sections.includes(MATH) ? cards.math : null, 800, sections.includes(MATH) ? t("noSection") : "")}
              {scoreCard(t("rw"), sections.includes(RW) ? cards.rw : null, 800, sections.includes(RW) ? t("noSection") : "")}
            </div>

            <div className="opr-chart">
              <div className="opr-head">
                <div>
                  <div className="opr-h">{t("progression")}</div>
                  <div className="opr-sub">
                    {chart.hidden > 0
                      ? t("latestOf", { shown: assessments.length - chart.hidden, n: assessments.length })
                      : t("assessments", { n: assessments.length })}
                  </div>
                </div>
                <div className="opr-legend">
                  {chart.series.total.length > 0 && <Legend k="total" label={t("total")} />}
                  {sections.includes(MATH) && <Legend k="math" label={t("math")} />}
                  {sections.includes(RW) && <Legend k="rw" label={t("rw")} />}
                </div>
              </div>
              <ProgressChart chart={chart} xLabel={(i) => (chart.columns.length <= 6 ? (lang === "zh" ? `第 ${i} 次` : `Assessment ${i}`) : String(i))} date={(iso, i) => ((chart.columns.length - 1 - i) % dateEvery === 0 ? shortDate.format(new Date(iso)) : "")} offset={chart.hidden} />
            </div>

            <div className="opr-dhead">
              <div className="opr-h">{t("domainPerformance")}</div>
              <div className="opr-label">{t("initialLatest")}</div>
            </div>
            <div className={`opr-domains ${perSection.length === 1 ? "one" : ""}`}>
              {[MATH, RW]
                .map((s) => perSection.find((x) => x.s === s))
                .filter((x): x is NonNullable<typeof x> => Boolean(x))
                .map(({ s, rows }) => (
                  <div key={s} className="opr-dcard">
                    <h3>{s === MATH ? t("math") : t("rw")}</h3>
                    {rows.map((r) => {
                      const color = r.latest == null ? "#a3adba" : r.latest >= STRONG_PCT ? GREEN : GOLD;
                      return (
                        <div key={r.domain} className="opr-drow">
                          <div className="top">
                            <span className="nm">{domainName(r.domain)}</span>
                            <span className="pc" style={{ color }}>
                              {r.latest == null ? "—" : r.initial != null ? `${r.initial}% – ${r.latest}%` : `${r.latest}%`}
                            </span>
                          </div>
                          <div className="opr-bar">
                            <div style={{ width: `${r.latest ?? 0}%`, background: color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </div>

            {review.length > 0 && (
              <div className="opr-review">
                <div className="opr-label">{t("targetedReview")}</div>
                <div className="list">
                  {review.map((r, i) => (
                    <span key={r.domain}>
                      {i > 0 && <span className="sep">|</span>}
                      {domainName(r.domain)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className="opr-foot">{t("footer")}</div>
      </div>
    </div>
  );
}

/** The report's stylesheet (rendered once, outside the paginated source). */
export function OnePageReportStyles() {
  return <style>{CSS}</style>;
}

function Legend({ k, label }: { k: SeriesKey; label: string }) {
  const s = SERIES[k];
  return (
    <span>
      <svg width="28" height="10" aria-hidden="true">
        <line x1="1" y1="5" x2="27" y2="5" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinecap="round" />
        <circle cx="14" cy="5" r={s.r - 0.8} fill={s.hollow ? "#fff" : s.color} stroke={s.color} strokeWidth={s.hollow ? 1.8 : 0} />
      </svg>
      {label}
    </span>
  );
}

function ProgressChart({
  chart,
  xLabel,
  date,
  offset,
}: {
  chart: ChartLayout;
  xLabel: (n: number) => string;
  /** The date under column `i` ("" = none). */
  date: (iso: string, i: number) => string;
  offset: number;
}) {
  const { width, height, plot } = chart;
  const xl = height - 30;
  const dense = chart.columns.length > 12;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Score progression">
      {chart.totalTicks.map(({ value, y }) => (
        <g key={`t${value}`}>
          <line x1={plot.left} x2={plot.right} y1={y} y2={y} stroke="#e3e8ef" strokeWidth={1} />
          <text x={plot.left - 7} y={y + 3.5} textAnchor="end" fontSize={10} fill={SERIES.total.label} fontWeight={600}>{value}</text>
        </g>
      ))}
      {chart.sectionTicks.map(({ value, y }) => (
        <g key={`s${value}`}>
          <line x1={plot.left} x2={plot.right} y1={y} y2={y} stroke="#e3e8ef" strokeWidth={1} strokeDasharray="3 3" />
          <text x={plot.right + 7} y={y + 3.5} textAnchor="start" fontSize={10} fill={MUTED} fontWeight={600}>{value}</text>
        </g>
      ))}
      {(["rw", "math", "total"] as SeriesKey[]).map((k) => {
        const s = SERIES[k];
        const pts = chart.series[k];
        return (
          <g key={k}>
            <path d={linePath(pts)} fill="none" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round" />
            {pts.map((p) => (
              <circle key={p.i} cx={p.x} cy={p.y} r={s.r} fill={s.hollow ? "#fff" : s.color} stroke={s.hollow ? s.color : "#fff"} strokeWidth={s.hollow ? 2 : 1.2} />
            ))}
            {pts.map((p) => (
              <text
                key={`l${p.i}`}
                x={p.x}
                y={p.label === "above" ? p.y - s.r - 4 : p.y + s.r + 11}
                textAnchor="middle"
                fontSize={k === "total" ? (dense ? 10 : 11.5) : dense ? 8.5 : 10}
                fontWeight={700}
                fill={s.label}
                stroke="#fff"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {p.value}
              </text>
            ))}
          </g>
        );
      })}
      {chart.columns.map((c) => (
        <g key={c.i}>
          <text x={c.x} y={xl + 12} textAnchor="middle" fontSize={dense ? 8.5 : 9.5} fontWeight={700} fill={MUTED}>{xLabel(c.i + 1 + offset)}</text>
          <text x={c.x} y={xl + 24} textAnchor="middle" fontSize={dense ? 8 : 9} fill={MUTED}>{date(c.date, c.i)}</text>
        </g>
      ))}
    </svg>
  );
}
