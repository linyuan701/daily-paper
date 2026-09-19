import test from "node:test";
import assert from "node:assert/strict";
import { proxy, githubRuns } from "../src/proxy.mjs";
const env = {
  DAILY_PAPER_API_ORIGIN: "https://worker.example.test",
  DAILY_PAPER_ACCESS_CLIENT_ID: "fixture-client-id",
  DAILY_PAPER_ACCESS_CLIENT_SECRET: "fixture-secret-value",
  DAILY_PAPER_SITE_ALLOWED_EMAIL: "owner@example.test",
  DAILY_PAPER_GITHUB_REPOSITORY: "example/fixture",
};
const identity = {
  "oai-authenticated-user-id": "fixture-user",
  "oai-authenticated-user-email": "owner@example.test",
};
function request(name, { method = "GET", headers = {}, body, ...extra } = {}) {
  return new Request(`https://site.example.test/api/bridge/${name}`, {
    method,
    headers: { ...identity, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...extra,
  });
}
const mutation = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: "https://site.example.test",
    "Sec-Fetch-Site": "same-origin",
  },
  body: { runId: "fixture-run", candidateId: "fixture-paper", action: "save" },
};
test("missing identity or wrong owner cannot trigger upstream requests", async () => {
  for (const req of [
    new Request("https://site.example.test/api/bridge/feed"),
    request("feed", {
      headers: { "oai-authenticated-user-email": "other@example.test" },
    }),
  ]) {
    const result = await proxy(req, env, "feed", () =>
      assert.fail("must not fetch"),
    );
    assert.ok([401, 403].includes(result.status));
  }
  assert.equal(
    (
      await proxy(
        request("feed"),
        { ...env, DAILY_PAPER_SITE_ALLOWED_EMAIL: "" },
        "feed",
        () => assert.fail(),
      )
    ).status,
    403,
  );
});
test("a fixed HTTPS route forwards only server credentials and allowed query", async () => {
  const result = await proxy(
    request("feed?runId=fixture-run", {
      headers: { Cookie: "private-browser-cookie", Authorization: "untrusted" },
    }),
    env,
    "feed",
    async (url, init) => {
      assert.equal(
        url,
        "https://worker.example.test/api/recommendations/daily?runId=fixture-run&selectedOnly=true",
      );
      assert.equal(init.redirect, "manual");
      assert.equal(
        init.headers["CF-Access-Client-Secret"],
        env.DAILY_PAPER_ACCESS_CLIENT_SECRET,
      );
      assert.equal(init.headers.Cookie, undefined);
      assert.equal(init.headers.Authorization, undefined);
      return Response.json({ status: "ok", feed: null });
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
});
test("reject arbitrary paths, query parameters and methods", async () => {
  for (const [name, req] of [
    ["jobs", request("jobs")],
    ["feed", request("feed?url=https://evil.test")],
    ["refresh", request("refresh", { method: "POST" })],
  ]) {
    const response = await proxy(req, env, name, () => assert.fail());
    assert.ok([400, 404, 405].includes(response.status));
  }
});
test("refuse local, cleartext or credential-bearing upstream configuration", async () => {
  for (const origin of [
    "http://worker.example.test",
    "https://localhost",
    "https://127.0.0.1",
    "https://user:secret@worker.example.test",
    "https://worker.example.test/path",
  ]) {
    assert.equal(
      (
        await proxy(
          request("feed"),
          { ...env, DAILY_PAPER_API_ORIGIN: origin },
          "feed",
          () => assert.fail(),
        )
      ).status,
      503,
    );
  }
});
test("same-origin write forwards existing production contract without retry", async () => {
  let calls = 0;
  const response = await proxy(
    request("feedback", mutation),
    env,
    "feedback",
    async (url, init) => {
      calls++;
      assert.equal(url, "https://worker.example.test/api/feedback/actions");
      assert.equal(init.headers.Origin, env.DAILY_PAPER_API_ORIGIN);
      assert.deepEqual(JSON.parse(init.body), mutation.body);
      assert.equal(init.headers["Sec-Fetch-Site"], undefined);
      return Response.json({
        status: "ok",
        log: { id: "fixture-log", ...mutation.body },
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal((await response.json()).log.id, "fixture-log");
});
test("cross-origin, missing Origin and invalid content type writes fail before fetch", async () => {
  for (const headers of [
    { ...mutation.headers, Origin: "https://evil.test" },
    { "Content-Type": "application/json" },
    { ...mutation.headers, "Sec-Fetch-Site": "cross-site" },
    { ...mutation.headers, "Content-Type": "text/plain" },
  ]) {
    const response = await proxy(
      request("feedback", { ...mutation, headers }),
      env,
      "feedback",
      () => assert.fail(),
    );
    assert.ok([403, 415].includes(response.status));
  }
});
test("invalid action, client metadata, and oversized writes never reach backend", async () => {
  for (const body of [
    { ...mutation.body, action: "retry" },
    { ...mutation.body, metadata: { source: "forged" } },
    { ...mutation.body, candidateId: "x".repeat(70000) },
  ]) {
    assert.equal(
      (
        await proxy(
          request("feedback", { ...mutation, body }),
          env,
          "feedback",
          () => assert.fail(),
        )
      ).status,
      400,
    );
  }
});
test("redirects, HTML, credential reflection, and provider errors are not reflected", async () => {
  for (const reply of [
    new Response("private", {
      status: 302,
      headers: { Location: "https://login.test" },
    }),
    new Response("private", { headers: { "Content-Type": "text/html" } }),
    Response.json({
      status: "ok",
      value: env.DAILY_PAPER_ACCESS_CLIENT_SECRET,
    }),
    Response.json({ secret: "private" }, { status: 500 }),
  ]) {
    const result = await proxy(request("feed"), env, "feed", async () => reply);
    assert.equal(result.status, 502);
    assert.doesNotMatch(
      await result.text(),
      /private|fixture-secret-value|login.test/,
    );
  }
});
test("ambiguous mutations are not retried or falsely reported as failed writes", async () => {
  let calls = 0;
  const result = await proxy(
    request("feedback", mutation),
    env,
    "feedback",
    async () => {
      calls++;
      throw new Error("timeout with token fixture-secret-value");
    },
  );
  assert.equal(calls, 1);
  assert.equal(
    (await result.json()).code,
    "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY",
  );
});
test("a committed mutation followed by HTTP 500 or an invalid response remains uncertain", async () => {
  for (const response of [
    new Response("private failure", { status: 500 }),
    new Response("not json", { headers: { "Content-Type": "text/html" } }),
    Response.json(null),
  ]) {
    let committed = false;
    const result = await proxy(
      request("feedback", mutation),
      env,
      "feedback",
      async () => {
        committed = true;
        return response;
      },
    );
    assert.equal(committed, true);
    assert.equal(
      (await result.json()).code,
      "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY",
    );
  }
});
test("GitHub projection is read-only, excludes secrets and distinguishes workflow SHA", async () => {
  const result = await githubRuns(request("github"), env, async (url) => {
    assert.equal(
      url,
      "https://api.github.com/repos/example/fixture/actions/workflows/daily.yml/runs?per_page=10",
    );
    return Response.json({
      workflow_runs: [
        {
          id: 1,
          head_sha: "fixture-sha",
          created_at: "2026-09-18T00:00:00Z",
          status: "completed",
          conclusion: "success",
          token: "never-return",
        },
      ],
    });
  });
  const data = await result.json();
  assert.equal(data.runs[0].sha, "fixture-sha");
  assert.equal(data.runs[0].token, undefined);
});
