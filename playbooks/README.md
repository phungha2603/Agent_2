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

Playbook không bao giờ thay thế các luật chung: lệnh kiểm tra chạy thật là bằng chứng duy nhất, chỉ được ghi file trong dòng `FILES:`, và chỉ thị của CEO luôn được ưu tiên.
