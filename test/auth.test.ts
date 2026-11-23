import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { basicAuth, isLoopback } from "../src/dashboard/auth.js";

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve(): Promise<string> {
  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(basicAuth("ceo", "s3cret:with:colons"));
  app.get("/api/status", (_req, res) => res.json({ secret: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const header = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });

describe("basicAuth", () => {
  it("lets the right credentials through, password colons included", async () => {
    const base = await serve();
    const res = await fetch(`${base}/api/status`, { headers: header("ceo", "s3cret:with:colons") });
    expect(res.status).toBe(200);
  });

  it("rejects no credentials, a wrong password and a wrong user, and asks the browser to log in", async () => {
    const base = await serve();
    for (const headers of [{}, header("ceo", "nope"), header("someone", "s3cret:with:colons")]) {
      const res = await fetch(`${base}/api/status`, { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic/);
    }
  });

  it("leaves the health check open for uptime monitors", async () => {
    const base = await serve();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("isLoopback", () => {
  it("knows which hosts only this machine can reach", () => {
    expect(["127.0.0.1", "localhost", "::1"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.5", "::"].some(isLoopback)).toBe(false);
  });
});
