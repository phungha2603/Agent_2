import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * HTTP Basic auth for the whole dashboard. Anyone who can reach it can make
 * the agents write code into VERIFY_CWD and run VERIFY_COMMANDS there, so
 * it must never be reachable without a login — this is the in-app layer,
 * on top of (or instead of) an access proxy in front. The browser caches
 * the credentials for the origin, so fetch() and EventSource send them too.
 */
export function basicAuth(user: string, password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep !== -1 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
        next();
        return;
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="AI Company", charset="UTF-8"');
    res.status(401).send("Authentication required");
  };
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
