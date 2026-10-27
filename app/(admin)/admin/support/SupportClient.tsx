"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, X } from "lucide-react";
import { formatDateTime } from "@/lib/datetime";
import { STATUS_LABEL, type SupportRow, type SupportStatus } from "@/lib/support-shared";

const PILL: Record<SupportStatus, string> = {
  new: "bg-status-warning/15 text-status-warning",
  in_progress: "bg-warm-coral/15 text-warm-coral-text",
  needs_approval: "bg-warm-amber/15 text-warm-amber",
  fixed: "bg-status-success/15 text-status-success",
  declined: "bg-light-bg text-mid-gray",
};

/** Text box + screenshot picker (click, or paste an image). Posts multipart to `url`. */
function Composer({ url, placeholder, button, onDone }: {
  url: string;
  placeholder: string;
  button: string;
  onDone: () => void;
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
    if (!body.trim()) return setError("Please describe the problem.");
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.set("body", body.trim());
      files.forEach((f) => fd.append("screenshots", f));
      const res = await fetch(url, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setBody("");
      setFiles([]);
      onDone();
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

export default function SupportClient({ requests }: { requests: SupportRow[] }) {
  const router = useRouter();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // Pick up dev replies without a manual reload.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(t);
  }, [router]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-divider bg-surface p-4">
        <h2 className="text-sm font-semibold text-charcoal mb-2">New report</h2>
        <Composer
          url="/api/admin/support"
          placeholder="What happened? Who hit it (student / teacher), on which page or test, and what did they expect?"
          button="Send report"
          onDone={() => router.refresh()}
        />
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-charcoal">Your reports</h2>
        {requests.length === 0 && <p className="text-sm text-soft-mute">No reports yet.</p>}
        {requests.map((r) => (
          <div key={r.id} id={r.id} className="rounded-xl border border-divider bg-surface p-4 space-y-3 scroll-mt-20">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-soft-mute">{formatDateTime(r.created_at)}</span>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PILL[r.payload.status]}`}>
                {STATUS_LABEL[r.payload.status]}
              </span>
            </div>
            {r.payload.messages.map((m, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-sm ${m.from === "dev" ? "bg-warm-coral/5 border border-warm-coral/15" : "bg-light-bg"}`}
              >
                <div className="text-[11px] text-soft-mute mb-1">
                  {m.from === "dev" ? "Dev team" : "You"} · {formatDateTime(m.at)}
                </div>
                <div className="whitespace-pre-wrap text-charcoal">{m.body}</div>
                {m.screenshots && m.screenshots.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {m.screenshots.map((u) => {
                      const src = `/api/blob-image?u=${encodeURIComponent(u)}`;
                      return (
                        <a key={u} href={src} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt="Screenshot" className="h-24 rounded-md border border-divider" />
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {replyingTo === r.id ? (
              <Composer
                url={`/api/admin/support/${r.id}`}
                placeholder="Add more details, or tell us if it's still happening"
                button="Send"
                onDone={() => {
                  setReplyingTo(null);
                  router.refresh();
                }}
              />
            ) : (
              <button onClick={() => setReplyingTo(r.id)} className="text-sm text-warm-coral-text hover:underline">
                Add a message
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
