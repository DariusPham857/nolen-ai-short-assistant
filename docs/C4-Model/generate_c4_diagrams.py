import os
import sys
import html

def esc(s):
    return html.escape(s, quote=True)

def generate_c4_xml():
    # Common styles
    STYLE_PERSON = (
        "shape=mxgraph.c4.person2;html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;"
        "align=center;fillColor=#083F75;strokeColor=#06315C;fontStyle=0;"
    )
    STYLE_SYSTEM = (
        "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;"
        "align=center;fillColor=#1061B0;strokeColor=#0D5091;fontStyle=0;"
    )
    STYLE_EXTERNAL = (
        "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;"
        "align=center;fillColor=#8C8496;strokeColor=#736782;fontStyle=0;"
    )
    STYLE_CONTAINER = (
        "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;"
        "align=center;fillColor=#23A2D9;strokeColor=#0E7DAD;fontStyle=0;"
    )
    STYLE_DATABASE = (
        "shape=cylinder3;size=15;boundedLbl=1;html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;"
        "align=center;fillColor=#23A2D9;strokeColor=#0E7DAD;fontStyle=0;"
    )
    STYLE_COMPONENT = (
        "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;"
        "align=center;fillColor=#63BEF2;strokeColor=#2086C9;fontStyle=0;"
    )
    STYLE_BOUNDARY = (
        "swimlane;startSize=35;html=1;whiteSpace=wrap;dashed=1;dashPattern=8 8;"
        "strokeColor=#0D5091;strokeWidth=2;fillColor=#F8FBFD;fontColor=#083F75;"
        "fontStyle=1;fontSize=13;align=left;spacingLeft=15;pointerEvents=0;container=1;"
    )
    STYLE_EDGE = (
        "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;"
        "fontSize=11;fontColor=#404040;strokeColor=#828282;labelBackgroundColor=#ffffff;"
        "endArrow=blockThin;endFill=1;endSize=8;"
    )
    STYLE_LEGEND_BOX = (
        "rounded=1;arcSize=8;html=1;whiteSpace=wrap;fontSize=11;fillColor=#FFFFFF;"
        "strokeColor=#CCCCCC;shadow=1;align=left;verticalAlign=top;spacingLeft=15;spacingTop=10;"
    )
    STYLE_TITLE = (
        "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;"
        "whiteSpace=wrap;rounded=0;"
    )

    # ==========================================
    # PAGE 1: C4 LEVEL 1 - SYSTEM CONTEXT
    # ==========================================
    p1_cells = []

    # Title block
    title_l1 = (
        '<b><font style="font-size: 20px; color: #083F75;">C4 Level 1 — System Context Diagram</font></b><br/>'
        '<font style="font-size: 13px; color: #555555;"><b>AI Short Film Production Assistant</b> — Local-first Profile (Single-User Local Operation / DEC-Q01–DEC-Q04)</font>'
    )
    p1_cells.append(
        f'<mxCell id="c1_title" value="{esc(title_l1)}" style="{STYLE_TITLE}" vertex="1" parent="1">'
        f'<mxGeometry x="60" y="30" width="800" height="60" as="geometry" />'
        f'</mxCell>'
    )

    # Actor 1: Producer
    lbl_producer = (
        '<b>Content Producer / Demo Operator</b><br/>'
        '<i>[Business 1 / IT 1]</i><br/><br/>'
        'Nhập ý tưởng, duyệt kịch bản, duyệt Keyframe,<br/>'
        'kiểm soát ngân sách và xuất phim 30–60s'
    )
    p1_cells.append(
        f'<mxCell id="c1_producer" value="{esc(lbl_producer)}" style="{STYLE_PERSON}" vertex="1" parent="1">'
        f'<mxGeometry x="180" y="130" width="260" height="170" as="geometry" />'
        f'</mxCell>'
    )

    # Actor 2: Reviewer
    lbl_reviewer = (
        '<b>Creative Reviewer / Benchmark Rater</b><br/>'
        '<i>[Designer / Business 2]</i><br/><br/>'
        'Chấm điểm chất lượng hình ảnh, kiểm tra<br/>'
        'tính nhất quán &amp; xuất báo cáo đối chứng'
    )
    p1_cells.append(
        f'<mxCell id="c1_reviewer" value="{esc(lbl_reviewer)}" style="{STYLE_PERSON}" vertex="1" parent="1">'
        f'<mxGeometry x="800" y="130" width="260" height="170" as="geometry" />'
        f'</mxCell>'
    )

    # Core System (Drill-down to Level 2)
    lbl_system = (
        '<b>AI Short Film Production Assistant</b><br/>'
        '<i>[Software System - Local-first Profile]</i><br/><br/>'
        'Hệ thống điều phối sản xuất phim ngắn tối ưu chi phí:<br/>'
        'Sinh kịch bản, khóa nhất quán, chọn model theo rule,<br/>'
        'theo dõi Cost Ledger (append-only) &amp; ghép phim tự động<br/><br/>'
        '<font style="color: #FFEB3B; font-weight: bold;">👉 Click to drill down into Containers (Level 2)</font>'
    )
    p1_cells.append(
        f'<UserObject label="{esc(lbl_system)}" link="data:page/id,page-c4-l2" id="c1_system">'
        f'<mxCell style="{STYLE_SYSTEM};cursor=pointer;" vertex="1" parent="1">'
        f'<mxGeometry x="460" y="360" width="320" height="180" as="geometry" />'
        f'</mxCell>'
        f'</UserObject>'
    )

    # External System 1: LLM Provider API
    lbl_llm_ext = (
        '<b>LLM Provider API</b><br/>'
        '<i>[External System]</i><br/>'
        '<i>Google Gemini / Claude</i><br/><br/>'
        'Sinh kịch bản phân cảnh (ShotSpec JSON)<br/>'
        'và Continuity Sheet'
    )
    p1_cells.append(
        f'<mxCell id="c1_llm_ext" value="{esc(lbl_llm_ext)}" style="{STYLE_EXTERNAL}" vertex="1" parent="1">'
        f'<mxGeometry x="50" y="620" width="240" height="140" as="geometry" />'
        f'</mxCell>'
    )

    # External System 2: Google AI Studio API
    lbl_google_ai_ext = (
        '<b>Google AI Studio API</b><br/>'
        '<i>[External System - Primary Flow]</i><br/>'
        '<i>Gemini Omni 1.1 Flash / Imagen</i><br/><br/>'
        'Tạo ảnh Keyframe &amp; Video chất lượng cao<br/>'
        '(Quy đổi token/giây sang USD Rate Card)'
    )
    p1_cells.append(
        f'<mxCell id="c1_google_ai_ext" value="{esc(lbl_google_ai_ext)}" style="{STYLE_EXTERNAL}" vertex="1" parent="1">'
        f'<mxGeometry x="340" y="620" width="260" height="140" as="geometry" />'
        f'</mxCell>'
    )

    # External System 3: fal.ai Gateway & 3rd-Party APIs
    lbl_fal_ai_ext = (
        '<b>fal.ai Gateway &amp; 3rd-Party AI APIs</b><br/>'
        '<i>[External System - FR-09 Multi-Vendor]</i><br/>'
        '<i>Kling, MiniMax, Flux, Seedance...</i><br/><br/>'
        'Cung cấp ≥2 model tạo ảnh/video bổ sung'
    )
    p1_cells.append(
        f'<mxCell id="c1_fal_ai_ext" value="{esc(lbl_fal_ai_ext)}" style="{STYLE_EXTERNAL}" vertex="1" parent="1">'
        f'<mxGeometry x="650" y="620" width="260" height="140" as="geometry" />'
        f'</mxCell>'
    )

    # External System 4: TTS & Licensed Audio Sources
    lbl_audio_ext = (
        '<b>TTS &amp; Licensed Audio Sources</b><br/>'
        '<i>[External System / Local Library]</i><br/><br/>'
        'Sinh giọng đọc (Voice-over + Timestamps)<br/>'
        'và cung cấp nhạc nền có bản quyền'
    )
    p1_cells.append(
        f'<mxCell id="c1_audio_ext" value="{esc(lbl_audio_ext)}" style="{STYLE_EXTERNAL}" vertex="1" parent="1">'
        f'<mxGeometry x="960" y="620" width="240" height="140" as="geometry" />'
        f'</mxCell>'
    )

    # Level 1 Relationships
    # 1. Producer -> System
    rel_1 = "1. Nhập brief, chỉnh sửa Storyboard,&#xa;duyệt Keyframe &amp; xem chi phí"
    p1_cells.append(
        f'<mxCell id="c1_rel_1" value="{esc(rel_1)}" style="{STYLE_EDGE};exitX=0.8;exitY=1.0;exitDx=0;exitDy=0;entryX=0.2;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c1_producer" target="c1_system">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 2. Reviewer -> System
    rel_2 = "2. Kiểm duyệt tính nhất quán,&#xa;xuất Cost Report &amp; Manifest"
    p1_cells.append(
        f'<mxCell id="c1_rel_2" value="{esc(rel_2)}" style="{STYLE_EDGE};exitX=0.2;exitY=1.0;exitDx=0;exitDy=0;entryX=0.8;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c1_reviewer" target="c1_system">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 3. System -> LLM
    rel_3 = "3. Gửi prompt kịch bản&#xa;(Structured JSON Output)"
    p1_cells.append(
        f'<mxCell id="c1_rel_3" value="{esc(rel_3)}" style="{STYLE_EDGE};exitX=0.15;exitY=1.0;exitDx=0;exitDy=0;entryX=0.5;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c1_system" target="c1_llm_ext">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 4. System -> Google AI
    rel_4 = "4. Gửi request tạo Keyframe/Video&#xa;(Polling/Subscribe)"
    p1_cells.append(
        f'<mxCell id="c1_rel_4" value="{esc(rel_4)}" style="{STYLE_EDGE};exitX=0.38;exitY=1.0;exitDx=0;exitDy=0;entryX=0.5;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c1_system" target="c1_google_ai_ext">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 5. System -> fal.ai
    rel_5 = "5. Gửi request theo Router&#xa;(Polling/Subscribe)"
    p1_cells.append(
        f'<mxCell id="c1_rel_5" value="{esc(rel_5)}" style="{STYLE_EDGE};exitX=0.62;exitY=1.0;exitDx=0;exitDy=0;entryX=0.5;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c1_system" target="c1_fal_ai_ext">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 6. System -> Audio
    rel_6 = "6. Tạo Voice-over&#xa;&amp; tải nhạc nền"
    p1_cells.append(
        f'<mxCell id="c1_rel_6" value="{esc(rel_6)}" style="{STYLE_EDGE};exitX=0.85;exitY=1.0;exitDx=0;exitDy=0;entryX=0.5;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c1_system" target="c1_audio_ext">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # Legend for Level 1
    legend_l1 = (
        '<b>Legend &amp; C4 Conventions</b><br/><br/>'
        '• <font color="#083F75"><b>Dark Blue Person:</b></font> User / Operator<br/>'
        '• <font color="#1061B0"><b>Blue Box:</b></font> Software System (In Scope)<br/>'
        '• <font color="#8C8496"><b>Grey Box:</b></font> External System (Out of Scope)<br/>'
        '• <font color="#555555"><b>Dashed Line:</b></font> Boundary<br/>'
        '• <font color="#404040"><b>Arrow:</b></font> Synchronous / Async Interaction'
    )
    p1_cells.append(
        f'<mxCell id="c1_legend" value="{esc(legend_l1)}" style="{STYLE_LEGEND_BOX}" vertex="1" parent="1">'
        f'<mxGeometry x="960" y="25" width="240" height="95" as="geometry" />'
        f'</mxCell>'
    )


    # ==========================================
    # PAGE 2: C4 LEVEL 2 - CONTAINER ARCHITECTURE
    # ==========================================
    p2_cells = []

    # Title block
    title_l2 = (
        '<b><font style="font-size: 20px; color: #083F75;">C4 Level 2 — Container Diagram (Local-first Modular Monolith)</font></b><br/>'
        '<font style="font-size: 13px; color: #555555;"><b>AI Short Film Production Assistant</b> — Next.js App Router + Async Worker + PostgreSQL 16 + Local Storage + FFmpeg CLI</font>'
    )
    p2_cells.append(
        f'<mxCell id="c2_title" value="{esc(title_l2)}" style="{STYLE_TITLE}" vertex="1" parent="1">'
        f'<mxGeometry x="50" y="20" width="950" height="60" as="geometry" />'
        f'</mxCell>'
    )

    # Back Link to Level 1
    backlink_lbl = "<b>⬅ Back to Level 1 (System Context)</b>"
    p2_cells.append(
        f'<UserObject label="{esc(backlink_lbl)}" link="data:page/id,page-c4-l1" id="c2_backlink">'
        f'<mxCell style="rounded=1;arcSize=20;html=1;whiteSpace=wrap;fillColor=#083F75;strokeColor=#06315C;fontColor=#ffffff;fontSize=12;align=center;cursor=pointer;" vertex="1" parent="1">'
        f'<mxGeometry x="1280" y="25" width="270" height="40" as="geometry" />'
        f'</mxCell>'
        f'</UserObject>'
    )

    # Actor: Producer / Demo Operator
    lbl_c2_user = (
        '<b>Producer / Demo Operator</b><br/>'
        '<i>[Browser Client]</i><br/><br/>'
        'Thao tác UI Storyboard, duyệt shot,<br/>'
        'kích hoạt render &amp; kiểm tra ngân sách'
    )
    p2_cells.append(
        f'<mxCell id="c2_user" value="{esc(lbl_c2_user)}" style="{STYLE_PERSON}" vertex="1" parent="1">'
        f'<mxGeometry x="50" y="220" width="220" height="170" as="geometry" />'
        f'</mxCell>'
    )

    # System Boundary (Container)
    bnd_name = "Local Workstation / Docker Environment (IT 1 Production Machine) [System Boundary]"
    p2_cells.append(
        f'<mxCell id="c2_boundary" value="{esc(bnd_name)}" style="{STYLE_BOUNDARY}" vertex="1" parent="1">'
        f'<mxGeometry x="320" y="90" width="890" height="740" as="geometry" />'
        f'</mxCell>'
    )

    # Container 1: Web Application (Parent: c2_boundary, relative coords: x=40, y=60)
    lbl_webapp = (
        '<b>Next.js Web Application</b><br/>'
        '<i>[Container: TypeScript / Next.js App Router]</i><br/><br/>'
        '• Storyboard UI &amp; Human Approval Gate (F5)<br/>'
        '• Script &amp; Continuity Planner via LLM SDK (F1)<br/>'
        '• Rule-based Model Router &amp; Explainer (F2)<br/>'
        '• Cost Ledger Guardrail &amp; Budget Reservation (F4)<br/>'
        '• Media Route Handler (Local file streaming)'
    )
    p2_cells.append(
        f'<mxCell id="c2_webapp" value="{esc(lbl_webapp)}" style="{STYLE_CONTAINER}" vertex="1" parent="c2_boundary">'
        f'<mxGeometry x="40" y="60" width="370" height="230" as="geometry" />'
        f'</mxCell>'
    )

    # Container 2: Worker Process (Parent: c2_boundary, relative coords: x=480, y=60)
    lbl_worker = (
        '<b>Async Media &amp; AI Worker</b><br/>'
        '<i>[Container: Node.js Worker Process]</i><br/><br/>'
        '• Lắng nghe hàng đợi job từ pg-boss<br/>'
        '• Provider Adapter Engine: Polling/Subscribe (F3)<br/>'
        '• Tải ngay media về Local Storage (tránh expire)<br/>'
        '• Media Assembly Engine gọi FFmpeg CLI (F6)<br/>'
        '• Xuất AI Usage Manifest &amp; Cost CSV (F7)'
    )
    p2_cells.append(
        f'<mxCell id="c2_worker" value="{esc(lbl_worker)}" style="{STYLE_CONTAINER}" vertex="1" parent="c2_boundary">'
        f'<mxGeometry x="480" y="60" width="370" height="230" as="geometry" />'
        f'</mxCell>'
    )

    # Container 3: PostgreSQL Database (Parent: c2_boundary, relative coords: x=40, y=440)
    lbl_db = (
        '<b>PostgreSQL 16 Database</b><br/>'
        '<i>[Container: Docker Volume pgdata]</i><br/><br/>'
        '• Tables: Film, Scene, Shot, Attempt, Asset<br/>'
        '• Cost Ledger (Append-only Financial Events)<br/>'
        '• 3 State Machines (Story, Generation, Review)<br/>'
        '• Job Queue Tables (pg-boss)'
    )
    p2_cells.append(
        f'<mxCell id="c2_db" value="{esc(lbl_db)}" style="{STYLE_DATABASE}" vertex="1" parent="c2_boundary">'
        f'<mxGeometry x="40" y="440" width="370" height="230" as="geometry" />'
        f'</mxCell>'
    )

    # Container 4: Local File System (Parent: c2_boundary, relative coords: x=480, y=440)
    lbl_filestorage = (
        '<b>Local File System</b><br/>'
        '<i>[Volume: ./data/assets &amp; ./data/exports]</i><br/><br/>'
        '• Lưu trữ Keyframe PNG, Video MP4 thô<br/>'
        '• Lưu trữ TTS Audio, BGM, Phụ đề ASS/SRT<br/>'
        '• Lưu trữ phim thành phẩm &amp; Manifest JSON<br/>'
        '• Đóng gói qua StorageAdapter interface'
    )
    p2_cells.append(
        f'<mxCell id="c2_filestorage" value="{esc(lbl_filestorage)}" style="{STYLE_DATABASE}" vertex="1" parent="c2_boundary">'
        f'<mxGeometry x="480" y="440" width="370" height="230" as="geometry" />'
        f'</mxCell>'
    )

    # External System 1: LLM API
    lbl_c2_llm_api = (
        '<b>LLM API</b><br/>'
        '<i>[External System - HTTPS / JSON]</i><br/>'
        '<i>Google Gemini / Claude</i><br/><br/>'
        'Sinh kịch bản phân cảnh (ShotSpec JSON)<br/>'
        'và Continuity Sheet'
    )
    p2_cells.append(
        f'<mxCell id="c2_llm_api" value="{esc(lbl_c2_llm_api)}" style="{STYLE_EXTERNAL}" vertex="1" parent="1">'
        f'<mxGeometry x="1280" y="150" width="270" height="120" as="geometry" />'
        f'</mxCell>'
    )

    # External System 2: AI Media Providers
    lbl_c2_video_apis = (
        '<b>AI Media Providers</b><br/>'
        '<i>[External System - HTTPS / JSON]</i><br/>'
        '<i>Google AI Studio (Gemini Omni 1.1 Flash) + fal.ai + Multi-Vendor</i><br/><br/>'
        'Tạo video MP4, keyframe ảnh &amp; quản lý task async'
    )
    p2_cells.append(
        f'<mxCell id="c2_video_apis" value="{esc(lbl_c2_video_apis)}" style="{STYLE_EXTERNAL}" vertex="1" parent="1">'
        f'<mxGeometry x="1280" y="330" width="270" height="140" as="geometry" />'
        f'</mxCell>'
    )

    # Component / Binary: FFmpeg CLI
    lbl_c2_ffmpeg_cli = (
        '<b>FFmpeg CLI Binary</b><br/>'
        '<i>[Container / OS Layer - Executable]</i><br/><br/>'
        'Concat clips, chèn logo tĩnh/overlay,<br/>'
        'trộn audio (TTS + BGM) &amp; burn phụ đề (ASS/SRT)'
    )
    p2_cells.append(
        f'<mxCell id="c2_ffmpeg_cli" value="{esc(lbl_c2_ffmpeg_cli)}" style="{STYLE_COMPONENT}" vertex="1" parent="1">'
        f'<mxGeometry x="1280" y="570" width="270" height="140" as="geometry" />'
        f'</mxCell>'
    )

    # Level 2 Relationships
    # 1. User -> WebApp
    rel_c2_1 = "HTTP / localhost:3000&#xa;Tạo kịch bản, duyệt shot, theo dõi chi phí"
    p2_cells.append(
        f'<mxCell id="c2_rel_1" value="{esc(rel_c2_1)}" style="{STYLE_EDGE};exitX=1.0;exitY=0.5;exitDx=0;exitDy=0;entryX=0.0;entryY=0.5;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_user" target="c2_webapp">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 2. WebApp -> DB
    rel_c2_2 = "Drizzle ORM (SQL)&#xa;Đọc/Ghi State, Reserve Budget,&#xa;Enqueue Job vào pg-boss"
    p2_cells.append(
        f'<mxCell id="c2_rel_2" value="{esc(rel_c2_2)}" style="{STYLE_EDGE};exitX=0.35;exitY=1.0;exitDx=0;exitDy=0;entryX=0.35;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_webapp" target="c2_db">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 3. WebApp -> FileStorage
    rel_c2_3 = "StorageAdapter.get()&#xa;Stream ảnh/video lên UI"
    p2_cells.append(
        f'<mxCell id="c2_rel_3" value="{esc(rel_c2_3)}" style="{STYLE_EDGE};exitX=0.85;exitY=1.0;exitDx=0;exitDy=0;entryX=0.0;entryY=0.3;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_webapp" target="c2_filestorage">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 4. WebApp -> LLM API (Via top corridor)
    rel_c2_4 = "HTTPS&#xa;Sinh ShotSpec JSON"
    p2_cells.append(
        f'<mxCell id="c2_rel_4" value="{esc(rel_c2_4)}" style="{STYLE_EDGE};exitX=0.75;exitY=0.0;exitDx=0;exitDy=0;entryX=0.0;entryY=0.3;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_webapp" target="c2_llm_api">'
        f'<mxGeometry relative="1" as="geometry">'
        f'<Array as="points">'
        f'<mxPoint x="638" y="115" />'
        f'<mxPoint x="1240" y="115" />'
        f'<mxPoint x="1240" y="186" />'
        f'</Array>'
        f'</mxGeometry>'
        f'</mxCell>'
    )

    # 5. Worker -> DB
    rel_c2_5 = "pg-boss Polling (SQL)&#xa;Nhận job &amp; update status,&#xa;Settle/Release Cost Ledger"
    p2_cells.append(
        f'<mxCell id="c2_rel_5" value="{esc(rel_c2_5)}" style="{STYLE_EDGE};exitX=0.0;exitY=0.75;exitDx=0;exitDy=0;entryX=0.85;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_worker" target="c2_db">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 6. Worker -> FileStorage
    rel_c2_6 = "StorageAdapter.put()&#xa;Lưu asset ngay khi tải xong"
    p2_cells.append(
        f'<mxCell id="c2_rel_6" value="{esc(rel_c2_6)}" style="{STYLE_EDGE};exitX=0.5;exitY=1.0;exitDx=0;exitDy=0;entryX=0.5;entryY=0.0;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_worker" target="c2_filestorage">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 7. Worker -> Video APIs
    rel_c2_7 = "HTTPS (Polling/Subscribe)&#xa;Gọi tạo ảnh/video &amp; kiểm tra quota"
    p2_cells.append(
        f'<mxCell id="c2_rel_7" value="{esc(rel_c2_7)}" style="{STYLE_EDGE};exitX=1.0;exitY=0.5;exitDx=0;exitDy=0;entryX=0.0;entryY=0.5;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_worker" target="c2_video_apis">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # 8. Worker -> FFmpeg CLI
    rel_c2_8 = "Child Process Spawn&#xa;Concat, Mix Audio, Burn Sub"
    p2_cells.append(
        f'<mxCell id="c2_rel_8" value="{esc(rel_c2_8)}" style="{STYLE_EDGE};exitX=1.0;exitY=0.85;exitDx=0;exitDy=0;entryX=0.0;entryY=0.3;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_worker" target="c2_ffmpeg_cli">'
        f'<mxGeometry relative="1" as="geometry">'
        f'<Array as="points">'
        f'<mxPoint x="1220" y="345" />'
        f'<mxPoint x="1220" y="612" />'
        f'</Array>'
        f'</mxGeometry>'
        f'</mxCell>'
    )

    # 9. FFmpeg CLI -> FileStorage
    rel_c2_9 = "Đọc clips/audio&#xa;&amp; Ghi MP4 hoàn chỉnh"
    p2_cells.append(
        f'<mxCell id="c2_rel_9" value="{esc(rel_c2_9)}" style="{STYLE_EDGE};exitX=0.0;exitY=0.75;exitDx=0;exitDy=0;entryX=1.0;entryY=0.75;entryDx=0;entryDy=0;" edge="1" parent="1" source="c2_ffmpeg_cli" target="c2_filestorage">'
        f'<mxGeometry relative="1" as="geometry" />'
        f'</mxCell>'
    )

    # Legend for Level 2
    legend_l2 = (
        '<b>Container Legend &amp; Tech Stack</b><br/><br/>'
        '• <font color="#23A2D9"><b>Light Blue Box:</b></font> Node.js / Next.js Container<br/>'
        '• <font color="#23A2D9"><b>Cylinder:</b></font> PostgreSQL Database / File Volume<br/>'
        '• <font color="#63BEF2"><b>Bright Blue Box:</b></font> Local OS Binary (FFmpeg)<br/>'
        '• <font color="#8C8496"><b>Grey Box:</b></font> External SaaS / AI API<br/>'
        '• <font color="#0D5091"><b>Dashed Boundary:</b></font> Local Host Workstation'
    )
    p2_cells.append(
        f'<mxCell id="c2_legend" value="{esc(legend_l2)}" style="{STYLE_LEGEND_BOX}" vertex="1" parent="1">'
        f'<mxGeometry x="1280" y="730" width="270" height="100" as="geometry" />'
        f'</mxCell>'
    )

    # Assemble XML
    def wrap_diagram_page(page_id, name, cells):
        return (
            f'  <diagram id="{page_id}" name="{name}">\n'
            f'    <mxGraphModel dx="1600" dy="1000" grid="1" gridSize="10" guides="1" '
            f'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
            f'pageWidth="1700" pageHeight="1100" math="0" shadow="0">\n'
            f'      <root>\n'
            f'        <mxCell id="0" />\n'
            f'        <mxCell id="1" parent="0" />\n'
            f'        ' + '\n        '.join(cells) + '\n'
            f'      </root>\n'
            f'    </mxGraphModel>\n'
            f'  </diagram>\n'
        )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<mxfile host="drawio" version="26.0.0">\n'
        + wrap_diagram_page("page-c4-l1", "C4 Level 1 - System Context", p1_cells)
        + wrap_diagram_page("page-c4-l2", "C4 Level 2 - Container Architecture", p2_cells)
        + '</mxfile>\n'
    )
    return xml

if __name__ == "__main__":
    out_path = r"d:\AI-Film-shorten-assitant\c4_model_architecture.drawio"
    content = generate_c4_xml()
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Generated {out_path} successfully ({len(content)} bytes)")
