import { openDatabase } from "./db";
import { Store } from "./store";
import { createApi } from "./api";
import { jsonReply } from "./api_util";
import { AuthGate } from "./auth";

// Entry point: one Bun.serve process serving the JSON API and a whitelisted
// static UI from a single origin. Safety at the boundary:
// - binds to DIGITHIVE_HOST (default 127.0.0.1; use 0.0.0.0 inside a private
//   docker network behind Caddy);
// - the Host header must be loopback or DIGITHIVE_PUBLIC_HOST (blocks DNS
//   rebinding while allowing the public domain through the proxy);
// - non-GET /api requests with an Origin header must be same-origin;
// - when DIGITHIVE_PASSPHRASE is set, every /api route except the auth
//   endpoints requires the signed session cookie (see auth.ts).

export interface ServerOptions {
  hostname?: string;
  port?: number;
  dbPath?: string;
  publicDir?: string;
  backupDir?: string;
  now?: () => Date;
  passphrase?: string;
  publicHost?: string;
  secureCookie?: boolean;
  sessionTtlSeconds?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  hostname: string;
  dbPath: string;
  store: Store;
  auth: AuthGate;
  close: () => void;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function hostnameOf(hostHeader: string): string {
  return hostHeader.toLowerCase().split(":")[0]!.replace(/^\[|\]$/g, "");
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

async function serveStatic(req: Request, pathname: string, publicDir: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonReply(404, { error: { code: "not_found", message: "not found" } });
  }
  const entry = STATIC_FILES[pathname];
  if (!entry) {
    return jsonReply(404, { error: { code: "not_found", message: "no static file for " + pathname } });
  }
  const file = Bun.file(publicDir + "/" + entry.file);
  if (!(await file.exists())) {
    return jsonReply(404, { error: { code: "not_found", message: "static file " + entry.file + " not built" } });
  }
  return new Response(file, {
    status: 200,
    headers: { "content-type": entry.type, "cache-control": "no-store" },
  });
}

export function startServer(options: ServerOptions = {}): RunningServer {
  const hostname = options.hostname ?? process.env.DIGITHIVE_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.DIGITHIVE_PORT ?? 3000);
  const dbPath = options.dbPath ?? process.env.DIGITHIVE_DB ?? "data/digithive.sqlite";
  const publicDir = options.publicDir ?? process.env.DIGITHIVE_PUBLIC_DIR ?? "public";
  const backupDir = options.backupDir ?? process.env.DIGITHIVE_BACKUP_DIR ?? "backups";
  const now = options.now ?? (() => new Date());
  const passphrase = options.passphrase ?? process.env.DIGITHIVE_PASSPHRASE ?? "";
  const publicHost = options.publicHost ?? process.env.DIGITHIVE_PUBLIC_HOST ?? "";
  const secureCookie = options.secureCookie ?? (process.env.DIGITHIVE_COOKIE_SECURE ?? "true") !== "false";
  const sessionTtlSeconds = options.sessionTtlSeconds ?? Number(process.env.DIGITHIVE_SESSION_TTL_SECONDS ?? 2592000);

  const db = openDatabase(dbPath);
  const store = new Store(db);
  const api = createApi({ store, now, backupDir });
  const auth = new AuthGate({ passphrase, secureCookie, sessionTtlSeconds });

  const allowedHosts = new Set<string>(LOOPBACK_HOSTNAMES);
  if (publicHost) allowedHosts.add(hostnameOf(publicHost));

  const server = Bun.serve({
    hostname,
    port,
    fetch: async (req: Request): Promise<Response> => {
      const hostHeader = req.headers.get("host") ?? "";
      const requestHost = hostnameOf(hostHeader);
      if (!allowedHosts.has(requestHost)) {
        return jsonReply(403, {
          error: { code: "validation_error", message: "request host is not allowed", details: { host: hostHeader } },
        });
      }
      const url = new URL(req.url);
      const pathname = normalizePath(url.pathname);
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        if (isMutation(req.method)) {
          const origin = req.headers.get("origin");
          if (origin !== null) {
            let originHost: string | null = null;
            try {
              originHost = hostnameOf(new URL(origin).host);
            } catch {
              originHost = null;
            }
            const originOk = originHost !== null && (originHost === requestHost || allowedHosts.has(originHost));
            if (!originOk) {
              return jsonReply(403, {
                error: { code: "validation_error", message: "cross-origin request rejected", details: { origin } },
              });
            }
          }
        }
        if (pathname === "/api/auth/status") return auth.status(req);
        if (pathname === "/api/auth/login") return auth.login(req, clientIp(req));
        if (pathname === "/api/auth/logout") return auth.logout();
        if (!auth.authenticated(req)) {
          return jsonReply(401, {
            error: { code: "auth_required", message: "authentication required" },
          });
        }
        return api.handle(req);
      }
      return serveStatic(req, pathname, publicDir);
    },
  });

  return {
    url: "http://" + hostname + ":" + server.port,
    port: server.port ?? port,
    hostname,
    dbPath,
    store,
    auth,
    close: () => {
      server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const running = startServer();
  console.log("digithive listening at " + running.url + " (db: " + running.dbPath + ")");
  console.log("mode: offline_rules; auth " + (running.auth.enabled ? "enabled" : "disabled"));
}
