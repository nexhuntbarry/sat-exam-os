"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

// One stored highlight inside a single annotatable container. start/end
// are character offsets into the container's plain textContent — robust
// across re-renders since textContent is stable as long as the question
// text doesn't change between session loads. `note` is optional free
// text the student attached to the highlight.
export interface Annotation {
  start: number;
  end: number;
  note?: string;
}

interface Props {
  /**
   * Stable identifier for this annotatable region within a question
   * (e.g. "stem", "choice:A", "passage"). Used as the key inside the
   * per-question annotations map so highlights re-bind to the right
   * block when the same question renders again.
   */
  anchor: string;
  /** Existing annotations for this anchor, in any order. */
  annotations: Annotation[];
  /** Replace the full annotation list for this anchor. */
  onChange?: (next: Annotation[]) => void;
  /**
   * When false the block renders highlights but no edit UX (no
   * mouseup → tooltip, no edit/delete in note popover). Used for
   * teacher review and any read-only display.
   */
  enabled: boolean;
  children: React.ReactNode;
  className?: string;
}

const HIGHLIGHT_CLASS = "satos-highlight";

// Walk text nodes inside `root`, accumulating their lengths until we
// reach `target`/`offset`. Returns the equivalent character offset
// inside the concatenated textContent.
function nodeOffsetToCharOffset(root: Node, target: Node, offset: number): number {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === target) return total + offset;
    total += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  return total;
}

// Inverse: given a char offset, find the text node + offset inside it.
function charOffsetToNodeOffset(
  root: Node,
  charOffset: number,
): { node: Node; offset: number } | null {
  let remaining = charOffset;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    node = walker.nextNode();
  }
  return null;
}

export default function HighlightableBlock({
  anchor,
  annotations,
  onChange,
  enabled,
  children,
  className,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    start: number;
    end: number;
  } | null>(null);
  const [viewer, setViewer] = useState<{
    x: number;
    y: number;
    idx: number;
    draft: string;
    editing: boolean;
  } | null>(null);

  // Re-apply highlights to the rendered DOM by wrapping spans of text
  // in <mark>. We always tear down our old marks first so re-renders
  // don't double-wrap and so removed annotations actually disappear.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`).forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });

    annotations.forEach((a, idx) => {
      try {
        const startLoc = charOffsetToNodeOffset(root, a.start);
        const endLoc = charOffsetToNodeOffset(root, a.end);
        if (!startLoc || !endLoc) return;
        const range = document.createRange();
        range.setStart(startLoc.node, startLoc.offset);
        range.setEnd(endLoc.node, endLoc.offset);
        const mark = document.createElement("mark");
        mark.className = HIGHLIGHT_CLASS;
        mark.dataset.annoIdx = String(idx);
        if (a.note) mark.classList.add("has-note");
        try {
          range.surroundContents(mark);
        } catch {
          const frag = range.extractContents();
          mark.appendChild(frag);
          range.insertNode(mark);
        }
      } catch {
        // Stale offset — skip.
      }
    });
  }, [annotations]);

  // Capture mouseup → if a real selection landed inside the block,
  // pop a one-row toolbar near the selection.
  useEffect(() => {
    if (!enabled) return;
    const root = ref.current;
    if (!root) return;

    function handleUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root || !root.contains(range.commonAncestorContainer)) {
        setMenu(null);
        return;
      }
      const start = nodeOffsetToCharOffset(root, range.startContainer, range.startOffset);
      const end = nodeOffsetToCharOffset(root, range.endContainer, range.endOffset);
      const [s, e] = start < end ? [start, end] : [end, start];
      if (e - s < 1) {
        setMenu(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setMenu({
        x: rect.left + rect.width / 2,
        y: rect.top - 8,
        start: s,
        end: e,
      });
    }

    function handleDown(ev: MouseEvent) {
      const target = ev.target as Node;
      if (!root) return;
      const tooltip = document.getElementById(`satos-anno-tooltip-${anchor}`);
      if (tooltip?.contains(target)) return;
      // Click on existing mark is handled below; don't dismiss menu so
      // viewer can open without race.
      const t = ev.target as HTMLElement;
      const onMark = t?.closest && t.closest(`mark.${HIGHLIGHT_CLASS}`);
      if (onMark) return;
      setMenu(null);
    }

    document.addEventListener("mouseup", handleUp);
    document.addEventListener("mousedown", handleDown);
    return () => {
      document.removeEventListener("mouseup", handleUp);
      document.removeEventListener("mousedown", handleDown);
    };
  }, [enabled, anchor]);

  // Click on an existing highlight opens the note viewer/editor. We
  // attach to the container so DOM-rebuilt marks stay clickable.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      const m = t.closest && (t.closest(`mark.${HIGHLIGHT_CLASS}`) as HTMLElement | null);
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(m.dataset.annoIdx);
      if (Number.isNaN(idx)) return;
      const a = annotations[idx];
      if (!a) return;
      const rect = m.getBoundingClientRect();
      setViewer({
        x: rect.left + rect.width / 2,
        y: rect.bottom + 6,
        idx,
        draft: a.note ?? "",
        editing: !a.note && enabled,
      });
    }
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [annotations, enabled]);

  function applyHighlight(opts: { withNote?: string }) {
    if (!menu || !onChange) return;
    const merged = annotations.filter((a) => a.end <= menu.start || a.start >= menu.end);
    onChange([
      ...merged,
      { start: menu.start, end: menu.end, note: opts.withNote || undefined },
    ]);
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  }

  function eraseAcrossSelection() {
    if (!menu || !onChange) return;
    onChange(annotations.filter((a) => a.end <= menu.start || a.start >= menu.end));
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  }

  function saveViewerNote() {
    if (!viewer || !onChange) return;
    const next = annotations.slice();
    const a = next[viewer.idx];
    if (!a) return;
    next[viewer.idx] = { ...a, note: viewer.draft.trim() || undefined };
    onChange(next);
    setViewer(null);
  }

  function deleteFromViewer() {
    if (!viewer || !onChange) return;
    onChange(annotations.filter((_, i) => i !== viewer.idx));
    setViewer(null);
  }

  return (
    <>
      <div ref={ref} className={className} data-anchor={anchor}>
        {children}
      </div>

      {/* Selection toolbar — Highlight / Erase only. Notes attach to an
          existing highlight via the viewer popover (click the yellow). */}
      {enabled && menu && (
        <div
          id={`satos-anno-tooltip-${anchor}`}
          className="fixed z-50 -translate-x-1/2 -translate-y-full"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="flex items-center gap-1 bg-charcoal text-cream rounded-lg shadow-lg px-1 py-0.5 text-xs">
            <button
              onClick={() => applyHighlight({})}
              className="px-2 py-1 rounded hover:bg-warm-coral/30 font-semibold"
              title="Highlight selection"
            >
              Highlight
            </button>
            <span className="w-px h-4 bg-cream/20" />
            <button
              onClick={eraseAcrossSelection}
              className="px-2 py-1 rounded hover:bg-status-error/30"
              title="Erase any highlight under this selection"
            >
              Erase
            </button>
          </div>
        </div>
      )}

      {/* Note viewer / editor for an existing highlight */}
      {viewer && (
        <div
          className="fixed z-50 -translate-x-1/2"
          style={{ left: viewer.x, top: viewer.y }}
        >
          <div className="bg-surface border border-divider rounded-lg shadow-lg p-3 w-64 space-y-2">
            {viewer.editing ? (
              <>
                <textarea
                  autoFocus
                  rows={3}
                  value={viewer.draft}
                  onChange={(e) =>
                    setViewer((prev) => (prev ? { ...prev, draft: e.target.value } : prev))
                  }
                  placeholder="Add a note for this highlight…"
                  className="w-full text-xs text-charcoal bg-light-bg border border-divider rounded px-2 py-1.5 focus:outline-none focus:border-warm-coral/60"
                />
                <div className="flex items-center justify-between gap-2">
                  {enabled && (
                    <button
                      onClick={deleteFromViewer}
                      className="text-xs text-status-error inline-flex items-center gap-1 hover:underline"
                    >
                      <Trash2 size={11} /> Remove highlight
                    </button>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setViewer(null)}
                      className="text-xs text-soft-mute hover:text-charcoal px-2 py-1"
                    >
                      Close
                    </button>
                    <button
                      onClick={saveViewerNote}
                      className="text-xs bg-warm-coral text-white font-semibold px-3 py-1 rounded hover:bg-warm-coral-dark"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-charcoal whitespace-pre-wrap">
                  {viewer.draft || (
                    <span className="text-soft-mute italic">No note attached.</span>
                  )}
                </p>
                <div className="flex items-center justify-between gap-2">
                  {enabled && (
                    <button
                      onClick={deleteFromViewer}
                      className="text-xs text-status-error inline-flex items-center gap-1 hover:underline"
                    >
                      <Trash2 size={11} /> Remove
                    </button>
                  )}
                  <div className="flex gap-2 ml-auto">
                    <button
                      onClick={() => setViewer(null)}
                      className="text-xs text-soft-mute hover:text-charcoal px-2 py-1"
                    >
                      Close
                    </button>
                    {enabled && (
                      <button
                        onClick={() => setViewer((prev) => (prev ? { ...prev, editing: true } : prev))}
                        className="text-xs bg-warm-coral text-white font-semibold px-3 py-1 rounded hover:bg-warm-coral-dark"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
