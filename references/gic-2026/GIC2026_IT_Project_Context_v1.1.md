# GIC 2026 × Ecomdy — Challenge 4
## IT Project Context & Implementation Direction v1.1

**Cập nhật:** 18/11/2026  
**Phạm vi:** Chỉ tập trung công việc Technology / hai thành viên IT  
**Nguồn tổng hợp:** Hội thoại dự án, `GIC 2026_Challenge 4.xlsx` và `GIC2026_Challenge4_Project_Baseline_v1.0.md`.  
**Trạng thái:** Working technical context. Chưa phải kiến trúc/PRD đã phê duyệt và chưa xác thực giá/giấy phép API hiện hành.

### Cách đọc
- **[BRIEF]**: bắt buộc theo đề Ecomdy.
- **[DECIDED]**: ưu tiên/định hướng đã được thống nhất trong hội thoại.
- **[PROPOSED]**: lựa chọn kỹ thuật đề nghị, chưa khóa.
- **[VERIFY]**: cần kiểm chứng bằng API test, spike hoặc đồng thuận đội.
- **[DEFER]**: chưa làm trong MVP.

---

## 0. Định hướng và giới hạn

**Working product:** AI-assisted, cost-aware, consistency-aware short-film production orchestrator; không phải xây video foundation model mới. Giá trị tiết kiệm chủ yếu *cần kiểm chứng* ở workflow: keyframe-first, approval gates, static shot render, selective video generation, hạn chế regeneration; model routing là một phần chứ không được mặc định là phần tiết kiệm lớn nhất.

**Đề chính thức [BRIEF]:** Nhập ý tưởng → tạo kịch bản/phân cảnh → đề xuất công cụ AI theo scene type và ngân sách, giải thích lý do → tạo ảnh/video có character/visual consistency → tự động ghép phim với voice-over/music/subtitles → lưu chi phí mỗi lần generate và tổng phim. Tích hợp **>=3 công cụ AI tạo ảnh/video**. Bàn giao **functional demo**, **ít nhất một phim 30–60 giây**, **itemized cost breakdown gồm attempts regenerate** và so sánh với **all-in-one**; theo dõi idea-to-film time. Ghi nhận model/tool của từng cảnh, bảo đảm quyền thương mại/âm thanh/nhân vật và disclosure AI-generated.

**Quy tắc cắt scope [DECIDED]:** Một vertical slice chạy được và đo được chi phí quan trọng hơn microservices, KG, agents hay bandit.

## 1. Thứ tự ưu tiên kỹ thuật — bản cập nhật

### P0 — phải có để demo và đáp ứng đề
1. **End-to-end film pipeline:** Brief → structured script → scenes/shots → keyframe approval → generation → review → assembly/export.
2. **Continuity P0:** Structured Story Bible/continuity sheet (JSON) và kiểm tra continuity cơ bản; bao gồm **character, product, outfit, props, logo, location, lighting, start/end state**. Human reviewer quyết định chốt chất lượng.
3. **Keyframe-first + Human Approval:** Generate ảnh tham chiếu/keyframes, chọn trước khi gọi video; có lối đi riêng cho shot tĩnh (pan/zoom FFmpeg) và voice/speaking.
4. **>=3 AI image/video tools:** ít nhất ba tool/model generation thực sự được tích hợp và chạy thử; không tính aggregator như model độc lập.
5. **Shot-level regeneration & attempt history:** tách shot, attempt, asset, approval; không regenerate cả film khi chỉ sửa một shot.
6. **Cost ledger theo attempt:** append-only events (estimate/reserve/actual/adjust/refund), pricing snapshot, tính cả attempt unsuccessful, idempotency để không đếm trùng.
7. **Budget guardrail cơ bản:** chặn submit khi dự toán/reservation không phù hợp với ngân sách; reservation không được đồng nghĩa actual spend.
8. **Export:** video 30–60s; voice-over/music/subtitles, FFmpeg deterministic logo/text overlay, 9:16 và ít nhất một format export được hỗ trợ.
9. **AI Usage Manifest & license evidence:** model/version, provider, prompt, asset, thời gian, nguồn quyền thương mại/gói sử dụng, quyền đối với âm thanh/voice/reference; ghi AI label theo yêu cầu.
10. **All-in-one comparison:** bằng chứng so sánh có phương pháp (không bắt buộc xây dashboard benchmark phức tạp).

### P1 — sau vertical slice P0
- Router calibrated quality-aware với p_accept theo model × shot type và uncertainty.
- Automatic continuity comparison nếu rule validator chưa đủ.
- Editing vs regenerate vs model switch policy; rework estimate.
- Version diff UI / phụ thuộc asset nâng cao.
- Ablation study: workflow no gates vs keyframe-first vs static shot route vs basic router vs calibrated router.
- Đo chênh lệch machine time và human time chi tiết; dashboard reliability.

### P2 — chưa làm nếu chưa có vấn đề đo được
- Obsidian-driven editor, EmbeddingGemma 2, pgvector retrieval, Neo4j/Knowledge Graph database, GraphRAG, autonomous multi-agent, contextual bandits, advanced temporal causal graph, self-trained video models.
- Với 6–10 shots, Story Bible dạng JSON và context LLM thường đủ; embeddings chưa có business case rõ.
- Change impact cơ bản làm được bằng SQL `shot_character_ref` + revision IDs; **không cần graph database**.

## 2. Luồng end-to-end đề xuất

```
Creative Brief
  -> LLM Structured Script (user reviews)
  -> Scene / Shot Specs + Continuity Sheets
  -> Image/Keyframe Candidates
  -> HUMAN APPROVAL GATE
  -> Feasibility Router (static overlay / I2V / speaking)
  -> Budget estimate + reserve
  -> Generation Job (provider adapter, webhook/poll)
  -> Persist Attempt + Asset + Cost Events
  -> HUMAN REVIEW (approve / reject / retry / edit)
  -> Timeline Assembly (video + voice/music + ASS subtitles + logo/text overlay)
  -> Final Film + Per-Attempt Cost Report + AI Usage Manifest
```

**Nuance:** duration bị ràng buộc bởi narration, editing rhythm, timing và constraints của model; **không** áp quy tắc voice-over luôn quyết định mọi shot length. Audio/music license và correct brand text/logo cần được kiểm soát từ đầu.

**Routing logic P0:** (1) hard constraints: supports I2V/reference, aspect, duration, audio/dialogue, provider availability, commercial rights, budget; (2) static image→FFmpeg nếu đạt yêu cầu; (3) heuristic chọn model hợp lệ; (4) explanation phải được xây từ feature/capability/price snapshot đã dùng, không để LLM tự bịa lý do.

## 3. Contract trung tâm: ShotSpec v0.1

Shot Spec là giao diện nhất quán giữa script planner, Designer, IT backend và IT frontend. Validate bằng Zod/JSON Schema, có `schema_version` và ID có tính ổn định. Ví dụ tối giản (giá trị minh họa):

```json
{
  "schema_version": "0.1",
  "shot_id": "SHOT-003",
  "scene_id": "SCENE-002",
  "ordinal": 3,
  "kind": "motion",
  "duration_s": 4,
  "aspect_ratio": "9:16",
  "description": "Lan walks away from the cafe holding a red cup.",
  "camera": { "framing": "medium", "movement": "slow push-in" },
  "characters": [{ "id": "CHAR-LAN", "revision": 2 }],
  "location": { "id": "LOC-CAFE", "revision": 1 },
  "product_refs": [{ "id": "PROD-CUP", "revision": 1 }],
  "continuity": {
    "start": { "outfit": "blue coat", "cup_color": "red", "cup_fill": "full" },
    "end": { "outfit": "blue coat", "cup_color": "red", "cup_fill": "half" }
  },
  "style_ref_ids": ["STYLE-001"],
  "keyframe_asset_ids": ["ASSET-101"],
  "dialogue": null,
  "status": "draft"
}
```

**Ghi chú thiết kế:** ví dụ ở trên chưa phải JSON Schema đầy đủ. Đừng mặc định `shot_id` là scene ID. Tách JSON `ShotSpec` (ý đồ/brief), `GenerationRequest` (provider input), `Attempt` (lần chạy), `Asset` (đầu ra), `Approval` (quyết định). Khi shot thay đổi, tạo revision mới hoặc lưu immutable snapshot; không âm thầm ghi đè những gì đã dùng để generate.

### Continuity validation P0
- So sánh trạng thái **end** của shot trước với **start** của shot sau, có awareness về scene cuts và passage of time.
- Tách **invariants** (logo, product design, hair/outfit trong một sequence, ID) khỏi **allowed transitions** (cup full→half, object moves).
- Rule validation cho trường được cấu trúc; optional LLM judge chỉ để cảnh báo bất thường, cần human confirmation.
- Visual reviewer duyệt real output, vì text continuity sheet không chứng minh pixel-level consistency.

## 4. Domain entities / states

**Entities P0:** `Project`, `StoryRevision`, `Scene`, `Shot`, `ShotRevision`, `CharacterRevision`, `ProductRevision`, `StyleBible`, `GenerationAttempt`, `Asset`, `Approval`, `RenderJob`, `ModelCapability`, `PriceSnapshot`, `CostLedgerEvent`, `UsageManifestEntry`.

**Trạng thái tách riêng:**

- Story/Shot spec: `draft | approved | superseded`
- Provider job: `queued | submitted | running | succeeded | failed | canceled | unknown`
- Asset review: `pending_review | approved | rejected | stale`
- Render job: `pending | running | complete | failed`

Không gộp tất cả vào một `status`; các state transitions phải được validate.

**Cost ledger event semantics:** append-only; một attempt có thể có nhiều event (estimate, reserve, actual, adjustment, refund/release). Tính actual spend từ các event settled; exclude reservation khỏi actual spend. Lưu `currency`, `base_amount`, `usd_amount` (nếu quy đổi), `fx_rate_snapshot` (nếu cần), `pricing_snapshot_id`, `provider_request_id`, `idempotency_key`, `occurred_at`. Trong trường hợp API timeout, không suy đoán miễn phí: lưu `unknown` tới khi đối soát.

**Dedupe:** một webhook có thể gửi lặp; dùng unique provider event ID / attempt idempotency key để xử lý at-least-once delivery. Một lần retry kỹ thuật không được tạo một generation attempt mới trừ khi thật sự phát sinh provider generation mới.

## 5. ProviderAdapter contract và operational safety

Proposed methods:

```ts
interface ProviderAdapter {
  capabilities(modelId: string): Promise<ModelCapabilities>;
  estimateCost(input: NormalizedGenerationInput): Promise<MoneyEstimate>;
  submit(input: NormalizedGenerationInput, idempotencyKey: string): Promise<ProviderJobRef>;
  getStatus(job: ProviderJobRef): Promise<ProviderJobStatus>;
  cancel?(job: ProviderJobRef): Promise<CancelResult>;
  parseAndVerifyWebhook?(headers: Record<string, string>, rawBody: Uint8Array): Promise<ProviderEvent>;
}
```

Các tính năng như cancel/idempotency cấp provider **không bảo đảm có ở tất cả API**. Adapter phải phản ánh khả năng thực tế, tránh khai báo có rồi dùng giả. Webhook: verify signature khi provider hỗ trợ, chống replay/dedupe, polling fallback, exponential backoff/jitter và dead-letter/failed-job recovery. Tách `normalized inputs` khỏi provider-specific request payload. Lưu immutable model ID/version, parameters, seed (nếu có), request/response IDs, source assets, price snapshot.

Provider evaluation phải được thực hiện trước khi chốt danh sách model: API availability, commercial terms theo **đúng plan/account**, I2V/reference, 9:16, clip length, audio, pricing, queue/webhook, retries, cancelability, output retention. **Mọi giá/điều khoản từ chat trước chỉ mang tính tham khảo, không được coi là đã verify.**

## 6. Production cost levers — thứ tự thử nghiệm

1. **Keyframe-first + human approval** trước video generation.
2. **Static shot → still image + FFmpeg pan/zoom**, không gọi video nếu không cần.
3. **Short drafts / low resolution** trước final upscale, khi provider hỗ trợ và thực tế rẻ hơn.
4. **Expensive speaking/lip-sync model only when necessary**.
5. **Router quality-aware** chỉ sau khi có dữ liệu.

Mỗi lever cần được kiểm tra bằng ablation, không khẳng định trước rằng nó luôn tiết kiệm. Mục tiêu chất lượng: narrative coherent, product/character consistent, typography/logo exact; visual beauty không đủ nếu tính liên tục lỗi.

**Calibrated router P1 (for reference):** nếu chi phí mỗi attempt `c` và xác suất được duyệt `p` không đổi, expected cost/approved shot ≈ `c/p`. Với duration `d` giây, expected cost/approved second ≈ `c/(p*d)`. Đây là mô hình đơn giản hóa; nếu retry cap, editing, prompt changes và failure reasons khác nhau, cần mô hình khác. `p_accept` ước lượng theo **model × shot type**, các mẫu ít (5–10) chỉ là pilot và phải thể hiện uncertainty.

## 7. Video assembly + compliance

- Generate vẫns/clips ở aspect ratio mục tiêu, chuẩn hóa `fps`, resolution, codecs, pixel formats, audio sample rate.
- FFmpeg ghép scenes, pan/zoom shot tĩnh, voice/music/SFX, ducking và loudness normalization.
- Subtitle timestamps từ TTS nếu có; nếu không, dùng ASR/alignment (ví dụ Whisper) và xuất/burn-in ASS.
- **Không tin AI vẽ đúng logo/chữ thương hiệu**: giữ logo/text như authored/approved overlays qua FFmpeg hoặc Remotion; sản phẩm có image reference nếu được phép.
- Final export + `AI Usage Manifest` (per shot/asset: provider, model/version, prompt version, generated time, ownership/licensing evidence, source refs, music/voice licenses, selected attempt, content disclosure).
- Chỉ sử dụng khuôn mặt, giọng nói và tài sản có quyền phù hợp; không coi commercial rights của model là giấy phép cho tất cả user inputs.

## 8. Stack: lean alternatives, chưa khóa

**Option A [PROPOSED]:** Next.js full-stack (UI + route handlers), Supabase (Postgres/Auth/Storage), Trigger.dev/Inngest hoặc worker process đơn giản để xử lý video/AI jobs. Ít codebase và hạ tầng hơn.

**Option B [PROPOSED]:** Next.js UI + NestJS backend + Postgres + Redis/BullMQ + object storage, nếu đội có kinh nghiệm và cần linh hoạt queue hơn.

**Decision factors [VERIFY]:** team familiarity, deployment, long-running task limits, webhook support, worker execution resource needs (FFmpeg), vendor cost/quotas, local debugging, logs. Chốt stack bằng spike và ghi ADR, không chọn vì trend.

Không dùng Obsidian/EmbeddingGemma cho runtime critical path của demo P0.

## 9. Phân công 2 IT và giao diện phối hợp

| Hạng mục | IT 1 — AI/Backend Owner | IT 2 — Frontend/Media Owner | Phụ thuộc |
|---|---|---|---|
| Shot Spec / schema | **Owner** | Review/consume | Designer mô tả shot |
| Structured script/continuity | **Owner** | UI editing | Designer approves |
| Provider adapters + >=3 tools | **Owner** | Integration test | Biz2 prices/license |
| Job orchestration / attempt lifecycle | **Owner** | Job status UI | API access |
| Cost ledger + reservation | **Owner** | Cost display | Biz2 cost rules |
| Brief & storyboard UI | API contract | **Owner** | Designer Figma |
| Keyframe/asset review | Asset/status APIs | **Owner** | Designer visual rubric |
| Final media assembly | Support metadata APIs | **Owner** | Music/voice assets |
| Usage manifest | Provider metadata owner | Final export integration | Biz2 license evidence |
| E2E tests + replay demo | Shared | Shared | Entire team |

**Boundary:** IT 1 không cần xây mọi frontend; IT 2 không nhất thiết viết tất cả rendering logic tách biệt. Cả hai sở hữu contract và end-to-end QA.

## 10. Vertical slice đầu tiên (mục tiêu tuần đầu, điều chỉnh theo thực lực)

**Output:** video **3 shots** → một file MP4 có phụ đề, ít nhất ba provider/model generation paths được gọi hoặc được kiểm chứng rõ ràng; mỗi shot có `Attempt`, `Asset`, `approval`, `CostLedgerEvents` và `ManifestEntry`. Có một shot tĩnh, một shot I2V, một shot character/product có reference. Một sản phẩm demo 9:16 là hợp lý; nếu muốn kiểm tra 16:9, thêm sau.

**Thứ tự thực hiện:**
1. Chốt 3 test-shot fixtures và ShotSpec v0.1; UI có thể rất thô.
2. Verify API keys, license/plan, provider capabilities và maximum test budget.
3. Generate image/keyframe; lưu object storage và approve.
4. Tạo video/shot tĩnh; ghi đủ job state, attempt, cost events.
5. Preview/approve 3 shots; FFmpeg assemble + subtitles + deterministic logo/text.
6. Export manifest/cost CSV hoặc JSON, chạy lại với replay mode từ cached accepted run.

**Definition of Done:** chạy trên máy/dev deployment qua script hoặc UI; có output video và logs; dùng đúng >=3 tools theo cách chứng minh được; chi phí không bị nhân đôi khi webhook duplicate; không âm thầm mất attempt failed; media manifest khớp selected assets. Đội chưa cần perfect styling, fine-tuned LLM, graph DB hay auto-evaluator.

## 11. Testing và benchmark kỹ thuật

**P0 technical tests:** ShotSpec parse/validation, state transition unit tests, ledger correctness (refund, duplicates, concurrency), signed webhook/poll integration (mocks), failed/timeout/unknown-job reconciliation, file retention/cache, media export reproducibility, manual continuity checklist.

**Benchmark [BRIEF + PROPOSED]:** theo cùng brief/time/resolution/quality gate, đối chiếu (A) all-in-one, (B) fixed single-model, (C) cheapest eligible router, (D) proposed workflow/router. A là yêu cầu đề; B/C/D giúp kiểm định đóng góp thuật toán. *Ablation P1*: bật/tắt keyframe approval, static pan/zoom, preview resolution, smart routing để quy kết savings. Chi phí đầy đủ gồm attempts rejected và các bước phụ; báo machine time và human time riêng; rubric chốt trước; ưu tiên ≥3 blind raters khi nguồn lực cho phép.

**Demo:** không phụ thuộc chạy API live; có replay mode từ completed run, **ghi rõ đây là playback**; giữ một luồng live nhỏ để chứng minh integration nếu cần.

## 12. Những quyết định mở / research spikes

| ID | Vấn đề | Gating question / đề nghị xác thực |
|---|---|---|
| ADR-01 | Lean stack | Option A hay B dựa trên kinh nghiệm 2 IT, hosting và long-running jobs? |
| ADR-02 | Provider selection | >=3 tools có API/plan commercial, image refs, I2V, 9:16, giá phù hợp? |
| ADR-03 | Source of truth | PostgreSQL ShotSpec/continuity vs Markdown import? P0 dùng PostgreSQL/JSON. |
| ADR-04 | Job execution | Managed jobs hay worker riêng? Hỗ trợ webhook, retry, compute FFmpeg thế nào? |
| ADR-05 | Voice/subtitles | TTS timestamps hay post-generation alignment? |
| ADR-06 | Budget policy | Project budget, per-shot cap, reservation/adjustment và cancellation semantics? |
| ADR-07 | Output spec | Target 9:16/1080p? Có cần thêm 16:9? Source assets đủ chuẩn? |
| ADR-08 | Model router | Minimal eligibility explanation schema và default selection strategy? |
| ADR-09 | Continuity review | Rule validator + human approval đủ chưa, có cần LLM checks không? |

## 13. Quy tắc cộng tác cho các phiên chat IT tiếp theo

1. Mặc định thảo luận **IT1 + IT2**, tập trung P0 và vertical slice; không tự mở rộng sang business pitch hoặc designer task trừ khi nó là dependency bắt buộc.
2. Mỗi đề xuất công nghệ phải chỉ ra: mục tiêu, trade-offs, dependency, độ khó vận hành cho 2 IT, cách test và điều kiện bỏ.
3. Phân biệt **[BRIEF] / [DECIDED] / [PROPOSED] / [VERIFY] / [DEFER]**.
4. Không suy diễn model pricing, API access, webhook, latency, commercial license từ các bảng giá cũ; phải xác minh chính xác theo endpoint/plan/thời điểm.
5. Mọi việc cần tách **Shot Spec**, **generation job**, **asset**, **approval**, **cost ledger**, **render job**; không gộp state.
6. Tập trung quality/consistency (P0), workflow cost levers và provenance trước khi làm advanced router, KG, embedding.
7. Mỗi task nên có owner IT1/IT2, contract, input/output, acceptance tests và estimated external spend (nếu có).
8. Khi thiếu thông tin, tiến hành với phương án lean mặc định và ghi assumption; không tuyên bố đã implement/verify khi mới chỉ có bản thiết kế.

## 14. Next actionable tasks

1. Viết `ShotSpec` Zod schema thực + fixtures 3 shots + validation tests (IT1; IT2 review).
2. Tạo provider evaluation matrix có verified API/license/pricing, với một API spike end-to-end (IT1; phối hợp Biz2).
3. Chọn lean stack qua ADR-01, set up mono-repo/deployment skeleton (cả hai IT).
4. Thiết kế normalized `GenerationAttempt` + `CostLedgerEvent` + `Asset` tables, idempotency tests (IT1).
5. Build rough storyboard/review UI + video assembly pipeline 9:16 (IT2).
6. Demo 3-shot vertical slice, upload/export cost ledger và usage manifest, chạy fail/retry/replay tests (cả hai).

---

**Document governance:** Đây là technical context cho dự án và có thể dùng làm đầu vào PRD/ADR/backlog. Các thay đổi lớn phải được ghi vào bản v1.2 cùng ngày, lý do, owner và evidence. Không tự xem file này là tài liệu chính thức của Ecomdy.
