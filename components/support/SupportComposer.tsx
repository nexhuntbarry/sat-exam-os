"use client";

import { useEffect, useMemo, useState } from "react";
import { ImagePlus, X } from "lucide-react";

/**
 * Text box + screenshot picker (click, or paste an image). Posts multipart
 * (`field` + `screenshots`) to `url`. Shared by /admin/support ("New report",
 * "Add a message") and the question page's "Report to dev" box.
 */
export default function SupportComposer({
  url,
  placeholder,
  button,
  onDone,
  field = "body",
  optional = false,
  autoFocus = false,
}: {
  url: string;
  placeholder: string;
  button: string;
  /** Called with the response JSON after a successful send. */
  onDone: (data: Record<string, unknown>) => void;
  /** Multipart field name for the text. */
  field?: string;
  /** The text may be left empty. */
  optional?: boolean;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p)), [previews]);

  const addFiles = (list: FileList | File[]) => {
    // Copy now: the input's FileList is cleared right after this call.
    const picked = Array.from(list).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...picked].slice(0, 6));
  };

  async function send() {
    if (!optional && !body.trim()) return setError("Please describe the problem.");
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.set(field, body.trim());
      files.forEach((f) => fd.append("screenshots", f));
      const res = await fetch(url, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error ?? data.message ?? `Error ${res.status}`);
      setBody("");
      setFiles([]);
      onDone(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
        onPaste={(e) => {
          const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
          if (imgs.length) {
            e.preventDefault();
            addFiles(imgs);
          }
        }}
        placeholder={placeholder}
        rows={4}
        className="w-full rounded-lg border border-divider bg-surface px-3 py-2 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-warm-coral/40"
      />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previews[i]} alt={f.name} className="h-20 w-20 object-cover rounded-md border border-divider" />
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 bg-charcoal text-white rounded-full p-0.5"
                aria-label="Remove screenshot"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-light-bg hover:bg-divider text-charcoal cursor-pointer">
          <ImagePlus size={15} /> Add screenshots
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <span className="text-xs text-soft-mute">or paste an image into the box (up to 6)</span>
        <button
          onClick={send}
          disabled={busy}
          className="ml-auto px-4 py-1.5 rounded-lg text-sm font-medium bg-warm-coral text-white hover:bg-warm-coral-dark disabled:opacity-50"
        >
          {busy ? "Sending..." : button}
        </button>
      </div>
      {error && <p className="text-sm text-status-error">{error}</p>}
    </div>
  );
}
