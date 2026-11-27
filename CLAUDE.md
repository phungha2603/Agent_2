# AI Agent Company — hướng dẫn cho Claude Code

Node 22 + TypeScript (ESM, `tsx`), Express + SSE, giao diện thuần JS. Trả lời và viết chữ giao diện bằng tiếng Việt; mã, tên biến, commit bằng tiếng Anh.

Luồng: Gemini (ý tưởng, thẩm định) → Claude (architecture, chốt cuối) → Muse (viết code, qua MCP) → build/test thật → CEO duyệt. `done` chỉ đạt ở `resolveCheckpoint`.

## Lệnh

- `npx tsc -p . --noEmit` — kiểm tra kiểu (phải sạch)
- `npx vitest run test/<file>.test.ts` — chạy file liên quan; cả bộ (`npx vitest run`, ~210 test) chỉ trước khi commit, và chỉ commit khi nó qua
- `node --check src/dashboard/public/app.js` — cú pháp giao diện
- `MOCK_DELAY_MS=1200 npm run dashboard` — chạy thử bằng agent giả (provider = mock)
- `npm run usage` — token theo bước/engine/task · `npm run muse:accounts` — tình trạng các tài khoản Muse

## Bản đồ mã

| Nơi | Vai trò |
|---|---|
| `orchestrator/pipeline.ts` | Máy trạng thái 1 task, prompt ở `PROMPTS`. Các chốt chặn: spec phải kết thúc bằng `FILES:`; file ngoài danh sách, không có rào code hoặc hỏng → lượt thất bại, không ghi gì |
| `orchestrator/scheduler.ts` (`Company`, ~1.900 dòng) | Hàng đợi, giới hạn engine, khoá `workspace`, bàn giao, thử lại, chỉ thị, cổng duyệt, tự duyệt (`afterWorker`), git (`recordInGit`), thông báo, snapshot UI |
| `orchestrator/planner.ts` | Kế hoạch Goal → Epic → Subtask; `project` riêng mỗi kế hoạch (thư mục — để trống thì tự tạo trong `PROJECTS_ROOT`, git init khi duyệt, tuỳ chọn repo GitHub riêng qua `gh` —, lệnh nền + lệnh riêng từng task, `handoffOn`, `autoApprove`, `skipClaudeReviewWhenGreen`) |
| `orchestrator/` khác | `projectFiles` (đọc sẵn file liên quan cho Claude/Muse) · `quota` (hết hạn mức → chờ giờ reset) · `contextPruning` · `compressForClaude` · `archRevision` · `handoff` · `rebalance` |
| `agents/` | `claude-cli.ts` (chế độ gọn; `tools`/`maxTurns`/`model` theo từng lượt) · `verdict.ts` (chỉ đọc dòng `VERDICT:`) · `muse.ts` (chỉ nhận markdown; bể gom profile theo người dùng Muse) · `gemini.ts` + `retry.ts` (bể key) · `mock.ts` |
| `verify/` | `workspace` (kiểm tra trong bản sao `data/workspaces/`, ghi vào dự án khi qua) · `fileChecks` (cú pháp, chữ đã render) · `survey` (quét dự án cho planner) · `gitProject` · `failureDigest` · `runner` (có timeout) |
| `dashboard/` | `server.ts` (API + SSE), `notify.ts` (thông báo macOS), `slots.ts`, `public/app.js` (~1.800 dòng) |
| `store/` | Ghi file nguyên tử vào `data/` (không commit) |

## Quy ước và bẫy

- Store lấy `data/` từ `process.cwd()` lúc import: test dùng `process.chdir(tmp)` + `vi.resetModules()` + `import()` động (xem `test/scheduler.test.ts`).
- Target ES2022 (không có `findLast`). Lỗi người dùng ném `UserError` (400). Ghi JSON dữ liệu qua `writeFileAtomic`.
- Comment chỉ để giải thích lý do khó thấy. Không thêm tính năng ngoài yêu cầu.
- Bước Claude review không có công cụ; architecture có `Read,Grep,Glob` + `--max-turns`. Đừng bật lại công cụ ở chỗ khác (mỗi file mở là một lượt gửi lại toàn bộ ngữ cảnh).
- Khoá `workspace` bao phần ghi + kiểm tra, không bao lượt chat Muse. Profile Muse cùng người dùng không bao giờ chạy song song.
- Nhánh: `claude/eager-ramanujan-ek5fpm`. Chỉ commit/push khi được yêu cầu.

## Tiết kiệm token

- `scheduler.ts`, `app.js`, `pipeline.ts` dài: Grep rồi Read có `offset`/`limit`, sửa bằng Edit nhỏ; không đọc lại file vừa sửa.
- Xem giao diện: tối đa 1–2 ảnh chụp, phần còn lại kiểm bằng số liệu (Playwright trả JSON).
- Khám phá rộng giao cho subagent. Phiên dài thì `/compact`, đổi việc thì `/clear`.
- Không ghi nhật ký phiên vào file này: lịch sử nằm ở commit message.
