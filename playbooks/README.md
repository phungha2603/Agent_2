# Playbook theo vai trò

Mỗi file `AG-xx.md` mô tả năng lực thật của một vị trí. Khi một task thuộc vị trí đó chạy, các mục dưới đây được chèn vào prompt của đúng bước:

| Mục | Dùng ở bước | Ai đọc |
|---|---|---|
| `## Năng lực` | ý tưởng, kiến trúc | Gemini, Claude |
| `## Khi thiết kế` | kiến trúc, thẩm định kiến trúc | Claude, Gemini |
| `## Khi viết code` | viết code | Muse |
| `## Khi review` | thẩm định kiến trúc, review | Gemini, Claude |
| `## Không làm` | ý tưởng, kiến trúc | Gemini, Claude |
| `## Bài học` | kiến trúc, viết code, review | cả ba |

Dòng `> Tóm tắt:` ở đầu file chỉ để người đọc; Sếp lập kế hoạch dựa trên `summary` trong `src/org/roles.ts`.

Bài học mới tích luỹ sau mỗi dự án được lưu ở `data/lessons.json` (bạn duyệt trên dashboard) và được chèn cùng mục `## Bài học`. Bài học nào đáng giữ lâu dài thì chép vào đây.

## Nguồn tham khảo

Một số tiêu chí được viết lại, rút gọn từ các nguồn sau (không chép nguyên văn):

- Nguyên tắc viết code gọn, sửa đúng chỗ, ghi giả định — [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills): các vị trí viết code.
- Checklist chuyên môn theo vai trò — [awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) của VoltAgent.
- Tiêu chí thiết kế giao diện — [unslop](https://github.com/heydamir/unslop) của Damir Sokolovsky (CC BY 4.0), và các skill `frontend-design`, `webapp-testing` trong [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0): AG-06, AG-16.

Playbook không bao giờ thay thế các luật chung: lệnh kiểm tra chạy thật là bằng chứng duy nhất, chỉ được ghi file trong dòng `FILES:`, và chỉ thị của CEO luôn được ưu tiên.
