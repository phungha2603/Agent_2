# AI Agent Company — hướng dẫn cho Claude Code

Node 22 + TypeScript (ESM, `tsx`), Express + SSE, giao diện thuần JS. Trả lời và viết chữ giao diện bằng tiếng Việt; mã, tên biến, commit bằng tiếng Anh.

Luồng: Gemini (ý tưởng, thẩm định) → Claude (architecture, chốt cuối) → Muse (viết code, qua MCP) → build/test thật + kiểm tra theo vai trò → CEO duyệt. `done` chỉ đạt ở `resolveCheckpoint`.

Công ty 16 vị trí / 5 khối (`src/org/roles.ts`): AG-01 Sếp; trưởng nhóm AG-05 Kỹ thuật, AG-11 Dữ liệu & AI, AG-08 Chất lượng & Phát hành, AG-12 Sản phẩm & Tăng trưởng; AG-01…10 giữ mã cũ, AG-11…16 mới. Mỗi vị trí có `playbooks/AG-xx.md` được chèn vào prompt của task thuộc vị trí đó.

## Lệnh

- `npx tsc -p . --noEmit` — kiểm tra kiểu (phải sạch)
- `npx vitest run test/<file>.test.ts` — chạy file liên quan; cả bộ (`npx vitest run`, ~232 test) chỉ trước khi commit, và chỉ commit khi nó qua
- `node --check src/dashboard/public/app.js` — cú pháp giao diện
- `MOCK_DELAY_MS=1200 npm run dashboard` — chạy thử bằng agent giả (provider = mock)
- `npm run usage` — token theo bước/engine/task · `npm run muse:accounts` — tình trạng các tài khoản Muse

## Bản đồ mã

| Nơi | Vai trò |
|---|---|
| `orchestrator/pipeline.ts` | Máy trạng thái 1 task, prompt ở `PROMPTS`. Các chốt chặn: spec phải kết thúc bằng `FILES:`; file ngoài danh sách, không có rào code hoặc hỏng → lượt thất bại, không ghi gì |
| `orchestrator/scheduler.ts` (`Company`, ~2.200 dòng) | Hàng đợi, giới hạn engine, khoá `workspace`, bàn giao, thử lại, chỉ thị, cổng duyệt, tự duyệt (`afterWorker`), git (`recordInGit`), thông báo, snapshot UI |
| `orchestrator/planner.ts` | Kế hoạch Goal → Epic → Subtask; `project` riêng mỗi kế hoạch (thư mục — để trống thì tự tạo trong `PROJECTS_ROOT`, git init khi duyệt, tuỳ chọn repo GitHub riêng qua `gh` —, lệnh nền + lệnh riêng từng task, `handoffOn`, `autoApprove`, `skipClaudeReviewWhenGreen`) |
| `orchestrator/` khác | `projectFiles` (đọc sẵn file liên quan cho Claude/Muse) · `quota` (hết hạn mức → chờ giờ reset) · `contextPruning` · `compressForClaude` · `archRevision` · `handoff` · `rebalance` |
| `org/` | `roles.ts` (vị trí, khối, `modelTier`, `checks`, cổng duyệt mặc định) · `playbooks.ts` (đọc `playbooks/*.md`, mỗi bước nhận mục riêng: `STAGE_SECTIONS`) · `lessons.ts` (bài học ở `data/lessons.json`; task ship sau khi bị trả về → đề xuất chờ CEO duyệt) · `runtime.ts` (`RoleSupport` gắn vào `PipelineConfig.roles`) |
| `agents/` | `claude-cli.ts` (chế độ gọn; `tools`/`maxTurns`/`model` theo từng lượt) · `verdict.ts` (chỉ đọc dòng `VERDICT:`) · `muse.ts` (chỉ nhận markdown; bể gom profile theo người dùng Muse) · `gemini.ts` + `retry.ts` (bể key) · `mock.ts` |
| `verify/` | `roleChecks` (secrets/stubs → trượt kiểm tra; tests/ios_destination → cảnh báo đỏ; chỉ xét file vừa ghi) · `workspace` (kiểm tra trong bản sao `data/workspaces/`, ghi vào dự án khi qua) · `fileChecks` (cú pháp, chữ đã render) · `survey` (quét dự án cho planner) · `gitProject` · `failureDigest` · `runner` (có timeout) |
| `dashboard/` | `server.ts` (API + SSE; `/api/roles/:id`, `/api/lessons/:id/:decision`, `/api/scoreboard`), `notify.ts` (thông báo macOS), `slots.ts` (`SLOTS` sinh từ `ROLES`), `public/app.js` (~2.600 dòng: sơ đồ cây theo khối, ngăn playbook, tab "Năng lực vị trí", theme sáng/tối), `public/style.css` (~1.300 dòng; các lớp sau ghi đè lớp trước, màu đi qua biến CSS) |
| `integrations/contentSeo.ts` | Tab "Auto Content SEO": chạy dự án Python có sẵn (`CONTENTSEO_DIR`) qua `scripts/run_once.py` của nó (một lượt mỗi lúc), bật/tắt bot Telegram, lịch sử ở `data/contentseo/runs.json` |
| `integrations/video/` | Tab "Auto Video": `service.ts` (máy trạng thái: nghiên cứu → kịch bản → **CEO duyệt** → giọng + ảnh → Remotion → **CEO xem** → đăng; một video mỗi lúc; file đặt tên theo hash để làm lại không vẽ lại ảnh cũ), `script.ts` (prompt + kiểm JSON), `providers.ts` (VieNeu-TTS chạy trên máy, tự bật server và nhớ giọng nhái · FLUX.2-klein-4B qua mflux: một tiến trình `mflux_worker.py` giữ model, mỗi lúc một ảnh · Openverse CC0 · Gemini ảnh · giả lập), `remotion/` (bố cục video + thumbnail), `lumreels.ts` (kiểu dựng thứ hai cho video giải thích: gửi lời đọc đã duyệt sang server LumReels, đợi MP4, đối chiếu lời đọc), `publish.ts` (YouTube resumable + Facebook Graph), dữ liệu ở `data/video/`. Đăng nhập YouTube: `npm run video:youtube-auth` |
| `store/` | Ghi file nguyên tử vào `data/` (không commit) |

## Repo bên ngoài của tab Auto Video

Tab Auto Video chạy bằng các dự án mã nguồn mở dưới đây, đều cho dùng thương mại và đều chạy trên máy này (trừ dịch vụ web ở cuối). Phiên bản ghi là bản đã kiểm thử ngày 28/11/2026.

| Việc | Repo / model | License | Nằm ở đâu trên máy | Phiên bản | Dashboard dùng thế nào |
|---|---|---|---|---|---|
| Giọng đọc tiếng Việt + nhái giọng | [pnnbao97/VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS), model `pnnbao-ump/VieNeu-TTS-v3-Turbo` | Apache-2.0 (code + model) | Code `~/VieNeu-TTS` (cài bằng `uv sync`); model trong `~/.cache/huggingface/hub` | commit `2e3532f` | `VIENEU_DIR` → tự bật `uv run python -m apps.openai_speech` ở cổng 8765; giọng nhái lưu ở `data/video/voices/` |
| Ảnh AI (phim + minh hoạ) | [mflux-community/mflux](https://github.com/mflux-community/mflux) + model [black-forest-labs/FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) | MIT (mflux) · Apache-2.0 (model) | mflux: `uv tool install mflux` (`~/.local/share/uv/tools/mflux`); model ~15 GB trong `~/.cache/huggingface/hub` | mflux 0.24.0 | `VIDEO_IMAGES=mflux` → tiến trình `src/integrations/video/mflux_worker.py`, 8-bit, giữ model trong RAM. **Không** dùng FLUX.2-klein-9B (giấy phép phi thương mại) |
| Motion graphics cho video giải thích | [lumtekvn/lumreels](https://github.com/lumtekvn/lumreels) (bên trong dùng HyperFrames Apache-2.0, GSAP giấy phép riêng miễn phí) | MIT | `~/lumreels` (`npm install`, cần `ffmpeg` từ Homebrew) | commit `3e19833` | `LUMREELS_DIR` → tự bật `node server/server.mjs` cổng 4400 với `LUMREELS_SKIP_UPDATE=1`, Python của VieNeu. **Không cài edge-tts** |
| Dựng video (kiểu ảnh + chuyển động) | [remotion-dev/remotion](https://github.com/remotion-dev/remotion) | Riêng: miễn phí cho cá nhân / công ty ≤ 3 người | `node_modules` của dự án này; Chrome headless tự tải lần đầu | `^4.0.547` (khoá trong `package-lock.json`) | `src/integrations/video/render.ts` + `remotion/` |
| Ảnh thật cho video giải thích | [Openverse API](https://api.openverse.org) (WordPress) | Chỉ lấy ảnh CC0 / miền công cộng | Dịch vụ web, không cài | — | Bật mặc định, không key; `VIDEO_STOCK=none` để tắt |

Đã cân nhắc và **không dùng**: Google TTS (tốn phí), Pexels (ngừng cấp key mới), edge-tts (dịch vụ Microsoft không chính thức), VieGem-ASR · viet-tts · v-tts · F5-TTS-Vietnamese · viXTTS · fish-speech · FLUX.2-klein-9B (model cấm thương mại).

Cập nhật một repo: vào thư mục của nó `git pull` (hoặc `uv tool upgrade mflux`), chạy thử một video, rồi sửa cột phiên bản ở bảng này. Model đã tải nằm trong `~/.cache/huggingface/hub`: xoá thư mục đó là phải tải lại từ Hugging Face.

## Quy ước và bẫy

- Store lấy `data/` từ `process.cwd()` lúc import: test dùng `process.chdir(tmp)` + `vi.resetModules()` + `import()` động (xem `test/scheduler.test.ts`).
- Target ES2022 (không có `findLast`). Lỗi người dùng ném `UserError` (400). Ghi JSON dữ liệu qua `writeFileAtomic`.
- Comment chỉ để giải thích lý do khó thấy. Không thêm tính năng ngoài yêu cầu.
- Bước Claude review không có công cụ; architecture có `Read,Grep,Glob` + `--max-turns`. Đừng bật lại công cụ ở chỗ khác (mỗi file mở là một lượt gửi lại toàn bộ ngữ cảnh).
- Khoá `workspace` bao phần ghi + kiểm tra, không bao lượt chat Muse. Profile Muse cùng người dùng không bao giờ chạy song song.
- Playbook/vai trò luôn **nối vào cuối** prompt (`withRole`), trước dòng `VERDICT_INSTRUCTION`: agent giả, `verdict.ts` và test nhận diện loại lời gọi bằng chữ đầu prompt (`REVIEW:`, `PLAN:`, `REBALANCE:`). Task không có `slotId` hợp lệ chạy y như trước.
- Thêm/đổi vị trí: sửa `ROLES` + tạo `playbooks/AG-xx.md` với đúng các tiêu đề `## Năng lực / Khi thiết kế / Khi viết code / Khi review / Không làm / Bài học` (`test/roles.test.ts` kiểm tra). Không đổi mã vị trí cũ: hàng đợi, task, cổng duyệt lưu theo mã.
- Model theo vai trò: `CLAUDE_MODEL_STRONG` (thiết kế + review), `CLAUDE_MODEL_LIGHT` (chỉ thiết kế); `ROLE_PLAYBOOKS=0` tắt toàn bộ phần vai trò.
- Kiểm tra theo vai trò không được ép điều Muse không làm được (file ngoài dòng `FILES:`) → loại đó chỉ là cảnh báo, không làm trượt.
- `index()` chỉ gồm task đang nằm trong hàng đợi; báo cáo toàn bộ lịch sử dùng `listAllTasks()`.
- Chụp giao diện: dùng Playwright trong `node_modules` (`chromium.launch({ executablePath: Chrome })`); `chrome --headless --screenshot` không chạy timer nên đường nối SVG không hiện.
- Nhánh làm việc: `claude/eager-ramanujan-ek5fpm`, PR vào `main`. Chỉ commit/push khi được yêu cầu.

## Tiết kiệm token

- `scheduler.ts`, `app.js`, `pipeline.ts` dài: Grep rồi Read có `offset`/`limit`, sửa bằng Edit nhỏ; không đọc lại file vừa sửa.
- Xem giao diện: tối đa 1–2 ảnh chụp, phần còn lại kiểm bằng số liệu (Playwright trả JSON).
- Khám phá rộng giao cho subagent. Phiên dài thì `/compact`, đổi việc thì `/clear`.
- Không ghi nhật ký phiên vào file này: lịch sử nằm ở commit message.
