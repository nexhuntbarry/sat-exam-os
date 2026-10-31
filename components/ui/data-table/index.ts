// Site-wide table kit. Rules and usage: docs/table-standard.md.
// Reference implementation: app/(admin)/admin/students/StudentsClient.tsx.
export {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  ExpandToggle,
  DetailItem,
  EmptyRow,
  type Priority,
  type Kind,
  type Breakpoint,
} from "./DataTable";
export { TwoLineCell, TruncatedText } from "./cells";
export { RowActionsMenu, type RowAction } from "./RowActionsMenu";
export { RowButton, RowActions } from "./RowButton";
export { ColumnsPicker, useColumnPrefs, type ColumnDef, type ColumnPrefs } from "./ColumnsPicker";
export { cn } from "./cn";
