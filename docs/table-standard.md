# Table standard

One standard for every list/table in the app. Kit: `components/ui/data-table`
(import from `@/components/ui/data-table`). Reference implementation:
`app/(admin)/admin/students/StudentsClient.tsx`.

## Rules

1. **Full width.** No `max-w-* mx-auto` wrapper on list pages, no card around
   the table. `DataTable` is full width with a top/bottom divider only.
2. **Combine related info** into one two-line cell (`TwoLineCell`): main value
   on top, small muted detail below. e.g. Student = name / email; Parent =
   name / phone or email; Activity = last sign-in / registered date. Short
   pairs can share one line: Grade & school = `11 · Herricks High School`.
3. **Widths by type** (`kind` on `Th`/`Td`):
   - `main` names/titles: wide, flexible (default 30%). The name stays
     complete: it wraps onto up to two lines (`ClampText`) rather than
     truncating. Only secondary long text truncates.
   - `short` status, grade, dates, counts: shrinks to content, `nowrap`.
   - `long` free text: flexible (default 20%), truncated with "…" and the full
     text in a hover `title` (`TruncatedText`). Never wraps or widens the table.
   - `actions`: the ⋯ column, shrink-to-fit, right-aligned.
   Override a flexible column's share with `className="w-[16%]"`.
4. **Row actions: the common one is a button, the rest go in ⋯.** The most
   common action for the row's *current state* is a visible one-click
   `RowButton` (e.g. a pending student: **Approve** (primary) + **Reject**; a
   suspended student: **Reactivate**). Only less frequent or risky actions
   (Suspend, Delete, Remove, Reset, Grant retake…) go in the ⋯ menu
   (`RowActionsMenu`), destructive ones last with `tone: "danger"`. Clicking
   a row opens its detail page (`DataRow href`), so "View" / "View details"
   is never a menu item where the row is clickable; if nothing else is left,
   omit the ⋯. Keep confirmations on destructive actions. Wrap the cell's
   contents in `RowActions` (one line, never wraps); the actions column
   stays `sticky="right"`. Reference: Tests list (**Assign ▾** + ⋯) and
   Students.
5. **Responsive columns.** Give lower-priority columns `priority="md" | "lg" |
   "xl"`; they hide below that breakpoint. Pass the hidden fields to
   `DataRow details={…}` as `DetailItem`s with the same priority, set
   `expandBelow` to the highest priority used, and put `<ExpandToggle />` in
   the actions cell. Clicking the row (or the chevron) shows them. Optional
   `ColumnsPicker` lets each viewer hide columns (saved in localStorage).
6. **Sticky edges.** First column `sticky="left"`, actions `sticky="right"`
   (on both `Th` and `Td`). Rows have solid backgrounds so this stays opaque.
   Sticky cells are `z-[1]` and form their own stacking context, so a
   `fixed` dialog or menu rendered *inside* a row is trapped under later
   rows' sticky cells. Every modal overlay and dropdown must render through
   a portal: wrap dialogs in `<Portal>` (`@/components/ui/Portal`) with
   `fixed inset-0 z-50`; menus use `RowActionsMenu` (already portalled) or
   `<Portal>` + `fixed z-50`. Never raise a sticky cell's z-index to fix
   overlap.
7. **Short dates.** Use `formatShortDateTime` / `formatShortDate` from
   `lib/datetime.ts` (New York time; year omitted for the current year:
   `10/30 4:55 PM`, otherwise `10/30/2025 4:55 PM`). Put the full
   `formatDateTime` in a hover `title` when precision matters.

Aim: a list page fits a 1366px screen (with the sidebar) without horizontal
scrolling. Mostly 5–7 columns; merge or demote the rest.

## Kit API

| Export | Purpose |
| --- | --- |
| `DataTable` | Root (`overflow-x-auto` wrapper + `<table>`). Put `<thead>`/`<tbody>` inside. |
| `HeadRow` | Header `<tr>` with solid background. |
| `Th`, `Td` | Cells. Props: `priority` (`always`\|`md`\|`lg`\|`xl`, default `always`), `kind` (`main`\|`short`\|`long`\|`actions`, default `short`), `sticky` (`left`\|`right`), plus normal th/td attributes. |
| `DataRow` | Body `<tr>`. Props: `href` (whole row opens it; Ctrl/⌘-click = new tab; add `ExpandToggle` if the row also has `details`), `details` (DetailItems), `expandBelow` (`md`\|`lg`\|`xl`, default `xl`), `tone` (`default`\|`warning`), `colSpan` (details row span; defaults to the cell count). |
| `DetailItem` | `label` + value in the details row; `priority` = its column's priority (shown only while that column is hidden). |
| `ExpandToggle` | Chevron button for the details row (only renders below `expandBelow`). |
| `EmptyRow` | "No results" row: `colSpan` + children. |
| `TwoLineCell` | `main`, `detail`, optional `mainTitle`/`detailTitle`/`mainClassName`. |
| `ClampText` | Main name/title: wraps to at most 2 lines, full text on hover. |
| `TruncatedText` | One truncated line with hover title (`title` prop if children isn't a string). |
| `RowActionsMenu` | ⋯ menu. `label` (aria name, e.g. ``Actions for ${name}``) and `items: RowAction[]` (false/null allowed). `RowAction = { label, icon?, href? \| onSelect?, tone?: "danger", disabled? }`. Portal + fixed position, keyboard and Esc/outside-click close. `onSelect` runs after the menu closes. |
| `RowButton` | Visible row action. `label`, `href` (Server Components OK) or `onClick` (client only), `icon` as an element (`<Check size={13} />`), `tone` (`primary`\|`default`\|`danger`), `disabled`, `title`. Never wraps. |
| `RowActions` | One-line, right-aligned wrapper for the actions cell (`ExpandToggle`, `RowButton`s, `RowActionsMenu`). |
| `useColumnPrefs(key, columns)` / `ColumnsPicker` | Optional per-viewer column visibility. `columns: ColumnDef[]` (`{ key, label, locked?, defaultHidden? }`, define at module level). Guard each `Th`/`Td`/`DetailItem` with `prefs.isVisible(key)`; use `prefs.visibleCount` for colSpans. |
| `cn` | clsx + tailwind-merge. |

## Minimal example

```tsx
<DataTable>
  <thead>
    <HeadRow>
      <Th kind="main" sticky="left">Name</Th>
      <Th>Status</Th>
      <Th kind="long" priority="lg">School</Th>
      <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
    </HeadRow>
  </thead>
  <tbody>
    {rows.map((r) => (
      <DataRow key={r.id} href={`/x/${r.id}`} expandBelow="lg"
        details={<DetailItem label="School" priority="lg">{r.school}</DetailItem>}>
        <Td kind="main" sticky="left"><TwoLineCell main={r.name} detail={r.email} /></Td>
        <Td>{r.status}</Td>
        <Td kind="long" priority="lg"><TruncatedText>{r.school}</TruncatedText></Td>
        <Td kind="actions" sticky="right">
          <RowActions>
            <ExpandToggle />
            {r.pending && <RowButton label="Approve" tone="primary" onClick={() => approve(r)} />}
            <RowActionsMenu label={`Actions for ${r.name}`}
              items={[{ label: "Delete…", tone: "danger", onSelect: () => remove(r) }]} />
          </RowActions>
        </Td>
      </DataRow>
    ))}
  </tbody>
</DataTable>
```

Gotchas: priority/kind classes are literal strings in the kit, don't build
class names dynamically. Server Components can't pass functions to the kit
(icon components, `onClick`/`onSelect`): pass rendered elements and `href`s,
or move the action into a small client component. Clicks on `a`, `button`, `input`, `select`, `label`
inside a row don't toggle it. If the details row would be empty for a table
(no prioritised columns), omit `details` and `ExpandToggle`.

## Shared page components (support cb57e703 / f83c766b)

| Component | Use |
|---|---|
| `StatusBadge` (`@/components/ui/StatusBadge`) | Every status pill. One vocabulary + colour per status: attempt Not started / In progress (Module x of y) / Submitted / Late; test Draft / Published / Closed; module Draft / In review (n) / Ready; student Pending / Active / Suspended. Never red (red = errors and destructive actions). `studentStatusLabel()` / `attemptStatusLabel()` map DB values. |
| `SubjectTag` | Subject as a small neutral tag: Math / R&W. No coloured titles. |
| `ScoreCell` + `scoreDisplay()` (`@/lib/score-display`) | Every score: SAT section score (200–800) large, per-module counts small ("M1 22/27 · M2 18/27"), in-review note + % on hover. No SAT until every module is in; no per-module SAT. Averages: `averageSat()` with % as small text. |
| `DetailHeader`, `StatCards` (`@/components/ui/DetailHeader`) | Detail pages: back link, name + status badge, one summary line, main action · Edit · ⋯; then 3–4 key numbers (neutral colours); then content. |

Formats: dates via `formatShortDateTime` ("10/30 4:55 PM", year only when not this year); no "Due —" when there's no due date; empty states say what to do next.
