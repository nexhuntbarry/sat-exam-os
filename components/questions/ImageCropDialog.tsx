"use client";

import { useRef, useState } from "react";

interface Rect { x: number; y: number; w: number; h: number }

/**
 * Drag a box over the image, then Save to get a PNG of just that area at
 * the image's full resolution. The image comes through /api/blob-image
 * (same origin), so the canvas isn't tainted.
 */
export default function ImageCropDialog({
  src,
  onCancel,
  onSave,
  saving,
}: {
  src: string;
  onCancel: () => void;
  onSave: (png: Blob) => void;
  saving: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  function point(e: React.PointerEvent) {
    const box = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - box.left, 0), box.width),
      y: Math.min(Math.max(e.clientY - box.top, 0), box.height),
    };
  }

  function onDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    start.current = point(e);
    setRect({ ...start.current, w: 0, h: 0 });
  }

  function onMove(e: React.PointerEvent) {
    if (!start.current) return;
    const p = point(e);
    const s = start.current;
    setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  }

  function onUp() {
    start.current = null;
  }

  function save() {
    const img = imgRef.current;
    if (!img || !rect) return;
    const box = img.getBoundingClientRect();
    const sx = img.naturalWidth / box.width;
    const sy = img.naturalHeight / box.height;
    const w = Math.max(1, Math.round(rect.w * sx));
    const h = Math.max(1, Math.round(rect.h * sy));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, Math.round(rect.x * sx), Math.round(rect.y * sy), w, h, 0, 0, w, h);
    canvas.toBlob((b) => b && onSave(b), "image/png");
  }

  const ready = rect && rect.w > 8 && rect.h > 8;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-label="Crop image">
      <div className="bg-surface rounded-2xl p-4 max-w-4xl w-full max-h-full overflow-auto space-y-3">
        <div className="text-sm text-charcoal font-medium">Drag a box around the part to keep</div>
        <div className="relative inline-block select-none touch-none">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={src}
            alt="Image to crop"
            draggable={false}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            className="max-w-full max-h-[70vh] cursor-crosshair border border-divider bg-white"
          />
          {rect && (
            <div
              className="absolute border-2 border-warm-coral bg-warm-coral/10 pointer-events-none"
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            />
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={saving} className="px-3 py-1.5 rounded-lg text-sm text-mid-gray hover:text-charcoal">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!ready || saving}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-warm-coral text-white disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
