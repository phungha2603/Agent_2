import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Niche, PlatformPost, Script } from "./types.js";

/**
 * Uploads through the platforms' official APIs only. YouTube: OAuth refresh
 * token from `npm run video:youtube-auth`, resumable upload, synthetic-media
 * disclosure set. Facebook: a Page access token, Graph API video upload.
 */

export interface PublishMeta {
  script: Script;
  niche: Niche;
  privacy: "public" | "unlisted" | "private";
}

export interface Publisher {
  readonly youtubeReady: boolean;
  readonly facebookReady: boolean;
  youtube(video: string, thumbnail: string | undefined, meta: PublishMeta): Promise<PlatformPost>;
  facebook(video: string, meta: PublishMeta): Promise<PlatformPost>;
  youtubeViews(id: string): Promise<number | undefined>;
  facebookViews(id: string): Promise<number | undefined>;
}

export interface YoutubeAuth {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
}

export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

export async function saveYoutubeToken(tokenFile: string, refreshToken: string): Promise<void> {
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, JSON.stringify({ refresh_token: refreshToken, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

async function readRefreshToken(tokenFile: string): Promise<string | undefined> {
  try {
    return JSON.parse(await readFile(tokenFile, "utf8")).refresh_token;
  } catch {
    return undefined;
  }
}

/** YouTube categories: 27 = Education, 1 = Film & Animation. */
const CATEGORY: Record<Niche, string> = { explainer: "27", series: "1" };

export function youtubeMetadata(meta: PublishMeta) {
  return {
    snippet: {
      title: meta.script.title,
      description: meta.script.description,
      tags: meta.script.tags,
      categoryId: CATEGORY[meta.niche],
      defaultLanguage: "vi",
      defaultAudioLanguage: "vi",
    },
    status: {
      privacyStatus: meta.privacy,
      selfDeclaredMadeForKids: false,
      // AI voice and AI images: YouTube asks creators to disclose realistic synthetic media.
      containsSyntheticMedia: true,
    },
  };
}

export function createPublisher(opts: {
  youtube?: YoutubeAuth;
  facebook?: { pageId: string; pageToken: string; graphVersion?: string };
  fetchImpl?: typeof fetch;
}): Publisher {
  const f = opts.fetchImpl ?? fetch;
  const graph = opts.facebook?.graphVersion ?? "v23.0";
  let access: { token: string; until: number } | undefined;

  async function youtubeToken(): Promise<string> {
    const yt = opts.youtube;
    if (!yt) throw new Error("YouTube chưa cấu hình (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET).");
    if (access && access.until > Date.now() + 60_000) return access.token;
    const refresh = await readRefreshToken(yt.tokenFile);
    if (!refresh) throw new Error("Chưa đăng nhập YouTube: chạy `npm run video:youtube-auth` một lần.");
    const res = await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: yt.clientId, client_secret: yt.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    if (!res.ok) throw new Error(`Làm mới token YouTube thất bại (${res.status}): ${(await res.text()).slice(0, 300)} — chạy lại \`npm run video:youtube-auth\`.`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    access = { token: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return access.token;
  }

  return {
    youtubeReady: Boolean(opts.youtube),
    facebookReady: Boolean(opts.facebook),

    async youtube(video, thumbnail, meta) {
      const token = await youtubeToken();
      const size = (await stat(video)).size;
      const init = await f("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify(youtubeMetadata(meta)),
      });
      const location = init.headers.get("location");
      if (!init.ok || !location) throw new Error(`YouTube từ chối tải lên (${init.status}): ${(await init.text()).slice(0, 400)}`);
      const put = await f(location, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(size) }, body: await readFile(video) });
      if (!put.ok) throw new Error(`Tải video lên YouTube lỗi (${put.status}): ${(await put.text()).slice(0, 400)}`);
      const { id } = (await put.json()) as { id: string };
      const post: PlatformPost = { id, url: `https://www.youtube.com/watch?v=${id}` };
      if (thumbnail) {
        // Custom thumbnails need a verified channel; the video is up either way.
        const th = await f(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
          body: await readFile(thumbnail),
        });
        if (!th.ok) post.error = `Video đã lên, nhưng chưa đặt được thumbnail (${th.status}) — kênh cần xác minh số điện thoại.`;
      }
      return post;
    },

    async facebook(video, meta) {
      const fb = opts.facebook;
      if (!fb) throw new Error("Facebook chưa cấu hình (FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN).");
      const form = new FormData();
      form.set("access_token", fb.pageToken);
      form.set("title", meta.script.title);
      form.set("description", meta.script.description);
      if (meta.privacy !== "public") form.set("published", "false");
      form.set("source", new Blob([await readFile(video)], { type: "video/mp4" }), path.basename(video));
      const res = await f(`https://graph-video.facebook.com/${graph}/${encodeURIComponent(fb.pageId)}/videos`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!res.ok || !body.id) throw new Error(`Facebook từ chối video (${res.status}): ${body.error?.message ?? "không rõ lý do"}`);
      return { id: body.id, url: `https://www.facebook.com/${fb.pageId}/videos/${body.id}` };
    },

    async youtubeViews(id) {
      const token = await youtubeToken();
      const res = await f(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`YouTube thống kê lỗi (${res.status})`);
      const body = (await res.json()) as { items?: { statistics?: { viewCount?: string } }[] };
      const v = body.items?.[0]?.statistics?.viewCount;
      return v === undefined ? undefined : Number(v);
    },

    async facebookViews(id) {
      const fb = opts.facebook;
      if (!fb) throw new Error("Facebook chưa cấu hình.");
      const res = await f(`https://graph.facebook.com/${graph}/${encodeURIComponent(id)}/video_insights/total_video_views/lifetime?access_token=${encodeURIComponent(fb.pageToken)}`);
      if (!res.ok) throw new Error(`Facebook thống kê lỗi (${res.status})`);
      const body = (await res.json()) as { data?: { values?: { value?: number }[] }[] };
      return body.data?.[0]?.values?.[0]?.value;
    },
  };
}
