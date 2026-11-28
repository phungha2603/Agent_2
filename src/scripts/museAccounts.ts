import "dotenv/config";
import { createMuseAgent } from "../agents/muse.js";
import { museProfileDirs } from "../config.js";

/**
 * Lists every Muse profile in MUSE_PROFILE_DIRS: logged in or not, and
 * which Muse user it is. Profiles that are the same user share one chat
 * thread — the dashboard never runs those at the same time, so only
 * distinct users add real parallel capacity.
 */
async function main(): Promise<void> {
  const server = process.env.MUSE_MCP_SERVER_PATH;
  if (!server) throw new Error("MUSE_MCP_SERVER_PATH is not set in .env");
  const dirs = museProfileDirs();
  const seen = new Map<string, string>();
  for (const dir of dirs) {
    const agent = createMuseAgent({ serverPath: server, profileDir: dir });
    const name = dir ?? "(default profile)";
    try {
      const id = await agent.identity!();
      if (!id.loggedIn) {
        console.log(`✗ ${name}: NOT logged in — run: MUSE_PROFILE_DIR=${name} npm run muse:login`);
      } else {
        const viewer = String(id.viewerId ?? "?");
        const twin = seen.get(viewer);
        console.log(`✓ ${name}: logged in as viewer ${viewer}${twin ? `  ← same Muse user as ${twin} (no extra capacity)` : ""}`);
        if (!twin) seen.set(viewer, name);
      }
    } catch (err) {
      console.log(`? ${name}: could not check (${(err as Error).message.slice(0, 160)})`);
    } finally {
      await agent.close?.();
    }
  }
  const concurrency = Number(process.env.MUSE_CONCURRENCY) || dirs.length;
  console.log(`\nDistinct logged-in Muse users: ${seen.size} · MUSE_CONCURRENCY=${concurrency}${concurrency > seen.size ? ` (only ${seen.size} can run at once)` : ""}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
