# AI Agent Company — hướng dẫn cho Claude Code

Node 22 + TypeScript (ESM, `tsx`), Express + Server-Sent Events, giao diện thuần JS. Người dùng nói tiếng Việt: trả lời và viết chữ trên giao diện bằng tiếng Việt; mã, tên biến, commit viết tiếng Anh.

Công ty AI: Gemini (ý tưởng, thẩm định) → Claude (architecture, chốt cuối) → Muse (viết code, qua MCP) → build/test thật → người duyệt. Không agent nào tự báo "xong"; `done` chỉ đạt được ở `resolveCheckpoint`.

## Lệnh

- `npx tsc -p . --noEmit` — kiểm tra kiểu (phải sạch)
- `npx vitest run test/<file>.test.ts` — chạy đúng file liên quan; chạy cả bộ (`npx vitest run`, ~120 test) chỉ trước khi commit
- `MOCK_DELAY_MS=1200 npm run dashboard` — chạy thử bằng agent giả, không tốn quota (`.env` để provider = mock)
- `npm run usage` — token đang đi vào bước/engine/task nào (đọc `data/calls`)
- `node --check src/dashboard/public/app.js` — kiểm tra cú pháp giao diện

## Bản đồ mã

| Nơi | Vai trò |
|---|---|
| `src/orchestrator/pipeline.ts` | Máy trạng thái 1 task: ideation → architecture ↔ architecture_review → implementation → verification → review_gemini → review_claude → checkpoint. Prompt của từng bước nằm ở `PROMPTS` |
| `src/orchestrator/scheduler.ts` (`Company`, ~1.700 dòng) | Hàng đợi từng nhân sự, giới hạn engine, khoá thư mục, bàn giao, thử lại, pause/stop, chỉ thị, cổng duyệt, gán lại, cân tải, timeline, snapshot cho giao diện |
| `src/orchestrator/planner.ts` | Kế hoạch Goal → Epic → Subtask (Claude soạn, Gemini thẩm định) và biến kế hoạch thành task |
| `rebalance.ts`, `handoff.ts`, `contextPruning.ts`, `semaphore.ts`, `usageReport.ts` | Đề xuất cân tải · gói bàn giao · cắt ngữ cảnh theo bước · semaphore có tên · báo cáo token |
| `src/agents/` | `claude-cli.ts` (CLI, chế độ gọn), `claude.ts` (API), `gemini.ts` (bể key, tự xoay khi 429), `muse.ts` (MCP; `createMusePoolAgent` gộp nhiều tài khoản/profile), `mock.ts`, `limited.ts` (giới hạn engine + ghi từng lượt gọi), `retry.ts` (`withRetry`, bể key dùng chung cho Gemini), `streamParsers.ts` |
| `src/dashboard/` | `server.ts` (API + SSE), `slots.ts` (10 nhân sự, 3 bậc, trạng thái lưu), `auth.ts`; `public/app.js` (~1.700 dòng), `style.css`, `index.html` |
| `src/store/` | Ghi file nguyên tử; `data/tasks`, `data/plans`, `data/calls`, `data/dashboard.json` (không commit) |

## Quy ước và bẫy

- Các store lấy `data/` từ `process.cwd()` **lúc import**. Test dùng thư mục tạm: `process.chdir(tmp)` + `vi.resetModules()` + `import()` động (xem `test/scheduler.test.ts`).
- Target là ES2022: không có `Array.prototype.findLast`.
- Không viết comment trừ khi giải thích một lý do khó thấy. Không thêm tính năng ngoài yêu cầu.
- Mọi ghi file JSON dữ liệu đi qua `writeFileAtomic`. Lỗi của người dùng ném `UserError` (trả 400, không crash).
- Mỗi tài khoản Muse chỉ có 1 trình duyệt: 1 lượt một lần *trên mỗi tài khoản* (khoá `muse`, giới hạn = số tài khoản trong `MUSE_PROFILE_DIRS`, mặc định 1). Khoá `workspace` chỉ bao phần ghi file (`applyImplementation`) và build/test ngay sau đó (liên tục, không nhả giữa hai bước) — **không** bao lượt chat với Muse (`draftImplementation`), để một task đang chờ Muse trả lời không chặn task khác ghi file/build.
- Claude CLI mặc định tắt công cụ/MCP/skill (≈3k token nền thay vì ≈37k). Đừng bật lại nếu không cần (`CLAUDE_CLI_TOOLS`).
- Nhánh làm việc: `claude/eager-ramanujan-ek5fpm`. Chỉ commit/push khi được yêu cầu hoặc đã được cho phép trong phiên.

## Tiết kiệm token khi làm việc

- `scheduler.ts` và `app.js` rất dài: dùng Grep để tìm, rồi Read với `offset`/`limit`; **không** đọc hoặc ghi lại nguyên file. Sửa bằng Edit nhỏ.
- Không đọc lại file vừa sửa; không chạy cả bộ test sau mỗi thay đổi nhỏ.
- Muốn xem giao diện: tối đa 1–2 ảnh chụp cho một tính năng, kiểm tra phần còn lại bằng số liệu (Playwright trả JSON).
- Việc khám phá rộng (tìm xem X ở đâu) giao cho subagent để không đổ kết quả thô vào ngữ cảnh chính.
- Phiên dài thì `/compact`, đổi việc khác thì `/clear`; việc đơn giản dùng model nhẹ hơn.
