// Test-only adapter. No production credentials, providers, DB or network fallback.
import { createServer } from "node:http";
import worker from "../dist/server/index.js";
import { fixtureBackend } from "./fixtures.mjs";
globalThis.fetch = fixtureBackend();
const env = {
  DAILY_PAPER_API_ORIGIN: "https://fixture.example.test",
  DAILY_PAPER_ACCESS_CLIENT_ID: "fixture-client-id",
  DAILY_PAPER_ACCESS_CLIENT_SECRET: "fixture-secret-value",
  DAILY_PAPER_SITE_ALLOWED_EMAIL: "fixture@example.test",
  DAILY_PAPER_GITHUB_REPOSITORY: "example/fixture",
};
createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers(req.headers);
    headers.set("oai-authenticated-user-id", "fixture-user");
    headers.set("oai-authenticated-user-email", "fixture@example.test");
    const request = new Request(`http://127.0.0.1:4317${req.url}`, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("fixture failed");
  }
}).listen(4317, "127.0.0.1", () =>
  console.log(
    "Isolated fixture preview: http://127.0.0.1:4317 (NOT PRODUCTION)",
  ),
);
