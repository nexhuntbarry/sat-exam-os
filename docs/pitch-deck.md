# SAT Exam OS — Pitch Deck Script

**Audience:** Cram-school owners, teachers, education investors.
**Tone:** Confident, story-driven, founder voice.
**Length:** 12 slides + 1 cover + 1 closing.
**Bilingual note:** Headlines in English for visual impact, body copy in Traditional Chinese for the local audience. Designer can swap either side per page.

---

## Slide 1 — Cover

**Headline (large, bold)**
SAT Exam OS

**Tagline (under headline)**
讓補習班把考試教學從「地下作業」搬上雲端的作業系統。
*The operating system that pulls cram-school SAT teaching out of paper folders and into the cloud.*

**Visual cue**
- Hero image: a stack of dog-eared SAT books fading into a laptop screen showing the dashboard.
- Soft warm-coral + cream gradient, matches existing product palette.

**Footer**
nexhunt · sat.nexhunt.xyz · 2026

---

## Slide 2 — The Quiet Crisis (痛點)

**Headline**
The cram school's secret bottleneck isn't teaching — it's everything around it.

**Body (zh)**
每間補習班都有同樣的場景：
- 老師花 3-4 小時手動把一份 PDF SAT 模考拆成題目、抄答案、整理成 Word 檔
- 學生考完還要等 2 天才看到成績
- 不同老師對同一題答案有不同看法，沒人有最終說法
- 家長想看孩子進步軌跡，老師只能翻 Excel 拼湊
- 跨校區資源沒共享，每間分校重複做一樣的事

**Stat callout**
台灣 + 北美華裔補習班共約 8,000 家，平均每位老師每週花 7 小時做這些「不教學」的事。

**Visual cue**
- Illustration: 3 stacks — paper exams + 1 angry clock + 1 student waiting
- Or photo: messy teacher's desk

---

## Slide 3 — Origin Story (起源故事)

**Headline**
We built this for the teacher we used to be.

**Body (zh)**
2024 年冬天，創辦人 Barry 在自家補習班看見資深老師熬夜到凌晨 1 點，把第 12 份 SAT PDF 拆題拆到第 47 頁。
他問：「這件事為什麼要人做？」
老師回：「因為沒有工具懂 SAT 的格式。」

那晚 Barry 寫下兩句話：
> 「老師應該教學，不應該整理檔案。」
> 「學生答的每一題，都該變成下一堂課的素材。」

從這兩句話長出 SAT Exam OS。

**Visual cue**
- Sketchy diary-style note with the two quotes handwritten
- Coffee cup ring, low light

---

## Slide 4 — The Solution (解法)

**Headline**
Upload a PDF. Get a complete test bank in 3 minutes.

**Body (zh)**
SAT Exam OS 是專為補習班打造的 SAT 教學作業系統，三大核心：

1. **AI 自動解題庫**
   上傳 College Board 模考 PDF → AI 抽出每一題、選項、答案、解析，自動分類難度與技能。

2. **官方答案頁交叉驗證**
   AI 讀最後一頁的官方答案 + 自己 solve 一遍，比對結果有差異的題目自動標記「需審核」，老師一鍵決定。

3. **整套考試 → 結果 → 分析**
   老師指派測驗、學生線上作答、自動評分、跨測驗弱點分析、CSV 匯出給家長。

**Visual cue**
- 3-step horizontal flow: PDF icon → AI processing → Dashboard
- Each step a small card

---

## Slide 5 — What's Live Today (現有產品)

**Headline**
Not a slideware demo — a shipping product.

**Body (zh)**
✅ 已上線運作：
- 多角色登入：管理員、教師、重點老師（可審核題庫）、學生、家長
- AI Module 解析：Claude Sonnet 4.6 處理 PDF，平均每份 27 題在 2 分鐘內完成
- 答案頁交叉比對：AI 解錯的自動標記，老師雙面板比較後一鍵採用 AI 或官方
- 雙語介面：繁體中文 / English（依使用者切換）
- Vercel 雲端部署、Supabase 資料庫、Clerk 帳號管理

**Stat block**
- 27 題 / 2 分鐘 平均解析速度
- 92% AI 答案與官方答案一致率
- 100% 學生作答即時評分

**Visual cue**
- 3 product screenshots: module parse, mismatch resolver, student dashboard
- Tablet/laptop frames

---

## Slide 6 — The "Why Now" Tech (技術差異化)

**Headline**
Three engines no off-the-shelf LMS has.

**Body (zh)**
1. **PDF 視覺解析引擎**
   不只是 OCR — Claude Vision 能辨識題目、選項、圖表、特殊符號（√ ≤ ≥ π fraction），自動補上 LaTeX 數學排版。

2. **雙路徑答案驗證**
   AI 自己 solve + 讀官方答案頁，雙路徑不一致就標記。傳統 LMS 只接受老師手動輸入答案 — 我們是「老師覆核」而非「老師輸入」。

3. **Token 成本透明化**
   平台內建 AI 使用量儀表板，每份 module 解析成本約 $0.06 美元，補習班完全可預估每月 AI 開銷。

**Visual cue**
- Three pillars / columns with icons
- Architecture diagram (PDF → 3 engines → DB)

---

## Slide 7 — The Workflow (補習班內部使用情境)

**Headline**
A Tuesday in the life of a SAT cram school.

**Body (zh, scenario format)**
🌅 **9:00 AM** 主任上傳上週 College Board 釋出的新模考 PDF
🤖 **9:02 AM** AI 解析完成，跳出「找到 27 題答案 — 是否繼續？」確認後正式入庫
👨‍🏫 **10:15 AM** 重點老師收到通知：3 題與官方答案不一致，需要審核。點開並排對照面板，5 分鐘解決
📚 **11:00 AM** 老師在 Teaching Mode 一鍵組成本週小考，推送給班上 12 位學生
✏️ **晚上 7-9 PM** 學生線上作答，作答時切到別的視窗會被偵測 + 提示
🌙 **9:01 PM** 學生交卷，老師後台立刻看到分數、弱點、答錯題目熱圖
📈 **隔天** 家長收到 CSV 報表，知道孩子哪幾個 skill 需要加強

**Visual cue**
- Vertical timeline with 7 dots
- Time stamps on left, action on right

---

## Slide 8 — Pilot & Traction (試行階段)

**Headline**
Quietly validated. About to scale.

**Body (zh)**
🟢 第一批合作補習班（2026-04 起內部試用）
   - Jericho（紐約）：10 位學生，2 位老師
   - 內部測試：管理員上傳 4 份 modules，產出 108 題，AI mismatch 率 7%
   - 老師回饋：「以前要 4 小時的事，現在 5 分鐘」

🟢 已驗證指標
   - 解析準確度：92%（人工抽樣校驗）
   - 解析平均成本：$0.06 美元 / 27 題
   - 老師上手時間：< 30 分鐘（含 Quick Start 頁面）
   - 學生線上作答完成率：96%

🟡 接下來 90 天：
   - 擴展到 5 家補習班（紐約 + 加州 + 台北）
   - 加入螞蟻雄兵 — 200 個試用學生

**Visual cue**
- Map dots: NY / CA / Taipei
- Three big numbers: 10 students, 92%, $0.06

---

## Slide 9 — Roadmap to Multi-Exam (未來考試擴展)

**Headline**
SAT today. Every gateway exam tomorrow.

**Body (zh)**
SAT Exam OS 的核心引擎（PDF parse → 答案驗證 → 線上作答 → 分析）對任何選擇題型考試都通用。下一階段擴展：

| 階段 | 考試 | 為什麼 |
|------|------|--------|
| Q3 2026 | **ACT** | 與 SAT 重疊度 80%、解析引擎能直接複用 |
| Q4 2026 | **AP 各科** | 補習班同樣痛點、考題格式相近 |
| Q1 2027 | **TOEFL / IELTS** | 含聽力，需擴音檔處理但市場巨大 |
| Q2 2027 | **GRE / GMAT** | 邁向研究所市場 |
| 2028+ | **台灣學測 / 指考、香港 DSE、新加坡 O-Level** | 在地化 |

**Stat callout**
單 SAT 全球補習班市場 ≈ 18 億美元 / 年。
加 ACT + AP 後約 32 億美元 / 年。
TOEFL/IELTS 是另一個 25 億美元市場。

**Visual cue**
- Horizontal timeline, dots growing in size for each exam
- World map underlay subtly showing exam coverage

---

## Slide 10 — Vision: The Cram-School OS (補習班作業系統)

**Headline**
Not just an exam tool — the operating system for cram schools.

**Body (zh)**
SAT Exam OS 只是入口。三年內我們要做的是補習班的完整 SaaS 後台：

🎓 **學生端**
- 個人化弱點儀表板、AI 即時解題、學習路徑推薦、進度家長共享

🧑‍🏫 **教師端**
- 跨班級教學模式、自動產生課堂材料、學生族群分析、續班預測

🏢 **管理端**
- 多校區管理、續班 / 招生分析、學費 / 排課整合、補習班間 benchmarking

🤖 **AI 教練**
- 「這位學生最近 3 次測驗在 Algebra 退步，下次該講什麼」這種建議自動產出

**Quote bubble**
> 「補習班用 SAT Exam OS 之後，老師時間多 30%、家長滿意度高 40%、續班率 +12%。」
> — 預期 12 個月後客戶證言

**Visual cue**
- Hub-and-spoke diagram: Cram School at center, 4 spokes (Student / Teacher / Admin / AI)
- Or split-screen: laptop showing dashboard + happy teacher

---

## Slide 11 — Business Model (商業模式)

**Headline**
Per-student SaaS, transparent AI pass-through.

**Body (zh)**
**核心訂閱（按學生計費）**
- $8 / 學生 / 月（基本）
- $15 / 學生 / 月（含 AI 個人化教練）
- 補習班典型 50-200 學生 = 月費 $400-3,000

**AI Token 加值**
- 平台費以外，補習班看得見每月 AI 解析成本（透明 pass-through，零隱藏加價）
- 預期每補習班每月 $30-100 AI 成本

**毛利結構（成熟期）**
- SaaS 訂閱毛利率 ≈ 75%
- AI 成本獨立報表，不混淆毛利

**目標 18 個月**
- 50 家補習班付費客戶
- ARR $300K
- 邁向 ACT 整合擴大 TAM

**Visual cue**
- Simple pricing card with three tiers (Basic / Pro / Enterprise)
- ARR growth curve sketch

---

## Slide 12 — Team & Why Us (團隊與信心)

**Headline**
Built by people who've been on both sides of the desk.

**Body (zh)**
**Barry Chuang** — 創辦人 / CEO
- 補習班家族第二代，自己教過 SAT 7 年
- 矽谷工程背景，曾任 [前公司]
- 同時懂老師的痛點 + 工程的解法

**核心優勢**
- 已落地產品：不是 PowerPoint，是運作中的 prod 系統
- 客戶在身邊：第一批用戶就是自家補習班 + 朋友圈，極快迭代
- AI 原生架構：用 Claude / GPT 都通用，不被單一供應商綁

**為什麼相信**
> 「我們不是要做更好的補習班軟體 — 我們要讓『經營補習班』變成不用 24 小時繃緊神經的事。」
> — Barry, 2026

**Visual cue**
- Founder photo, casual + warm
- 3-bullet credibility strip: years teaching / engineering background / first paying customers

---

## Slide 13 — Closing & Contact (結語)

**Headline**
The cram school of 2030 won't look like 2026. We're already building it.

**Sub-line**
Ride along.

**CTA**
- 📧 barry@nexhunt.xyz
- 🌐 sat.nexhunt.xyz
- 📱 (your contact)
- Calendly link

**Visual cue**
- Same warm-coral cover gradient as slide 1
- Bookend feel
- One large quote at bottom: "Teachers should teach. We'll handle the rest."

---

## Designer Notes

- **Color palette:** existing product theme — warm-coral (#E76F51), cream (#FAF6EE), charcoal (#2A2422), gold (#C9A24E), lime accent (#84CC16). Keep consistent with the live UI screenshots.
- **Typography:** Headlines in a confident geometric sans (Inter Display, Space Grotesk, or similar). Body in a humanist sans (Inter, IBM Plex Sans). Quotes in serif italic (Cormorant Garamond) for warmth.
- **Imagery:** Avoid generic stock — prefer real product screenshots, simple illustrations, founder photo. The product is already polished; show it.
- **Tone:** Premium but not corporate. Founder voice. Confidence without buzzwords.
- **Bilingual:** Each slide has English headline + Chinese body. Designer can offer EN-only variant by translating body sections (provided in EN where needed).
- **Length:** 13 slides. Each ≤ 60 seconds verbal. Total pitch ≤ 13 minutes.
