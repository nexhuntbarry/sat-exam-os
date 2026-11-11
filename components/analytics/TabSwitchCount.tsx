import { TAB_SWITCH_HELP, TAB_SWITCH_WARN_AT } from "@/lib/tab-switches";

/** "Left tab" count; warning colour at TAB_SWITCH_WARN_AT or more. */
export function TabSwitchCount({ count }: { count: number | null }) {
  if (count == null) return <span className="text-soft-mute">—</span>;
  const warn = count >= TAB_SWITCH_WARN_AT;
  return (
    <span
      className={warn ? "font-semibold text-status-warning" : "text-mid-gray"}
      title={`${count} time${count === 1 ? "" : "s"}. ${TAB_SWITCH_HELP}`}
    >
      {count}
    </span>
  );
}

/** Column header with the explanation as a tooltip. */
export function TabSwitchHeader() {
  return (
    <span title={TAB_SWITCH_HELP} className="cursor-help underline decoration-dotted underline-offset-2">
      Left tab
    </span>
  );
}
