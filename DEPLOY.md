# Deploy AI Agent Company lên server thật

Hướng dẫn từng bước để chạy dashboard 24/7 trên một VPS, truy cập bằng domain riêng
(ví dụ `https://agents.ten-cua-ban.com`) từ laptop hoặc điện thoại, **có đăng nhập**,
không mở cổng nào ra Internet.

```
Trình duyệt ──HTTPS──► Cloudflare (Access: hỏi email + mã OTP)
                              │  Tunnel (kết nối do server gọi ra, không mở cổng)
                              ▼
                VPS: cloudflared ─► 127.0.0.1:4000 dashboard (Node)
                                      ├─ Gemini API
                                      ├─ claude CLI (gói Pro/Max của bạn)
                                      └─ Muse-Chat-MCP ─► Chrome trên màn hình ảo :99
```

> ⚠️ **Vì sao phải có đăng nhập:** ai vào được dashboard là có thể ra lệnh cho các agent
> viết code vào server và chạy `VERIFY_COMMANDS`. Vì vậy dashboard mặc định chỉ nghe ở
> `127.0.0.1`, và sẽ **từ chối khởi động** nếu bạn mở nó ra mạng mà không đặt mật khẩu.

---

## 0. Trước khi bắt đầu: cân nhắc chỗ chạy Muse

Muse không có API — Muse-Chat-MCP điều khiển một Chrome **đã đăng nhập tài khoản Meta**.
Trên VPS, bạn sẽ đăng nhập Meta một lần qua màn hình ảo (bước 6). Rủi ro: Meta có thể
yêu cầu xác minh thêm hoặc chặn đăng nhập từ IP datacenter.

- **Phương án A (hướng dẫn này):** VPS. Nếu bước 6 đăng nhập Muse thành công → xong.
- **Phương án B (dự phòng):** chạy y hệt trên một máy luôn bật ở nhà (Mac mini / máy cũ
  cài Ubuntu). Muse đăng nhập bình thường (IP nhà), các bước domain + Cloudflare giữ nguyên.
  Trên macOS bỏ qua các bước Xvfb/VNC/systemd, chạy `npm start` bằng `launchd` hoặc `pm2`.

Đừng thử copy thư mục `.muse-profile` từ Mac lên Linux: cookie của Chrome trên macOS được
mã hoá bằng Keychain nên không dùng được trên máy khác.

---

## 1. Mua domain (đề xuất)

| Lựa chọn | Ưu điểm | Ghi chú |
|---|---|---|
| **Cloudflare Registrar** (`.com`, `.net`, `.dev`, `.io`…) | Bán theo giá gốc, không tăng giá năm sau, DNS nằm sẵn ở Cloudflare — khớp với bước 7–8 | Không bán đuôi `.vn` |
| Nhà đăng ký Việt Nam (Mắt Bão, PA Việt Nam, Nhân Hòa, iNET…) | Có `.vn`, `.com.vn` | Sau khi mua, đổi nameserver sang Cloudflare (bước 7) |

Gợi ý đặt tên: một domain thương hiệu ngắn (ví dụ `ten-cong-ty.com`) rồi dùng **subdomain**
`agents.ten-cong-ty.com` cho dashboard — domain chính vẫn dùng được cho việc khác.
Giá `.com` thường vào khoảng 10–15 USD/năm (kiểm tra giá hiện tại khi mua).

---

## 2. Thuê VPS

Cấu hình khuyến nghị:

- **CPU x86_64 (amd64)** — bắt buộc: Google Chrome không có bản Linux ARM, nên **đừng chọn
  máy ARM** (ví dụ dòng CAX của Hetzner, Graviton của AWS).
- **4 vCPU, 8 GB RAM, ≥ 80 GB SSD.** Chrome + mỗi lượt `claude -p` (một tiến trình riêng,
  chạy tối đa `CLAUDE_CONCURRENCY` cùng lúc) + việc build/test dự án đều ăn RAM. 4 GB chạy
  được nếu để `CLAUDE_CONCURRENCY=1`.
- **Ubuntu 24.04 LTS.**
- Vùng **Singapore** cho độ trễ thấp từ Việt Nam (Hetzner, DigitalOcean, Vultr, Linode đều
  có), hoặc nhà cung cấp trong nước (Viettel IDC, BizFly Cloud, FPT Cloud…).

Khi tạo máy, **thêm SSH key** của bạn (trên Mac: `cat ~/.ssh/id_ed25519.pub`; chưa có thì
tạo bằng `ssh-keygen -t ed25519`). Ghi lại địa chỉ IP của server.

---

## 3. Chuẩn bị server (chạy bằng tài khoản có `sudo`)

```bash
ssh root@IP_SERVER
```

Cập nhật hệ thống và cài các gói cần thiết:

```bash
apt update && apt -y upgrade
apt install -y git curl ufw xvfb x11vnc fluxbox
```

Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Google Chrome (cho Muse):

```bash
curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt install -y /tmp/chrome.deb
```

Tạo user riêng chạy hệ thống (**không có quyền sudo** — code do AI viết sẽ được build/test
dưới user này):

```bash
adduser --disabled-password --gecos "" aicompany
mkdir -p /home/aicompany/.ssh && cp ~/.ssh/authorized_keys /home/aicompany/.ssh/
chown -R aicompany:aicompany /home/aicompany/.ssh
```

Tường lửa: chỉ mở SSH (dashboard đi qua Tunnel nên **không cần mở 80/443/4000**):

```bash
ufw default deny incoming
ufw allow OpenSSH
ufw enable
```

Tắt đăng nhập SSH bằng mật khẩu (chỉ dùng key): sửa `/etc/ssh/sshd_config` thành
`PasswordAuthentication no`, rồi:

```bash
systemctl restart ssh
```

> Giữ cửa sổ SSH hiện tại mở và thử `ssh aicompany@IP_SERVER` ở một cửa sổ khác trước
> khi đóng, để chắc chắn bạn không tự khoá mình ngoài.

---

## 4. Cài ứng dụng (chạy bằng user `aicompany`)

```bash
ssh aicompany@IP_SERVER
```

```bash
git clone https://github.com/phungha2603/Agent_2.git
cd Agent_2
git checkout claude/eager-ramanujan-ek5fpm
npm ci
```

Muse-Chat-MCP (đặt cạnh thư mục ứng dụng):

```bash
cd ~ && git clone https://github.com/duclm1x1/Muse-Chat-MCP.git
cd Muse-Chat-MCP && npm install
```

Dự án mà đội AI sẽ xây (đây là `VERIFY_CWD` — nơi Muse ghi code và nơi chạy build/test):

```bash
mkdir -p ~/projects && cd ~/projects
git clone <repo-du-an-cua-ban> du-an
```

Cài sẵn mọi công cụ mà `VERIFY_COMMANDS` của dự án cần (ví dụ Node/npm đã có; Python,
Go… thì cài thêm).

---

## 5. Claude CLI trên server

Cài Claude Code (vào `~/.local/bin/claude`):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Tạo token đăng nhập dài hạn (dành cho server không có trình duyệt; cần gói Claude Pro/Max):

```bash
~/.local/bin/claude setup-token
```

Lệnh in ra một đường link: mở link trên laptop, đăng nhập, rồi dán mã vào terminal. Nó
in ra token — **chép lại**, sẽ đặt vào `.env` ở bước 7 với tên `CLAUDE_CODE_OAUTH_TOKEN`.

Kiểm tra (đặt token tạm vào biến môi trường):

```bash
cd ~/projects/du-an
CLAUDE_CODE_OAUTH_TOKEN=<token> ~/.local/bin/claude -p "Trả lời đúng một chữ: OK"
```

> Không muốn dùng gói Pro/Max trên server? Đặt `CLAUDE_PROVIDER=api` và `ANTHROPIC_API_KEY`
> (trả theo token) thay cho các bước trên.

---

## 6. Đăng nhập Muse một lần qua màn hình ảo

Bật màn hình ảo `:99` (sau bước 8 nó sẽ tự chạy bằng systemd; giờ chạy tay để đăng nhập):

```bash
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
DISPLAY=:99 fluxbox &
```

Đặt mật khẩu VNC và chia sẻ màn hình ảo **chỉ trong máy** (sẽ xem qua đường hầm SSH):

```bash
x11vnc -storepasswd
x11vnc -display :99 -localhost -rfbport 5900 -rfbauth ~/.vnc/passwd -forever &
```

**Trên Mac của bạn**, mở đường hầm rồi xem màn hình ảo:

```bash
ssh -N -L 5901:localhost:5900 aicompany@IP_SERVER
```

Finder → **Go** → **Connect to Server…** → `vnc://localhost:5901` → nhập mật khẩu VNC.
(Dùng cổng 5901 phía Mac để không đụng tính năng Screen Sharing của chính máy Mac.)

**Trên server**, mở cửa sổ đăng nhập Muse (đợi tới 15 phút):

```bash
cd ~/Agent_2
DISPLAY=:99 MUSE_MCP_SERVER_PATH=$HOME/Muse-Chat-MCP/muse-server.mjs MUSE_PROFILE_DIR=$HOME/Muse-Chat-MCP/.muse-profile npm run muse:login
```

Một cửa sổ Chrome hiện ra trong VNC → đăng nhập tài khoản Meta (làm cả bước xác minh
nếu Meta hỏi). Khi script báo đã đăng nhập, dọn dẹp:

```bash
pkill x11vnc; pkill fluxbox; pkill Xvfb
```

Nếu Meta không cho đăng nhập từ server → chuyển sang **Phương án B** ở bước 0.

---

## 7. Cấu hình `.env` trên server

```bash
cd ~/Agent_2 && cp .env.example .env && chmod 600 .env && nano .env
```

Các dòng cần đặt (ngoài những gì bạn đã dùng trên máy mình):

```dotenv
GEMINI_PROVIDER=real
GEMINI_API_KEY=...
GEMINI_MODEL=...

CLAUDE_PROVIDER=cli
CLAUDE_CLI_COMMAND=/home/aicompany/.local/bin/claude
CLAUDE_CODE_OAUTH_TOKEN=...

MUSE_PROVIDER=real
MUSE_MCP_SERVER_PATH=/home/aicompany/Muse-Chat-MCP/muse-server.mjs
MUSE_PROFILE_DIR=/home/aicompany/Muse-Chat-MCP/.muse-profile

VERIFY_CWD=/home/aicompany/projects/du-an
VERIFY_COMMANDS=npm ci,npm run build,npm test

# Dashboard: chỉ nghe trong máy; Cloudflare Tunnel kết nối vào đây.
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=4000
# Lớp đăng nhập thứ hai ngay trong ứng dụng (khuyến nghị, kể cả khi đã có Cloudflare Access).
DASHBOARD_USER=ceo
DASHBOARD_PASSWORD=<mật-khẩu-dài-ngẫu-nhiên>
```

Tạo mật khẩu ngẫu nhiên:

```bash
openssl rand -base64 24
```

---

## 8. Chạy 24/7 bằng systemd (chạy bằng tài khoản có `sudo`)

```bash
cp /home/aicompany/Agent_2/deploy/systemd/xvfb.service /etc/systemd/system/
cp /home/aicompany/Agent_2/deploy/systemd/ai-company.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now xvfb ai-company
```

Kiểm tra:

```bash
systemctl status ai-company
curl -s localhost:4000/healthz
journalctl -u ai-company -f
```

Phải thấy `{"ok":true}` và dòng log `AI Company dashboard: http://localhost:4000 (login required)`.

---

## 9. Đưa lên domain bằng Cloudflare Tunnel + Access

1. **Thêm domain vào Cloudflare** (bỏ qua nếu mua ở Cloudflare Registrar):
   dash.cloudflare.com → **Add a domain** → chọn gói **Free** → Cloudflare cho 2 nameserver
   → vào trang quản lý domain ở nhà đăng ký, thay nameserver bằng 2 cái đó → đợi tới khi
   Cloudflare báo domain **Active** (thường vài phút, có khi vài giờ).

2. **Tạo Tunnel:** Cloudflare dashboard → **Zero Trust** (lần đầu chọn gói Free; có thể được
   yêu cầu thêm phương thức thanh toán dù miễn phí) → **Networks → Tunnels → Create a tunnel**
   → loại **Cloudflared** → đặt tên `ai-company` → chọn môi trường **Debian, 64-bit** →
   copy khối lệnh cài đặt nó đưa ra (gồm `sudo cloudflared service install <TOKEN>`) và chạy
   trên server bằng tài khoản có `sudo`. Khi trang báo **Connected** → Next.

3. **Public hostname** của tunnel: Subdomain `agents`, Domain `ten-cua-ban.com`,
   Service **HTTP**, URL `localhost:4000` → Save.

4. **Bắt đăng nhập (Access):** Zero Trust → **Access → Applications → Add an application** →
   **Self-hosted** → Application domain `agents.ten-cua-ban.com` → thêm Policy: Action
   **Allow**, Include **Emails** = email của bạn (thêm email người khác nếu muốn cho họ
   xem) → phương thức đăng nhập **One-time PIN** → Save.

Giờ mở `https://agents.ten-cua-ban.com`: Cloudflare hỏi email → gửi mã → nhập mã → trình
duyệt hỏi tiếp user/mật khẩu của dashboard (bước 7) → vào dashboard. Thử cả trên điện thoại.

> Không muốn mua domain? Dùng **Tailscale** (miễn phí): cài trên server và trên máy của
> bạn, rồi mở `http://<tên-máy-tailscale>:4000` — chỉ thiết bị trong mạng Tailscale của bạn
> vào được. Khi đó đặt `DASHBOARD_HOST` bằng IP Tailscale của server (100.x.y.z) và **bắt
> buộc** đặt `DASHBOARD_USER`/`DASHBOARD_PASSWORD`.

---

## 10. Vận hành hằng ngày

Cập nhật phiên bản mới:

```bash
cd ~/Agent_2 && git pull && npm ci
```

```bash
sudo systemctl restart ai-company
```

Khởi động lại sẽ huỷ các lượt AI đang chạy dở; khi lên lại, các task tự chạy tiếp từ bước
đó (task đang chờ duyệt vẫn giữ nguyên).

Sao lưu hằng ngày (thư mục `data/`: task, kế hoạch, toàn bộ prompt/output) — thêm vào
crontab của user `aicompany` (`crontab -e`):

```cron
30 3 * * * /home/aicompany/Agent_2/deploy/backup.sh
```

Xem log: `journalctl -u ai-company -f`. Phiên đăng nhập Muse hết hạn → lặp lại bước 6.

---

## Danh sách kiểm tra bảo mật

- [ ] Dashboard nghe ở `127.0.0.1` (`DASHBOARD_HOST`), chỉ vào được qua Tunnel/Tailscale.
- [ ] Cloudflare Access chỉ cho email của bạn; `DASHBOARD_USER`/`DASHBOARD_PASSWORD` đã đặt.
- [ ] `ufw` chỉ mở SSH; SSH chỉ dùng key.
- [ ] Ứng dụng chạy bằng user `aicompany` không có `sudo`.
- [ ] `.env` có quyền `600`; không commit `.env` lên git.
- [ ] Server chỉ dùng cho việc này — code do AI viết được build/test trên đó, đừng để
      chung khoá/bí mật của hệ thống khác.
