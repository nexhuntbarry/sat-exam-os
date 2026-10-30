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
   - `main` names/titles: wide, flexible (default 30%), truncates.
   - `short` status, grade, dates, counts: shrinks to content, `nowrap`.
   - `long` free text: flexible (default 20%), truncated with "…" and the full
     text in a hover `title` (`TruncatedText`). Never wraps or widens the table.
   - `actions`: the ⋯ column, shrink-to-fit, right-aligned.
   Override a flexible column's share with `className="w-[16%]"`.
4. **Row actions go in a ⋯ menu** (`RowActionsMenu`), not several buttons.
   "View details" first, destructive actions last with `tone: "danger"`.
5. **Responsive columns.** Give lower-priority columns `priority="md" | "lg" |
   "xl"`; they hide below that breakpoint. Pass the hidden fields to
   `DataRow details={…}` as `DetailItem`s with the same priority, set
   `expandBelow` to the highest priority used, and put `<ExpandToggle />` in
   the actions cell. Clicking the row (or the chevron) shows them. Optional
   `ColumnsPicker` lets each viewer hide columns (saved in localStorage).
6. **Sticky edges.** First column `sticky="left"`, actions `sticky="right"`
   (on both `Th` and `Td`). Rows have solid backgrounds so this stays opaque.
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
| `DataRow` | Body `<tr>`. Props: `details` (DetailItems), `expandBelow` (`md`\|`lg`\|`xl`, default `xl`), `tone` (`default`\|`warning`), `colSpan` (details row span; defaults to the cell count). |
| `DetailItem` | `label` + value in the details row; `priority` = its column's priority (shown only while that column is hidden). |
| `ExpandToggle` | Chevron button for the details row (only renders below `expandBelow`). |
| `EmptyRow` | "No results" row: `colSpan` + children. |
| `TwoLineCell` | `main`, `detail`, optional `mainTitle`/`detailTitle`/`mainClassName`. |
| `TruncatedText` | One truncated line with hover title (`title` prop if children isn't a string). |
| `RowActionsMenu` | ⋯ menu. `label` (aria name, e.g. ``Actions for ${name}``) and `items: RowAction[]` (false/null allowed). `RowAction = { label, icon?, href? \| onSelect?, tone?: "danger", disabled? }`. Portal + fixed position, keyboard and Esc/outside-click close. `onSelect` runs after the menu closes. |
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
      <DataRow key={r.id} expandBelow="lg"
        details={<DetailItem label="School" priority="lg">{r.school}</DetailItem>}>
        <Td kind="main" sticky="left"><TwoLineCell main={r.name} detail={r.email} /></Td>
        <Td>{r.status}</Td>
        <Td kind="long" priority="lg"><TruncatedText>{r.school}</TruncatedText></Td>
        <Td kind="actions" sticky="right">
          <ExpandToggle />
          <RowActionsMenu label={`Actions for ${r.name}`}
            items={[{ label: "View details", href: `/x/${r.id}` }]} />
        </Td>
      </DataRow>
    ))}
  </tbody>
</DataTable>
```

Gotchas: priority/kind classes are literal strings in the kit, don't build
class names dynamically. Clicks on `a`, `button`, `input`, `select`, `label`
inside a row don't toggle it. If the details row would be empty for a table
(no prioritised columns), omit `details` and `ExpandToggle`.
