"use client";

import { useState, useRef, useEffect, useId } from "react";
import { X, Search, CheckCircle2, UserPlus } from "lucide-react";

export interface PickerItem {
  id: string;
  /** Primary display label (display_name or email) */
  label: string;
  /** Secondary label shown below (email when label is display_name) */
  sublabel?: string;
  /** Metadata shown inline (e.g. "Grade 11", "Lincoln HS") */
  meta?: string;
  /** Greyed out "already in" state */
  alreadyIn?: boolean;
  /** Account status for visual marks */
  accountStatus?: "approved" | "pending" | "suspended" | "rejected";
}

export interface PasteSummary {
  queued: string[];
  alreadyIn: string[];
  notFound: string[];
  ambiguous: string[];
  /** Lines that matched exactly one item by partial name (not email/exact name).
   *  Surfaced for user confirmation before being added. */
  partial: string[];
}

export interface SearchablePickerProps {
  items: PickerItem[];
  /** Label for the item type, e.g. "student", "teacher" */
  noun?: string;
  /** Plural of `noun` (defaults to noun + "s") */
  nounPlural?: string;
  /** Tag shown on `alreadyIn` items (defaults to "already in class") */
  alreadyInLabel?: string;
  placeholder?: string;
  onAdd: (ids: string[]) => Promise<{ ok: boolean; error?: string }>;
  loading?: boolean;
}

export default function SearchablePicker({
  items,
  noun = "student",
  nounPlural = `${noun}s`,
  alreadyInLabel = "already in class",
  placeholder,
  onAdd,
  loading = false,
}: SearchablePickerProps) {
  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<PickerItem[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteSummary, setPasteSummary] = useState<PasteSummary | null>(null);

  const chipIds = new Set(chips.map((c) => c.id));

  // Client-side filter: match query against label, sublabel, meta
  const filtered = query.trim().length === 0
    ? items.filter((item) => !chipIds.has(item.id))
    : (() => {
        const q = query.toLowerCase();
        return items.filter(
          (item) =>
            !chipIds.has(item.id) &&
            (item.label.toLowerCase().includes(q) ||
              (item.sublabel?.toLowerCase().includes(q) ?? false) ||
              (item.meta?.toLowerCase().includes(q) ?? false)),
        );
      })();

  // Sort: non-alreadyIn items first, alreadyIn greyed at bottom
  const sorted = [
    ...filtered.filter((i) => !i.alreadyIn),
    ...filtered.filter((i) => i.alreadyIn),
  ];

  // Close dropdown on outside click
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  // Reset active index when sorted list changes
  useEffect(() => {
    setActiveIndex(-1);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>(
        `[data-idx="${activeIndex}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  function selectItem(item: PickerItem) {
    if (item.alreadyIn) return;
    // Suspended accounts may not be added
    if (item.accountStatus === "suspended") return;
    if (chipIds.has(item.id)) {
      setChips((prev) => prev.filter((c) => c.id !== item.id));
    } else {
      setChips((prev) => [...prev, item]);
    }
    setQuery("");
    setActiveIndex(-1);
    // Close dropdown after selection so the Add button is never covered.
    // The user can reopen by focusing the input again.
    setOpen(false);
    inputRef.current?.focus();
  }

  function removeChip(id: string) {
    setChips((prev) => prev.filter((c) => c.id !== id));
  }

  function isDisabledItem(item: PickerItem) {
    return item.alreadyIn || item.accountStatus === "suspended";
  }

  function nextEnabledIndex(from: number, dir: 1 | -1): number {
    let idx = from + dir;
    while (idx >= 0 && idx < sorted.length) {
      if (!isDisabledItem(sorted[idx])) return idx;
      idx += dir;
    }
    return from; // no enabled item in that direction; stay put
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === "Backspace" && query === "" && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((prev) => nextEnabledIndex(prev, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => nextEnabledIndex(prev, -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && sorted[activeIndex]) {
        selectItem(sorted[activeIndex]);
      } else if (chips.length > 0 && !open) {
        void handleAdd();
      }
      return;
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    // Single-line paste: let the browser handle it normally
    if (!text.includes("\n")) return;
    e.preventDefault();

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return;

    const queued: string[] = [];
    const alreadyIn: string[] = [];
    const notFound: string[] = [];
    const ambiguous: string[] = [];
    const partial: string[] = [];
    const toAdd: PickerItem[] = [];

    for (const line of lines) {
      const q = line.toLowerCase();
      // Exact match: full label or email (sublabel) — case-insensitive
      const exactAll = items.filter(
        (item) =>
          item.label.toLowerCase() === q || item.sublabel?.toLowerCase() === q,
      );
      // Prefer exact email match over exact name match to resolve ambiguity.
      const exactEmail = exactAll.filter((item) => item.sublabel?.toLowerCase() === q);
      const exact = exactEmail.length > 0 ? exactEmail : exactAll;

      // Multiple exact matches = truly ambiguous (two people share the same email/name)
      if (exact.length > 1) {
        ambiguous.push(`${line} (${exact.length} matches)`);
        continue;
      }

      if (exact.length === 1) {
        const item = exact[0];
        if (item.alreadyIn) {
          alreadyIn.push(item.label);
        } else if (item.accountStatus === "suspended") {
          notFound.push(`${line} (suspended — cannot add)`);
        } else if (chipIds.has(item.id)) {
          queued.push(item.label);
        } else {
          toAdd.push(item);
          queued.push(item.label);
        }
        continue;
      }

      // No exact match — try substring (partial) match
      const fuzzy = items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.sublabel?.toLowerCase().includes(q) ?? false),
      );

      if (fuzzy.length === 0) {
        notFound.push(line);
      } else if (fuzzy.length > 1) {
        // Multiple partial matches with no exact — ambiguous
        ambiguous.push(`${line} (${fuzzy.length} partial matches)`);
      } else {
        // Single partial match: show as "partial match — confirm" rather than auto-queue
        const item = fuzzy[0];
        if (item.alreadyIn) {
          alreadyIn.push(item.label);
        } else if (item.accountStatus === "suspended") {
          notFound.push(`${line} (suspended — cannot add)`);
        } else {
          // Don't auto-add; surface for user to confirm
          partial.push(`${line} → ${item.label}${item.sublabel ? ` (${item.sublabel})` : ""}`);
        }
      }
    }

    if (toAdd.length > 0) {
      setChips((prev) => {
        const existing = new Set(prev.map((c) => c.id));
        return [...prev, ...toAdd.filter((i) => !existing.has(i.id))];
      });
    }
    setPasteSummary({ queued, alreadyIn, notFound, ambiguous, partial });
    setQuery("");
    setOpen(false);
  }

  async function handleAdd() {
    if (chips.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      const result = await onAdd(chips.map((c) => c.id));
      if (result.ok) {
        setChips([]);
        setPasteSummary(null);
        setQuery("");
      } else {
        setError(result.error ?? "Failed to add");
      }
    } finally {
      setAdding(false);
    }
  }

  const showDropdown = open && sorted.length > 0;

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative">
        {/* Chip + input area */}
        <div
          className={`flex flex-wrap gap-1.5 p-2 bg-surface border rounded-xl transition-colors cursor-text min-h-[44px] items-center ${
            open ? "border-warm-coral/50" : "border-divider"
          }`}
          onMouseDown={(e) => {
            // Only focus the input if clicking the container itself, not a chip
            if (e.target === e.currentTarget) {
              e.preventDefault();
              inputRef.current?.focus();
              setOpen(true);
            }
          }}
        >
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="flex items-center gap-1 pl-2.5 pr-1.5 py-0.5 rounded-full bg-warm-coral/15 text-charcoal text-xs font-medium shrink-0"
            >
              {chip.label}
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  removeChip(chip.id);
                }}
                className="text-soft-mute hover:text-charcoal leading-none"
                aria-label={`Remove ${chip.label}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}

          <div className="relative flex items-center flex-1 min-w-[160px]">
            <Search
              size={13}
              className="absolute left-1.5 text-soft-mute pointer-events-none"
            />
            <input
              ref={inputRef}
              id={`${uid}-input`}
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={showDropdown}
              aria-controls={listboxId}
              aria-activedescendant={
                activeIndex >= 0 ? `${uid}-opt-${activeIndex}` : undefined
              }
              aria-autocomplete="list"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setPasteSummary(null);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                chips.length === 0
                  ? (placeholder ?? `Search ${nounPlural}…`)
                  : ""
              }
              className="w-full pl-6 py-0.5 bg-transparent text-sm text-charcoal placeholder:text-soft-mute focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Dropdown listbox */}
        {showDropdown && (
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={`${noun} search results`}
            className="absolute z-30 mt-1 w-full bg-surface border border-divider rounded-xl shadow-lg max-h-56 overflow-y-auto"
          >
            {sorted.map((item, i) => {
              const isChipped = chipIds.has(item.id);
              const isActive = i === activeIndex;
              return (
                <div
                  key={item.id}
                  id={`${uid}-opt-${i}`}
                  role="option"
                  aria-selected={isChipped}
                  aria-disabled={item.alreadyIn || item.accountStatus === "suspended" ? true : undefined}
                  data-idx={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectItem(item);
                  }}
                  className={`flex items-center gap-3 px-3 py-2 select-none ${
                    item.alreadyIn || item.accountStatus === "suspended"
                      ? "opacity-50 cursor-default"
                      : isActive
                      ? "bg-warm-coral/10 cursor-pointer"
                      : "hover:bg-light-bg cursor-pointer"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm leading-snug">
                      <span
                        className={`font-medium ${item.alreadyIn ? "text-soft-mute" : "text-charcoal"}`}
                      >
                        {item.label}
                      </span>
                      {item.meta && (
                        <span className="text-xs text-soft-mute">
                          · {item.meta}
                        </span>
                      )}
                      {item.alreadyIn && (
                        <span className="text-xs text-soft-mute italic">
                          {alreadyInLabel}
                        </span>
                      )}
                      {item.accountStatus === "pending" && (
                        <span className="text-xs bg-status-warning/10 text-status-warning px-1.5 py-px rounded-full">
                          pending
                        </span>
                      )}
                      {item.accountStatus === "suspended" && (
                        <span className="text-xs bg-charcoal/[0.07] text-charcoal px-1.5 py-px rounded-full">
                          suspended
                        </span>
                      )}
                    </div>
                    {item.sublabel && (
                      <div className="text-xs text-soft-mute truncate">
                        {item.sublabel}
                      </div>
                    )}
                  </div>

                  {isChipped ? (
                    <CheckCircle2 size={14} className="text-warm-coral shrink-0" />
                  ) : !item.alreadyIn ? (
                    <span className="shrink-0 w-4 h-4 rounded-full border border-divider" />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Paste resolution summary */}
      {pasteSummary && (
        <div aria-live="polite" className="rounded-xl bg-light-bg border border-divider p-3 text-xs space-y-1">
          <p className="font-medium text-charcoal">Paste results:</p>
          {pasteSummary.queued.length > 0 && (
            <p className="text-status-success">
              Queued ({pasteSummary.queued.length}):{" "}
              {pasteSummary.queued.join(", ")}
            </p>
          )}
          {pasteSummary.alreadyIn.length > 0 && (
            <p className="text-soft-mute">
              Already in class ({pasteSummary.alreadyIn.length}):{" "}
              {pasteSummary.alreadyIn.join(", ")}
            </p>
          )}
          {pasteSummary.notFound.length > 0 && (
            <p className="text-status-error">
              Not found ({pasteSummary.notFound.length}):{" "}
              {pasteSummary.notFound.join(", ")}
            </p>
          )}
          {pasteSummary.ambiguous.length > 0 && (
            <p className="text-status-warning">
              Ambiguous ({pasteSummary.ambiguous.length}):{" "}
              {pasteSummary.ambiguous.join(", ")}
            </p>
          )}
          {pasteSummary.partial.length > 0 && (
            <p className="text-status-warning">
              Partial match — search to confirm ({pasteSummary.partial.length}):{" "}
              {pasteSummary.partial.join(", ")}
            </p>
          )}
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setPasteSummary(null); }}
            className="text-soft-mute hover:text-charcoal underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Error */}
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}

      {/* Add button */}
      {chips.length > 0 && (
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding || loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-medium text-sm disabled:opacity-60 transition-colors"
        >
          <UserPlus size={14} />
          {adding
            ? "Adding…"
            : `Add ${chips.length} ${chips.length !== 1 ? nounPlural : noun}`}
        </button>
      )}
    </div>
  );
}
