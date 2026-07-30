import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";

import { buildDailyNotification, sendDailyNotification } from "./daily-notifier.mjs";

const notification = buildDailyNotification({
  pipelinePayload: {
    status: "partial",
    result: {
      runId: "run-1",
      sources: [
        { source: "biorxiv", status: "success" },
        { source: "arxiv", status: "failed" }
      ]
    }
  },
  feed: {
    recommendations: [
      {
        title: "Single-cell atlas",
        sources: ["biorxiv"],
        identifiers: { doi: "10.1101/2026.01.01.123456" }
      },
      { title: "Regulatory genomics", sources: ["journal"] }
    ]
  },
  dashboardUrl: "http://localhost:3000"
});

test("sends a WeCom notification when its webhook succeeds", async () => {
  let request;
  const result = await sendDailyNotification({
    notification,
    env: { WECOM_BOT_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ errcode: 0 }) };
    }
  });

  assert.equal(result.status, "sent");
  assert.equal(result.channel, "wecom");
  assert.match(JSON.parse(request.options.body).markdown.content, /推荐数量.*2/);
});

test("falls back to SMTP email when WeCom fails", async () => {
  let sentMail;
  const result = await sendDailyNotification({
    notification,
    env: {
      WECOM_BOT_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test",
      NOTIFICATION_SMTP_HOST: "smtp.example.test",
      NOTIFICATION_SMTP_PORT: "465",
      NOTIFICATION_SMTP_SECURE: "true",
      NOTIFICATION_SMTP_USER: "user",
      NOTIFICATION_SMTP_PASS: "secret",
      NOTIFICATION_EMAIL_FROM: "from@example.test",
      NOTIFICATION_EMAIL_TO: "to@example.test"
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ errcode: 40001 }) }),
    createTransport: () => ({
      sendMail: async (message) => {
        sentMail = message;
      }
    })
  });

  assert.equal(result.status, "sent");
  assert.equal(result.channel, "email");
  assert.equal(result.fallbackFrom, "wecom");
  assert.equal(sentMail.to, "to@example.test");
  assert.match(sentMail.text, /arxiv/);
  assert.match(sentMail.html, /https:\/\/doi\.org\/10\.1101\/2026\.01\.01\.123456/);
  assert.doesNotMatch(sentMail.html, /localhost/);
});

test("skips notification when no channel is configured", async () => {
  const result = await sendDailyNotification({ notification, env: {} });
  assert.equal(result.status, "skipped");
  assert.equal(result.channel, "none");
});

test("reports failure after both optional channels fail", async () => {
  const result = await sendDailyNotification({
    notification,
    env: {
      WECOM_BOT_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test",
      NOTIFICATION_SMTP_HOST: "smtp.example.test",
      NOTIFICATION_EMAIL_FROM: "from@example.test",
      NOTIFICATION_EMAIL_TO: "to@example.test"
    },
    fetchImpl: async () => ({ ok: false, status: 503 }),
    createTransport: () => ({ sendMail: async () => { throw new Error("SMTP unavailable"); } })
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.attempts.map((attempt) => attempt.channel), ["wecom", "email"]);
});

test("renders complete-with-warnings distinctly from partial and failed", () => {
  const warning = buildDailyNotification({
    pipelinePayload: { status: "complete_with_warnings", result: { sources: [] } },
    feed: { recommendations: [] }
  });
  const failed = buildDailyNotification({
    pipelinePayload: { status: "failed", result: { sources: [] } },
    feed: { recommendations: [] }
  });
  assert.match(warning.title, /有警告/);
  assert.match(failed.title, /失败/);
  assert.notEqual(warning.title, failed.title);
});

test("Nodemailer 9 renders the production message shape without network access", async () => {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix"
  });
  let rendered;
  const result = await sendDailyNotification({
    notification,
    env: {
      NOTIFICATION_SMTP_HOST: "smtp.example.test",
      NOTIFICATION_EMAIL_FROM: "daily-paper@example.test",
      NOTIFICATION_EMAIL_TO: "operator@example.test"
    },
    createTransport: () => ({
      sendMail: async (message) => {
        const output = await transport.sendMail(message);
        rendered = output.message.toString("utf8");
      }
    })
  });

  assert.equal(result.status, "sent");
  assert.match(rendered, /From: daily-paper@example\.test/);
  assert.match(rendered, /To: operator@example\.test/);
  assert.match(rendered, /Content-Type: multipart\/alternative/);
  assert.match(rendered, /arxiv/);
});

test("SMTP includes every selected recommendation for configured limits", async () => {
  for (const count of [1, 20, 30]) {
    const limitedNotification = buildDailyNotification({
      pipelinePayload: { status: "complete", result: { runId: `run-${count}`, sources: [] } },
      feed: {
        recommendations: Array.from({ length: count }, (_, index) => ({
          title: `Selected paper ${index + 1}`,
          sources: ["pubmed"]
        }))
      }
    });
    let sentMail;
    await sendDailyNotification({
      notification: limitedNotification,
      env: {
        NOTIFICATION_SMTP_HOST: "smtp.example.test",
        NOTIFICATION_EMAIL_FROM: "from@example.test",
        NOTIFICATION_EMAIL_TO: "to@example.test"
      },
      createTransport: () => ({ sendMail: async (message) => { sentMail = message; } })
    });

    assert.equal(limitedNotification.papers.length, count);
    assert.match(sentMail.text, new RegExp(`Selected paper ${count}`));
  }
});
