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
| `src/orchestrator/pipeline.ts` | Máy trạng thái 1 task: ideation → architecture ↔ architecture_review → implementation → verification → review_gemini → review_claude → checkpoint. Prompt của từng bước nằm ở `PROMPTS`. Khi Gemini sập ở `review_gemini`, Claude làm gộp "review độc lập + chốt cuối" trong **một** lượt gọi (`reviewClaudeFallback`, `applyReviewVerdict`) thay vì hai lượt Claude liên tiếp (review_gemini-fallback rồi review_claude). Bản nháp architecture đầu tiên viết ngắn gọn (`PROMPTS.architecture`); từ vòng sửa thứ 2 trở đi, Claude chỉ trả lời bằng **diff chuẩn** so với bản hiện tại (`PROMPTS.architectureRevision`), hệ thống áp patch thật qua `applyArchitectureRevision` (gói `diff`) — nếu patch không áp được (Claude không trả diff hợp lệ), tự rơi về coi nguyên văn trả lời là bản spec mới, không bao giờ kẹt pipeline |
| `src/orchestrator/scheduler.ts` (`Company`, ~1.700 dòng) | Hàng đợi từng nhân sự, giới hạn engine, khoá thư mục, bàn giao, thử lại, pause/stop, chỉ thị, cổng duyệt, gán lại, cân tải, timeline, snapshot cho giao diện |
| `src/orchestrator/planner.ts` | Kế hoạch Goal → Epic → Subtask (Claude soạn, Gemini thẩm định) và biến kế hoạch thành task. Mỗi kế hoạch có `project` riêng (thư mục + `verifyCommands`, Claude đề xuất, CEO xác nhận); không có lệnh thì không duyệt được |
| Chốt chặn chất lượng | `agents/verdict.ts`: verdict chỉ đọc từ dòng cuối `VERDICT: APPROVE/REJECT`, không có → hỏi lại 1 lần → coi là từ chối. `verify/fileChecks.ts`: chặn chữ đã render markdown (ký tự KaTeX…) và kiểm tra cú pháp (py, sh, js, swift, json, yaml, pbxproj) trước khi ghi và lại ở verification. `applyImplementation`: file phải nằm trong khối code có rào; không có file / file hỏng = lượt thất bại, không sang verification. Bước architecture & review cuối của Claude chạy `Read,Grep,Glob` trong thư mục dự án của task; spec rỗng/lệnh gọi công cụ giả bị bắt viết lại. `task.alerts` = cảnh báo cho CEO; cảnh báo đỏ ở checkpoint cuối buộc xác nhận lần 2 (`confirmWarnings`) và bị bỏ qua khi "duyệt tất cả" |
| `rebalance.ts`, `handoff.ts`, `contextPruning.ts`, `archRevision.ts`, `compressForClaude.ts`, `semaphore.ts`, `usageReport.ts` | Đề xuất cân tải · gói bàn giao · cắt ngữ cảnh theo bước · áp diff/patch cho bản sửa architecture (`applyArchitectureRevision`, dùng gói `diff`) · nhờ Gemini tóm log/diff/feedback dài trước khi gọi Claude (`compressForClaude`, chỉ khi > 4000 ký tự, luôn fail-open) · semaphore có tên · báo cáo token |
| `src/agents/` | `claude-cli.ts` (CLI, chế độ gọn), `claude.ts` (API), `gemini.ts` (bể key: xoay round-robin mỗi lượt gọi + xoay ngay khi 429), `muse.ts` (MCP; chỉ nhận câu trả lời có `replyFormat` markdown-copy/markdown-dom — chữ đọc từ trang đã render bị từ chối; `createMusePoolAgent` gộp nhiều tài khoản/profile; mỗi account tự kết nối lại khi phiên chết giữa chừng — lượt kết nối mới luôn **chờ** Chrome cũ đóng hẳn trước, tránh 2 tiến trình tranh cùng thư mục profile khiến phải đăng nhập lại), `mock.ts`, `limited.ts` (giới hạn engine + ghi từng lượt gọi), `retry.ts` (`withRetry`, bể key dùng chung cho Gemini), `streamParsers.ts` |
| `src/dashboard/` | `server.ts` (API + SSE), `slots.ts` (10 nhân sự, 3 bậc, trạng thái lưu), `auth.ts`; `public/app.js` (~1.700 dòng), `style.css`, `index.html`. `TaskSnapshot` (scheduler.ts) có sẵn `architectureRounds`/`reviewRejections` cho UI hiện số vòng/số lần từ chối; dây nối (`#edges`) tự sáng (`edge-active`) khi task đích đang `running` và đã nhận handoff từ task nguồn, bất kể bật/tắt "Đường nối" |
| Cô lập & lập kế hoạch | `verify/workspace.ts`: verification chạy trong bản sao `data/workspaces/` (rsync, giữ cache build), file chỉ được ghi vào dự án khi qua kiểm tra (`VERIFY_ISOLATE=0` để tắt). `verify/survey.ts`: quét dự án có sẵn (file hỏng, test rỗng) đưa vào prompt lập kế hoạch. Mỗi subtask/epic có `verifyCommands` riêng cộng với bộ nền của kế hoạch; build iOS phải dùng máy Simulator cụ thể (`commandWarnings`). Bản thiết kế phải kết thúc bằng `FILES:` — Muse ghi file ngoài danh sách thì cả lượt bị từ chối. `context.ceoRequests` giữ yêu cầu sửa của CEO tới lúc ship, reviewer phải đối chiếu từng cái. `orchestrator/quota.ts`: hết hạn mức Claude thì tạm dừng tới giờ reset rồi tự chạy lại. `handoffOn` theo từng kế hoạch (mặc định `done` khi sửa dự án có sẵn) |
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
