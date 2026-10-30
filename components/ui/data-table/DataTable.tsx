"use client";

// Site-wide table primitives. See docs/table-standard.md for the rules.
//
//   <DataTable>
//     <thead><HeadRow><Th kind="main" sticky="left">Name</Th>…</HeadRow></thead>
//     <tbody>
//       <DataRow expandBelow="xl" details={<DetailItem …/>}>
//         <Td kind="main" sticky="left">…</Td>…
//         <Td kind="actions" sticky="right"><ExpandToggle /><RowActionsMenu …/></Td>
//       </DataRow>
//     </tbody>
//   </DataTable>

import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

/** Column priority: "always" is never hidden; "md" | "lg" | "xl" columns only
 *  show from that Tailwind breakpoint up (below it they move into the
 *  expandable details row). */
export type Priority = "always" | "md" | "lg" | "xl";

/** Column kind, which sets the width behaviour:
 *  - main:    names/titles. Wide and flexible, content truncates.
 *  - short:   status, grade, dates, counts. Shrinks to content, never wraps.
 *  - long:    free text (school, classes, notes). Flexible, truncates with "…".
 *  - actions: the ⋯ menu column. Shrinks to content, right-aligned. */
export type Kind = "main" | "short" | "long" | "actions";

/** Breakpoint from which every column of a table is visible. */
export type Breakpoint = "md" | "lg" | "xl";

// Literal class strings so Tailwind's scanner picks them up.
const PRIORITY_CELL: Record<Priority, string> = {
  always: "",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

/** Inverse of PRIORITY_CELL: visible only while the column is hidden. */
const PRIORITY_DETAIL: Record<Priority, string> = {
  always: "hidden",
  md: "md:hidden",
  lg: "lg:hidden",
  xl: "xl:hidden",
};

const BELOW: Record<Breakpoint, string> = {
  md: "md:hidden",
  lg: "lg:hidden",
  xl: "xl:hidden",
};

const ROW_CLICKABLE_BELOW: Record<Breakpoint, string> = {
  md: "cursor-pointer md:cursor-auto",
  lg: "cursor-pointer lg:cursor-auto",
  xl: "cursor-pointer xl:cursor-auto",
};

// max-w-0 stops the cell's content from forcing the table wider; the
// percentage then decides its share of the free space. Override the
// percentage per column with className (tailwind-merge resolves it).
const KIND_CELL: Record<Kind, string> = {
  main: "max-w-0 w-[30%]",
  long: "max-w-0 w-[20%]",
  short: "w-px whitespace-nowrap",
  actions: "w-px whitespace-nowrap text-right",
};

const STICKY: Record<"left" | "right", string> = {
  left: "sticky left-0 z-[1] bg-inherit",
  right: "sticky right-0 z-[1] bg-inherit",
};

interface CellOptions {
  /** Default "always". */
  priority?: Priority;
  /** Default "short". */
  kind?: Kind;
  /** Pin this cell while the table scrolls sideways (first / last column). */
  sticky?: "left" | "right";
}

function cellClass({ priority = "always", kind = "short", sticky }: CellOptions) {
  return cn("px-3 py-2.5 align-middle", PRIORITY_CELL[priority], KIND_CELL[kind], sticky && STICKY[sticky]);
}

/** Table root: full width, no card. Scrolls sideways only if the visible
 *  short columns alone overflow; pair with sticky first/last cells. */
export function DataTable({
  children,
  className,
  tableClassName,
}: {
  children: ReactNode;
  className?: string;
  tableClassName?: string;
}) {
  return (
    <div className={cn("w-full overflow-x-auto border-y border-divider", className)}>
      <table className={cn("w-full border-collapse text-sm", tableClassName)}>{children}</table>
    </div>
  );
}

/** Header row (solid background so sticky header cells stay opaque). */
export function HeadRow({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn("bg-light-bg border-b border-divider text-soft-mute", className)}>{children}</tr>;
}

/** Header cell. Use the same priority/kind/sticky as the matching Td. */
export function Th({
  priority,
  kind,
  sticky,
  className,
  children,
  ...rest
}: CellOptions & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(cellClass({ priority, kind, sticky }), "text-left text-xs font-medium whitespace-nowrap", kind === "actions" && "text-right", className)}
      {...rest}
    >
      {children}
    </th>
  );
}

/** Body cell. */
export function Td({
  priority,
  kind,
  sticky,
  className,
  children,
  ...rest
}: CellOptions & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn(cellClass({ priority, kind, sticky }), className)} {...rest}>
      {children}
    </td>
  );
}

interface RowCtx {
  expanded: boolean;
  toggle: () => void;
  detailsId: string;
  expandBelow: Breakpoint;
}

const RowContext = createContext<RowCtx | null>(null);

const ROW_TONE = {
  default: "bg-surface hover:bg-light-bg",
  // Solid mixes (not /10 alpha) so sticky cells inheriting it stay opaque.
  warning:
    "bg-[color-mix(in_srgb,var(--color-status-warning)_10%,var(--color-surface))] hover:bg-[color-mix(in_srgb,var(--color-status-warning)_16%,var(--color-surface))]",
} as const;

/** Body row. Pass `details` (usually DetailItem elements) to get the
 *  expandable pattern: below `expandBelow` the row is clickable and an
 *  ExpandToggle in the row shows a details row with the hidden columns.
 *  Clicks on links/buttons/inputs inside the row do not toggle it. */
export function DataRow({
  children,
  details,
  expandBelow = "xl",
  tone = "default",
  colSpan,
  className,
}: {
  children: ReactNode;
  details?: ReactNode;
  /** Breakpoint from which all columns are visible (the highest priority used). */
  expandBelow?: Breakpoint;
  tone?: keyof typeof ROW_TONE;
  /** Columns the details row spans. Defaults to the number of cells. */
  colSpan?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const span = colSpan ?? Children.toArray(children).filter(isValidElement).length;

  function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
    if (!details) return;
    const target = e.target as HTMLElement;
    if (target.closest("a,button,input,select,textarea,label,[role=menu],[role=menuitem]")) return;
    if (window.getSelection()?.toString()) return; // user is selecting text
    setExpanded((v) => !v);
  }

  return (
    <RowContext.Provider value={{ expanded, toggle: () => setExpanded((v) => !v), detailsId, expandBelow }}>
      <tr
        onClick={onRowClick}
        className={cn(
          "border-b border-divider transition-colors",
          ROW_TONE[tone],
          details && ROW_CLICKABLE_BELOW[expandBelow],
          expanded && "border-b-0",
          className,
        )}
      >
        {children}
      </tr>
      {details && expanded && (
        <tr id={detailsId} className={cn("border-b border-divider", ROW_TONE[tone], BELOW[expandBelow])}>
          <td colSpan={span} className="px-3 pb-3 pt-0">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-light-bg/70 px-3 py-2.5">
              {details}
            </dl>
          </td>
        </tr>
      )}
    </RowContext.Provider>
  );
}

/** Chevron button that opens/closes the row's details. Must be inside a
 *  DataRow with `details`; renders only below the row's `expandBelow`. */
export function ExpandToggle({ label = "Show more details" }: { label?: string }) {
  const ctx = useContext(RowContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={ctx.toggle}
      aria-expanded={ctx.expanded}
      aria-controls={ctx.expanded ? ctx.detailsId : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-soft-mute hover:bg-light-bg hover:text-charcoal align-middle",
        BELOW[ctx.expandBelow],
      )}
    >
      <ChevronDown size={16} className={cn("transition-transform", ctx.expanded && "rotate-180")} />
    </button>
  );
}

/** One field in the details row. Give it the same priority as its column:
 *  it shows only while that column is hidden, so nothing is duplicated. */
export function DetailItem({
  label,
  priority,
  children,
}: {
  label: ReactNode;
  priority: Exclude<Priority, "always">;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", PRIORITY_DETAIL[priority])}>
      <dt className="text-xs text-soft-mute">{label}</dt>
      <dd className="text-sm text-charcoal break-words">{children}</dd>
    </div>
  );
}

/** Empty-state row spanning the whole table. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="bg-surface">
      <td colSpan={colSpan} className="py-16 text-center text-sm text-soft-mute">
        {children}
      </td>
    </tr>
  );
}
