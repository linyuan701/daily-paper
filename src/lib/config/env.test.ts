import { describe, expect, it } from "vitest";

import { EnvValidationError, getDeploymentCapabilities, loadEnv } from "./env";

describe("deployment environment contract", () => {
  it("keeps an absent deployment mode backward-compatible with Local Mode", () => {
    const env = loadEnv({ DATABASE_URL: "file:./dev.db" });

    expect(env.DEPLOYMENT_MODE).toBe("local");
    expect(env.CAPABILITIES).toEqual(getDeploymentCapabilities("local"));
    expect(env.DAILY_RUN_STALE_AFTER_MINUTES).toBe(180);
    expect(env.DAILY_RECOMMENDATION_LIMIT).toBe(20);
    expect(env.CAPABILITIES).toMatchObject({
      sqlite: true,
      postgresql: false,
      windowsScheduler: true,
      zoteroLocal: true,
      obsidianFilesystem: true,
      desktopNotification: true
    });
  });

  it.each(["1", "20", "30"])("accepts DAILY_RECOMMENDATION_LIMIT=%s in Local and Cloud Mode", (limit) => {
    expect(loadEnv({ DATABASE_URL: "file:./dev.db", DAILY_RECOMMENDATION_LIMIT: limit }).DAILY_RECOMMENDATION_LIMIT).toBe(Number(limit));
    expect(loadEnv({
      DEPLOYMENT_MODE: "cloud",
      DATABASE_URL: "postgresql://user:secret@example.invalid/daily_paper",
      ZOTERO_TRANSPORT: "web",
      ZOTERO_ID: "1234",
      ZOTERO_KEY: "secret",
      DAILY_RECOMMENDATION_LIMIT: limit
    }).DAILY_RECOMMENDATION_LIMIT).toBe(Number(limit));
  });

  it.each(["0", "31", "1.5", "paper"])("rejects invalid DAILY_RECOMMENDATION_LIMIT=%s", (limit) => {
    expect(() => loadEnv({ DATABASE_URL: "file:./dev.db", DAILY_RECOMMENDATION_LIMIT: limit }))
      .toThrowError("DAILY_RECOMMENDATION_LIMIT must be an integer between 1 and 30");
  });

  it("accepts the explicit Cloud Mode contract", () => {
    const env = loadEnv({
      DEPLOYMENT_MODE: "cloud",
      DATABASE_URL: "postgresql://user:secret@example.invalid/daily_paper?sslmode=require",
      ZOTERO_TRANSPORT: "web",
      ZOTERO_ID: "1234",
      ZOTERO_KEY: "secret",
      OBSIDIAN_ENABLED: "false",
      SCHEDULER_DESKTOP_NOTIFICATION_ENABLED: "false"
    });

    expect(env.DEPLOYMENT_MODE).toBe("cloud");
    expect(env.CAPABILITIES).toMatchObject({
      sqlite: false,
      postgresql: true,
      windowsScheduler: false,
      zoteroLocal: false,
      obsidianFilesystem: false,
      desktopNotification: false
    });
  });

  it.each([
    [
      { DEPLOYMENT_MODE: "other", DATABASE_URL: "file:./dev.db" },
      "DEPLOYMENT_MODE must be local or cloud"
    ],
    [
      { DEPLOYMENT_MODE: "local", DATABASE_URL: "postgresql://example.invalid/db" },
      "Local Mode requires DATABASE_URL"
    ],
    [
      {
        DEPLOYMENT_MODE: "cloud",
        DATABASE_URL: "file:./dev.db",
        ZOTERO_TRANSPORT: "web",
        ZOTERO_ID: "1",
        ZOTERO_KEY: "key"
      },
      "Cloud Mode requires DATABASE_URL"
    ],
    [
      {
        DEPLOYMENT_MODE: "cloud",
        DATABASE_URL: "postgresql://example.invalid/db",
        ZOTERO_TRANSPORT: "auto"
      },
      "Cloud Mode requires ZOTERO_TRANSPORT=web"
    ],
    [
      {
        DEPLOYMENT_MODE: "cloud",
        DATABASE_URL: "postgresql://example.invalid/db",
        ZOTERO_TRANSPORT: "web"
      },
      "requires ZOTERO_KEY and ZOTERO_ID"
    ],
    [
      {
        DEPLOYMENT_MODE: "cloud",
        DATABASE_URL: "postgresql://example.invalid/db",
        ZOTERO_TRANSPORT: "web",
        ZOTERO_ID: "1",
        ZOTERO_KEY: "key",
        OBSIDIAN_ENABLED: "true"
      },
      "does not support direct Obsidian"
    ],
    [
      {
        DEPLOYMENT_MODE: "cloud",
        DATABASE_URL: "postgresql://example.invalid/db",
        ZOTERO_TRANSPORT: "web",
        ZOTERO_ID: "1",
        ZOTERO_KEY: "key",
        SCHEDULER_DESKTOP_NOTIFICATION_ENABLED: "true"
      },
      "does not support Windows desktop notifications"
    ]
  ])("rejects an invalid mode combination", (rawEnv, expectedMessage) => {
    expect(() => loadEnv(rawEnv)).toThrowError(expectedMessage);
  });

  it("does not include configured secret values in validation messages", () => {
    const secret = "do-not-print-this";

    try {
      loadEnv({
        DEPLOYMENT_MODE: "cloud",
        DATABASE_URL: "file:./dev.db",
        ZOTERO_TRANSPORT: "web",
        ZOTERO_ID: "1",
        ZOTERO_KEY: secret
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
