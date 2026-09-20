import test from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/server/index.js";
import { fixtureBackend } from "./fixtures.mjs";
const env = {
  DAILY_PAPER_API_ORIGIN: "https://fixture.example.test",
  DAILY_PAPER_ACCESS_CLIENT_ID: "fixture-client-id",
  DAILY_PAPER_ACCESS_CLIENT_SECRET: "fixture-secret-value",
  DAILY_PAPER_SITE_ALLOWED_EMAIL: "owner@example.test",
};
const headers = {
  "oai-authenticated-user-id": "fixture-user",
  "oai-authenticated-user-email": "owner@example.test",
};
test("built Worker serves routes with CSP and no bundled credentials", async () => {
  for (const path of [
    "/",
    "/papers",
    "/paper",
    "/profile",
    "/operations",
    "/history",
    "/app.js",
    "/styles.css",
  ]) {
    const response = await worker.fetch(
      new Request(`https://site.test${path}`, { headers }),
      env,
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-security-policy"),
      /connect-src 'self'/,
    );
    const body = await response.text();
    assert.doesNotMatch(
      body,
      /fixture-secret-value|fixture-client-id|postgresql:\/\//,
    );
  }
});
test("production Worker never accepts fixture or localhost auth bypass", async () => {
  assert.equal(
    (
      await worker.fetch(new Request("http://localhost/api/bridge/feed"), {
        ...env,
        TEST_MODE: "true",
      })
    ).status,
    401,
  );
  const response = await worker.fetch(
    new Request("https://site.test/profile"),
    env,
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /\/signin-with-chatgpt/);
});
test("Save, Dismiss, Promote and summary edits persist via the exact cloud HTTP boundary and read back", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fixtureBackend();
  try {
    for (const action of ["save", "dismiss", "promote"]) {
      const result = await worker.fetch(
        new Request("https://site.test/api/bridge/feedback", {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            Origin: "https://site.test",
          },
          body: JSON.stringify({
            runId: "fixture-run",
            candidateId: "fixture-paper-1",
            action,
          }),
        }),
        env,
      );
      assert.equal(result.status, 200);
      const log = (await result.json()).log;
      const history = await worker.fetch(
        new Request("https://site.test/api/bridge/logs?runId=fixture-run", {
          headers,
        }),
        env,
      );
      assert.ok(
        (await history.json()).logs.some(
          (entry) => entry.id === log.id && entry.actionType === action,
        ),
      );
    }
    const summary = {
      researchQuestion: "fixture correction",
      method: "m",
      mainFinding: "f",
      relevanceToUser: "r",
    };
    const edit = await worker.fetch(
      new Request("https://site.test/api/bridge/content", {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Origin: "https://site.test",
        },
        body: JSON.stringify({ candidateId: "fixture-paper-1", summary }),
      }),
      env,
    );
    assert.equal(edit.status, 200);
    const feed = await worker.fetch(
      new Request("https://site.test/api/bridge/feed", { headers }),
      env,
    );
    assert.equal(
      (await feed.json()).feed.recommendations[0].summary.researchQuestion,
      "fixture correction",
    );
  } finally {
    globalThis.fetch = original;
  }
});
