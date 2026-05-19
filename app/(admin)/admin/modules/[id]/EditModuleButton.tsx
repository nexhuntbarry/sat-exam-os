"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";

interface ModuleData {
  id: string;
  module_name: string;
  section: "Math" | "Reading & Writing" | string;
  module_number: number | null;
  difficulty: "Easy" | "Medium" | "Hard" | "Mixed" | null | string;
  source_name: string | null;
  version: string | null;
}

export default function EditModuleButton({ mod }: { mod: ModuleData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(mod.module_name);
  const [section, setSection] = useState(mod.section);
  const [num, setNum] = useState<number | "">(mod.module_number ?? "");
  const [diff, setDiff] = useState(mod.difficulty ?? "");
  const [source, setSource] = useState(mod.source_name ?? "");
  const [version, setVersion] = useState(mod.version ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/modules/${mod.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleName: name,
          section,
          moduleNumber: num === "" ? null : Number(num),
          difficulty: diff === "" ? null : diff,
          sourceName: source.trim() === "" ? null : source.trim(),
          version: version.trim() === "" ? null : version.trim(),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Failed");
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-light-bg hover:bg-divider text-charcoal text-xs font-medium"
      >
        <Pencil size={13} />
        Edit
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
              <h3 className="text-charcoal font-semibold">Edit module</h3>
              <button
                onClick={() => setOpen(false)}
                className="text-soft-mute hover:text-charcoal"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <Field label="Module name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input"
                  placeholder="e.g. Math · Module 1 · Mixed"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Section">
                  <select
                    value={section}
                    onChange={(e) => setSection(e.target.value)}
                    className="input"
                  >
                    <option value="Math">Math</option>
                    <option value="Reading & Writing">Reading &amp; Writing</option>
                  </select>
                </Field>
                <Field label="Module #">
                  <select
                    value={num === "" ? "" : String(num)}
                    onChange={(e) =>
                      setNum(e.target.value === "" ? "" : (Number(e.target.value) as 1 | 2))
                    }
                    className="input"
                  >
                    <option value="">—</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                  </select>
                </Field>
              </div>
              <Field label="Difficulty">
                <select
                  value={diff}
                  onChange={(e) => setDiff(e.target.value)}
                  className="input"
                >
                  <option value="">—</option>
                  <option value="Easy">Easy</option>
                  <option value="Medium">Medium</option>
                  <option value="Hard">Hard</option>
                  <option value="Mixed">Mixed</option>
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Source">
                  <input
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    className="input"
                    placeholder="e.g. CB Practice 8"
                  />
                </Field>
                <Field label="Version">
                  <input
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    className="input"
                    placeholder="e.g. 2024"
                  />
                </Field>
              </div>
              {error && <p className="text-status-error text-sm">{error}</p>}
            </div>
            <div className="px-5 py-3 border-t border-divider flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-divider text-mid-gray text-sm hover:text-charcoal"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy || !name.trim()}
                className="px-4 py-1.5 rounded-lg bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-40"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
      <style jsx global>{`
        .input {
          width: 100%;
          padding: 0.5rem 0.875rem;
          border-radius: 0.625rem;
          background: var(--color-bg);
          border: 1px solid var(--color-divider);
          color: var(--color-charcoal);
          outline: none;
          font-size: 0.875rem;
        }
        .input:focus { border-color: rgb(240 82 61 / 0.6); }
      `}</style>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-mid-gray text-xs font-medium">{label}</label>
      {children}
    </div>
  );
}
