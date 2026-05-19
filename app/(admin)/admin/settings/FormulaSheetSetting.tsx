"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { formatDateTime } from "@/lib/datetime";

interface Props {
  initialUrl: string | null;
  initialUpdatedAt: string | null;
}

export default function FormulaSheetSetting({ initialUrl, initialUpdatedAt }: Props) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/settings/formula-sheet", {
        method: "POST",
        body: fd,
      });
      const text = await res.text();
      let json: { url?: string; error?: string };
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON response usually means an unhandled 500 from the
        // framework. Show a hint about the most likely cause.
        throw new Error(
          `Upload failed (${res.status}): ${text.slice(0, 200) || "no response body"}`,
        );
      }
      if (!res.ok || !json.url) {
        throw new Error(json.error ?? "Upload failed");
      }
      setUrl(json.url);
      setUpdatedAt(new Date().toISOString());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Remove the global Math formula sheet? Math tests will no longer show one.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/formula-sheet", {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Failed to remove");
      }
      setUrl(null);
      setUpdatedAt(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-surface border border-divider rounded-2xl p-6 space-y-4">
      <div className="flex items-start gap-3">
        <ImageIcon size={18} className="text-warm-coral mt-0.5 shrink-0" />
        <div className="flex-1">
          <h2 className="text-charcoal font-semibold">Math formula reference sheet</h2>
          <p className="text-soft-mute text-xs mt-1 leading-relaxed">
            Single image (PNG/JPG). Every Math test&rsquo;s take page exposes this in the
            Reference side panel. Re-upload to replace it; the new version applies to all
            tests immediately. Reading &amp; Writing tests ignore this.
          </p>
        </div>
      </div>

      {url ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-divider bg-light-bg overflow-hidden">
            <img
              src={
                // Blob store is private; <img> reaches it via the
                // authenticated proxy.
                url.includes(".blob.vercel-storage.com")
                  ? `/api/blob-image?u=${encodeURIComponent(url)}`
                  : url
              }
              alt="Current Math formula reference sheet"
              className="w-full h-auto max-h-96 object-contain bg-white"
            />
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-soft-mute">
            <span>
              Updated {formatDateTime(updatedAt)}
            </span>
            <button
              onClick={remove}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-status-error hover:bg-status-error/10 text-xs font-medium disabled:opacity-50"
            >
              <Trash2 size={12} /> Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-divider bg-light-bg/40 p-6 text-center text-soft-mute text-sm">
          No formula sheet configured. Upload one below to enable the Reference panel on
          Math tests.
        </div>
      )}

      <label className="block">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm cursor-pointer transition-colors disabled:opacity-50">
          <Upload size={14} />
          {busy ? "Uploading…" : url ? "Replace formula sheet" : "Upload formula sheet"}
        </div>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
          className="hidden"
        />
      </label>

      {error && (
        <p className="text-status-error text-xs">{error}</p>
      )}
    </section>
  );
}
