import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { youtubeTokenFile } from "../config.js";
import { YOUTUBE_SCOPES, saveYoutubeToken } from "../integrations/video/publish.js";

/**
 * One-time YouTube login for the Auto Video tab: opens Google's consent
 * page, catches the redirect on a loopback port, and saves the refresh
 * token to data/video/youtube-token.json. Needs an OAuth client of type
 * "Desktop app" (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in .env).
 */
const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Thiếu YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET trong .env (OAuth client loại Desktop app).");
  process.exit(1);
}
const port = Number(process.env.YOUTUBE_AUTH_PORT ?? 53682);
const redirectUri = `http://127.0.0.1:${port}/callback`;
const state = randomBytes(16).toString("hex");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    // Without consent Google returns no refresh token for an account that approved before.
    prompt: "consent",
    state,
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== "/callback") return void res.writeHead(404).end();
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(`Đăng nhập không thành công: ${url.searchParams.get("error") ?? "sai state"}`);
    return;
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = (await tokenRes.json()) as { refresh_token?: string; error_description?: string };
  if (!tokenRes.ok || !body.refresh_token) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`Không lấy được refresh token: ${body.error_description ?? tokenRes.status}`);
    console.error("Không lấy được refresh token:", body);
    process.exit(1);
  }
  await saveYoutubeToken(youtubeTokenFile(), body.refresh_token);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Đã kết nối YouTube. Có thể đóng tab này.");
  console.log(`Đã lưu token vào ${youtubeTokenFile()}. Khởi động lại dashboard nếu nó đang chạy.`);
  server.close();
  process.exit(0);
});

server.listen(port, "127.0.0.1", () => {
  console.log("Mở đường link này trong trình duyệt và đăng nhập bằng tài khoản sở hữu kênh YouTube:\n");
  console.log(authUrl + "\n");
  console.log(`Đang chờ Google chuyển về ${redirectUri} …`);
});
