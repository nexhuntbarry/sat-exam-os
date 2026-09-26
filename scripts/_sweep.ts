import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const t = readFileSync(".env.local","utf-8");
for (const l of t.split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^"|"$/g,"");}
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{autoRefreshToken:false,persistSession:false}});
const APPLY = process.argv.includes("--apply");
async function main(){
  const {data}=await db.from("questions").select("id, mismatch_with_official, parsing_notes, explanation, choices, has_image, has_table, image_urls, question_type, original_question_number, module_id").eq("parsing_status","Needs Review");
  const rows=data??[];
  const caveat=/still needs review|incomplete|missing|cut off|truncat|duplicate|same value|blind|no figure|not fully|unclear|ambiguous|cannot|blank|figure\/choices|\bchoices\b|\bfigure\b/i;
  const verified=/verified|answer = official key|explanation matches official|explanation rewritten to match/i;
  const approve:string[]=[];
  for(const q of rows){
    if(q.mismatch_with_official) continue;
    const n=(q.parsing_notes as string|null)??"";
    if(!verified.test(n)) continue;
    if(caveat.test(n)) continue;
    if(!q.explanation || (q.explanation as string).trim().length<20) continue;
    // MCQ must have >=2 choices
    const ch=q.choices as Array<{label:string;text:string}>|null;
    if(q.question_type==="Multiple Choice" && (!Array.isArray(ch)||ch.length<2)) continue;
    // if it needs a figure, require recovered image present
    if((q.has_image||q.has_table) && !(Array.isArray(q.image_urls)&&q.image_urls.length>0)) continue;
    approve.push(q.id);
  }
  console.log(`Candidates to auto-approve: ${approve.length} of ${rows.length} Needs Review`);
  if(APPLY && approve.length){
    // approve in chunks
    for(let i=0;i<approve.length;i+=50){
      const chunk=approve.slice(i,i+50);
      const {error}=await db.from("questions").update({parsing_status:"Approved", reviewed_at:new Date().toISOString()}).in("id",chunk);
      if(error){console.log("ERR",error.message);break;}
    }
    const {count}=await db.from("questions").select("*",{count:"exact",head:true}).eq("parsing_status","Needs Review");
    console.log("APPLIED. Needs Review now:", count);
  } else if(!APPLY){
    console.log("(dry run — pass --apply to execute)");
  }
}
main();
