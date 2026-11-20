# C4 Model Architecture — Level 1 & Level 2

## FC-001 deployment clarification [DECIDED, 2026-11-20]

Source: [FC-001 v1.1.1](../../specs/film-creation/spec.md).
The existing Web container runs Next.js App Router and mounts the Hono app in
Node.js route handlers. Hono is not a fourth API service. Browser accesses only
http://127.0.0.1:3000; db/worker ports remain private. Migration is a one-off
startup command before web/worker, not a new runtime domain service.
Film create/read does not depend on worker readiness or dispatch jobs.
FC-001 adds opaque operator sessions in PostgreSQL and browser-safe shared
contracts; financial/generation/media components in the diagrams remain future
capabilities, not evidence that those components are implemented.


**System:** AI-Powered Cost-Efficient Short Film Production Assistant  
**Status:** [PROPOSED] (Aligned with DEC-Q01 to DEC-Q04 Local-first Profile)  
**Owners:** IT 1 (Lead Backend & AI Engine) & IT 2 (Frontend & Media Pipeline)  
**Date:** 2026-11-18  
**Editable Draw.io:** [`c4_model_architecture.drawio`](./c4_model_architecture.drawio)

---

## 1. C4 Level 1 — System Context Diagram

Sơ đồ ngữ cảnh hệ thống mô tả cách hệ thống tương tác với người dùng nội bộ (team sản xuất/demo) và các hệ thống AI/Media bên ngoài thông qua các ranh giới Adapter chuẩn hóa.

```mermaid
flowchart TB
    %% Actors
    Producer(["<b>Content Producer / Demo Operator</b><br/><i>[Business 1 / IT 1]</i><br/>Nhập ý tưởng, duyệt kịch bản, duyệt Keyframe,<br/>kiểm soát ngân sách và xuất phim 30–60s"]):::personStyle
    Reviewer(["<b>Creative Reviewer / Benchmark Rater</b><br/><i>[Designer / Business 2]</i><br/>Chấm điểm chất lượng hình ảnh, kiểm tra<br/>tính nhất quán & xuất báo cáo đối chứng"]):::personStyle

    %% Core System
    System["<b>AI Short Film Production Assistant</b><br/><i>[Software System - Local-first Profile]</i><br/>Hệ thống điều phối sản xuất phim ngắn tối ưu chi phí:<br/>Sinh kịch bản, khóa nhất quán, chọn model theo rule,<br/>theo dõi Cost Ledger (append-only) & ghép phim tự động"]:::systemStyle

    %% External Systems
    LLM["<b>LLM Provider API</b><br/><i>[External System - Google Gemini / Claude]</i><br/>Sinh kịch bản phân cảnh (ShotSpec JSON)<br/>và Continuity Sheet"]:::externalStyle
    GoogleAI["<b>Google AI Studio API</b><br/><i>[External System - Gemini Omni 1.1 Flash / Imagen]</i><br/>Tạo ảnh Keyframe & Video chất lượng cao<br/>(Quy đổi token/giây sang USD Rate Card)"]:::externalStyle
    FalAI["<b>fal.ai Gateway & 3rd-Party AI APIs</b><br/><i>[External System - FR-09 Multi-Vendor]</i><br/>Cung cấp ≥2 model tạo ảnh/video bổ sung<br/>(Kling, MiniMax, Flux, Seedance...)"]:::externalStyle
    AudioExt["<b>TTS & Licensed Audio Sources</b><br/><i>[External System / Local Library]</i><br/>Sinh giọng đọc (Voice-over + Timestamps)<br/>và cung cấp nhạc nền có bản quyền"]:::externalStyle

    %% Relationships
    Producer -->|"1. Nhập brief, chỉnh sửa Storyboard,<br/>duyệt Keyframe & xem chi phí"| System
    Reviewer -->|"2. Kiểm duyệt tính nhất quán,<br/>xuất Cost Report & AI Usage Manifest"| System

    System -->|"3. Gửi prompt kịch bản<br/>(Structured JSON Output)"| LLM
    System -->|"4. Gửi request tạo Keyframe/Video<br/>(Polling/Subscribe)"| GoogleAI
    System -->|"5. Gửi request theo Router<br/>(Polling/Subscribe)"| FalAI
    System -->|"6. Tạo Voice-over & tải nhạc nền"| AudioExt

    %% Class Definitions
    classDef personStyle fill:#083F75,stroke:#06315C,stroke-width:2px,color:#ffffff;
    classDef systemStyle fill:#1061B0,stroke:#0D5091,stroke-width:2px,color:#ffffff;
    classDef externalStyle fill:#8C8496,stroke:#736782,stroke-width:2px,color:#ffffff;
```

---

## 2. C4 Level 2 — Container Diagram (Local-first Modular Monolith)

Sơ đồ Container chi tiết hóa các thành phần chạy bên trong máy trạm Local (Next.js App, Background Worker, Docker PostgreSQL 16 và Local File System) cùng luồng dữ liệu tài chính/media.

```mermaid
flowchart TB
    User(["<b>Producer / Demo Operator</b><br/><i>[Browser]</i>"]):::personStyle

    subgraph LocalHost ["<b>Local Workstation / Docker Environment (IT 1 Production Machine)</b>"]
        direction TB

        WebApp["<b>Next.js Web Application</b><br/><i>[Container: TypeScript / Next.js App Router]</i><br/>• Storyboard UI & Human Approval Gate (F5)<br/>• Script & Continuity Planner via LLM SDK (F1)<br/>• Rule-based Model Router & Explainer (F2)<br/>• Cost Ledger Guardrail & Budget Reservation (F4)<br/>• Media Route Handler (phục vụ file local)"]:::containerStyle

        Worker["<b>Async Media & AI Worker</b><br/><i>[Container: Node.js Worker Process]</i><br/>• Lắng nghe hàng đợi từ pg-boss<br/>• Provider Adapter Engine: Polling/Subscribe (F3)<br/>• Tải ngay media về Local Storage (tránh expire)<br/>• Media Assembly Engine dùng FFmpeg CLI (F6)<br/>• Xuất AI Usage Manifest & Cost CSV (F7)"]:::containerStyle

        DB[("<b>PostgreSQL 16 Database</b><br/><i>[Container: Docker Volume pgdata]</i><br/>• Tables: Film, Scene, Shot, Attempt, Asset<br/>• Cost Ledger (Append-only Financial Events)<br/>• 3 State Machines (Story, Job, Review)<br/>• Job Queue Tables (pg-boss)")]:::dbStyle

        FileStorage[("<b>Local File System</b><br/><i>[Volume: ./data/assets & ./data/exports]</i><br/>• Lưu trữ Keyframe PNG, Video MP4 thô<br/>• Lưu trữ TTS Audio, BGM, Phụ đề ASS/SRT<br/>• Lưu trữ phim thành phẩm & Manifest JSON<br/>• Đóng gói qua StorageAdapter interface")]:::dbStyle
    end

    %% External APIs & OS Tools
    LLM_API["<b>LLM API</b><br/><i>[External System - HTTPS / JSON]</i><br/>Google Gemini / Claude"]:::externalStyle
    Video_APIs["<b>AI Media Providers</b><br/><i>[External System - HTTPS / JSON]</i><br/>Google AI Studio (Gemini Omni 1.1 Flash) + fal.ai + Multi-Vendor"]:::externalStyle
    FFmpeg_CLI["<b>FFmpeg CLI Binary</b><br/><i>[OS / Docker Layer - Executable]</i><br/>Concat, Overlay Logo, Mix Audio, Burn Sub"]:::componentStyle

    %% Connections
    User -->|"HTTP / localhost:3000<br/>Tạo kịch bản, duyệt shot, theo dõi chi phí"| WebApp

    WebApp -->|"Drizzle ORM (SQL)<br/>Đọc/Ghi State, Reserve Budget,<br/>Enqueue Job vào pg-boss"| DB
    WebApp -->|"HTTPS<br/>Sinh ShotSpec JSON"| LLM_API
    WebApp -->|"StorageAdapter.get()<br/>Stream ảnh/video lên UI"| FileStorage

    Worker -->|"pg-boss Polling (SQL)<br/>Nhận job & cập nhật trạng thái,<br/>Settle/Release Cost Ledger"| DB
    Worker -->|"HTTPS (Polling/Subscribe)<br/>Gọi tạo ảnh/video & kiểm tra quota"| Video_APIs
    Worker -->|"StorageAdapter.put()<br/>Lưu asset ngay khi tải xong"| FileStorage
    Worker -->|"Child Process Spawn<br/>Concat, Overlay Logo, Mix Audio, Burn Sub"| FFmpeg_CLI
    FFmpeg_CLI -->|"Đọc clips/audio & Ghi MP4 hoàn chỉnh"| FileStorage

    %% Class Definitions
    classDef personStyle fill:#083F75,stroke:#06315C,stroke-width:2px,color:#ffffff;
    classDef containerStyle fill:#23A2D9,stroke:#0E7DAD,stroke-width:2px,color:#ffffff;
    classDef dbStyle fill:#23A2D9,stroke:#0E7DAD,stroke-width:2px,color:#ffffff;
    classDef externalStyle fill:#8C8496,stroke:#736782,stroke-width:2px,color:#ffffff;
    classDef componentStyle fill:#63BEF2,stroke:#2086C9,stroke-width:2px,color:#ffffff;
```

---

## 3. Bảng Phân rã Trách nhiệm Kỹ thuật theo Container

| Container | Công nghệ cốt lõi | Trách nhiệm & Bất biến kỹ thuật (Invariants) | Owner |
| :--- | :--- | :--- | :--- |
| **Next.js Web Application** | Next.js (App Router), TypeScript, Tailwind, shadcn/ui, Drizzle ORM | • Quản lý 3 state machine độc lập: Story State, Generation Job State, và Asset Review State.<br/>• Thực hiện Budget Reservation trong DB trước khi đẩy job vào hàng đợi.<br/>• Không xử lý render video nặng trực tiếp trên HTTP request để tránh timeout. | IT 2 (UI) & IT 1 (API/Router) |
| **Async Media & AI Worker** | Node.js, pg-boss, Provider SDKs, StorageAdapter | • Chạy tách biệt khỏi web server; tự động retry khi gặp lỗi mạng tạm thời.<br/>• Bắt buộc tải file kết quả từ URL của provider về `./data/assets` ngay khi job thành công (tránh link hết hạn).<br/>• Mọi lượt gọi thất bại đều ghi nhận sự kiện chốt chi phí/lỗi vào Cost Ledger. | IT 1 |
| **PostgreSQL 16 Database** | Docker `postgres:16` | • Lưu trữ dữ liệu quan hệ (Film -> Scene -> Shot -> Attempt -> Asset) và hàng đợi `pg-boss`.<br/>• Bảng `cost_ledger_events` thiết kế dạng append-only, quy đổi mọi đơn vị (token, giây, credit) về USD theo bảng giá niêm yết (Rate Card). | IT 1 |
| **Local File System & FFmpeg** | Local Disk (`./data`), FFmpeg CLI | • Đóng gói sau interface `StorageAdapter` để có thể chuyển sang Cloudflare R2 ở giai đoạn sau mà không sửa logic nghiệp vụ.<br/>• FFmpeg chịu trách nhiệm ghép clip, chèn logo/text tĩnh, trộn giọng đọc + nhạc nền và đốt phụ đề (ASS/SRT). | IT 2 |
