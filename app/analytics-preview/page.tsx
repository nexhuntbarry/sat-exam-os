import { getServiceClient } from "@/lib/supabase";
import { clsx } from "clsx";
import { formatDate } from "@/lib/datetime";
const statusStyles: Record<string,string> = { pending:"bg-light-bg text-mid-gray", parsing:"bg-status-warning/15 text-status-warning", parsed:"bg-warm-coral/15 text-warm-coral", approved:"bg-warm-amber/15 text-warm-amber", failed:"bg-status-error/15 text-status-error" };
function titleColor(s: string|null){ if(s==="Math")return "text-blue-600"; if(s==="Reading & Writing")return "text-red-600"; return "text-charcoal"; }
export default async function Preview(){
  const db=getServiceClient();
  const { data }=await db.from("modules").select("id, module_name, section, module_number, difficulty, total_questions, parsing_status, created_at");
  const mods=(data??[]).sort((a,b)=>a.module_name.toLowerCase().localeCompare(b.module_name.toLowerCase()));
  return (
    <div className="min-h-screen bg-cream text-charcoal p-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="text-xs uppercase tracking-wide text-warm-coral font-semibold">Preview</div>
        <h1 className="text-2xl font-bold">Modules — sorted A→Z, colored by section</h1>
        <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-divider text-soft-mute">
              <th className="text-left px-5 py-3 font-medium">Module ↑</th><th className="text-left px-5 py-3 font-medium">Section</th><th className="text-left px-5 py-3 font-medium">Difficulty</th><th className="text-left px-5 py-3 font-medium">Questions</th><th className="text-left px-5 py-3 font-medium">Status</th><th className="text-left px-5 py-3 font-medium">Uploaded</th>
            </tr></thead>
            <tbody>{mods.map(m=>(
              <tr key={m.id} className="border-b border-divider last:border-0">
                <td className="px-5 py-3"><div className={clsx("font-medium",titleColor(m.section))}>{m.module_name}</div></td>
                <td className="px-5 py-3 text-mid-gray">{m.section}{m.module_number?` · M${m.module_number}`:""}</td>
                <td className="px-5 py-3 text-mid-gray">{m.difficulty??"—"}</td>
                <td className="px-5 py-3 text-mid-gray">{m.total_questions}</td>
                <td className="px-5 py-3"><span className={clsx("px-2 py-1 rounded-full text-xs font-medium capitalize",statusStyles[m.parsing_status]??"bg-light-bg text-mid-gray")}>{m.parsing_status}</span></td>
                <td className="px-5 py-3 text-soft-mute text-xs">{formatDate(m.created_at)}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
