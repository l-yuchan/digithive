import { expect, test } from "bun:test";
import { startServer } from "../../src/server/server";

function cookieFrom(setCookie: string | null): string {
  return setCookie ? setCookie.split(";")[0]! : "";
}

test("no passphrase keeps the app open", async () => {
  const server = startServer({ port: 0, dbPath: ":memory:", passphrase: "" });
  try {
    const res = await fetch(server.url + "/api/entries");
    expect(res.status).toBe(200);
  } finally { server.close(); }
});

test("passphrase gates the API until login", async () => {
  const server = startServer({ port: 0, dbPath: ":memory:", passphrase: "correct horse" });
  try {
    const gated = await fetch(server.url + "/api/entries");
    expect(gated.status).toBe(401);
    expect((await gated.json() as { error: { code: string } }).error.code).toBe("auth_required");

    const status = await fetch(server.url + "/api/auth/status");
    const statusBody = await status.json() as { enabled: boolean; authenticated: boolean };
    expect(statusBody).toEqual({ enabled: true, authenticated: false });

    const wrong = await fetch(server.url + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "nope" }),
    });
    expect(wrong.status).toBe(401);

    const login = await fetch(server.url + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login.headers.get("set-cookie"));
    expect(cookie.startsWith("digithive_session=")).toBe(true);

    const open = await fetch(server.url + "/api/entries", { headers: { cookie } });
    expect(open.status).toBe(200);
  } finally { server.close(); }
});

test("public host is accepted by the Host check", async () => {
  const server = startServer({ port: 0, dbPath: ":memory:", passphrase: "", publicHost: "digithive.chanoil.com" });
  try {
    const res = await fetch(server.url + "/api/auth/status", { headers: { host: "digithive.chanoil.com" } });
    expect(res.status).toBe(200);
    const refused = await fetch(server.url + "/api/auth/status", { headers: { host: "evil.example" } });
    expect(refused.status).toBe(403);
  } finally { server.close(); }
});
