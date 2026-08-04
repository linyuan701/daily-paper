import { describe, expect, it } from "vitest";

import { EnvValidationError, getDeploymentCapabilities, loadEnv } from "./env";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  NVIDIA_NIM_BASE_URL,
  NVIDIA_NIM_MODEL
} from "./llm";

describe("deployment environment contract", () => {
  it("keeps an absent deployment mode backward-compatible with Local Mode", () => {
    const env = loadEnv({ DATABASE_URL: "file:./dev.db" });

    expect(env.DEPLOYMENT_MODE).toBe("local");
    expect(env.CAPABILITIES).toEqual(getDeploymentCapabilities("local"));
    expect(env.DAILY_RUN_STALE_AFTER_MINUTES).toBe(180);
    expect(env.CAPABILITIES).toMatchObject({
      sqlite: true,
      postgresql: false,
      windowsScheduler: true,
      zoteroLocal: true,
      obsidianFilesystem: true,
      desktopNotification: true
    });
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

  it("applies NVIDIA NIM defaults only for the explicit NVIDIA provider", () => {
    const env = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "nvidia",
      LLM_API_KEY: "placeholder-key"
    });

    expect(env.LLM_PROVIDER).toBe("nvidia");
    expect(env.LLM_BASE_URL).toBe(NVIDIA_NIM_BASE_URL);
    expect(env.LLM_API_BASE_URL).toBe(NVIDIA_NIM_BASE_URL);
    expect(env.LLM_MODEL).toBe(NVIDIA_NIM_MODEL);
  });

  it("applies official DeepSeek defaults only for the explicit DeepSeek provider", () => {
    const env = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "deepseek",
      LLM_API_KEY: "placeholder-key"
    });

    expect(env.LLM_PROVIDER).toBe("deepseek");
    expect(env.LLM_BASE_URL).toBe(DEEPSEEK_BASE_URL);
    expect(env.LLM_API_BASE_URL).toBe(DEEPSEEK_BASE_URL);
    expect(env.LLM_MODEL).toBe(DEEPSEEK_MODEL);
  });

  it("normalizes the official DeepSeek base URL and rejects provider overrides", () => {
    const accepted = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "deepseek",
      LLM_BASE_URL: `${DEEPSEEK_BASE_URL}///`,
      LLM_MODEL: DEEPSEEK_MODEL
    });
    expect(accepted.LLM_BASE_URL).toBe(DEEPSEEK_BASE_URL);

    expect(() => loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "deepseek",
      LLM_API_KEY: "do-not-print-deepseek-key",
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_MODEL: NVIDIA_NIM_MODEL
    })).toThrowError(`LLM_PROVIDER=deepseek requires LLM_MODEL=${DEEPSEEK_MODEL}`);
  });

  it("normalizes trailing slashes and gives the canonical base URL precedence", () => {
    const env = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "nvidia",
      LLM_BASE_URL: `${NVIDIA_NIM_BASE_URL}///`,
      LLM_API_BASE_URL: "https://legacy.example.invalid/v1",
      LLM_MODEL: NVIDIA_NIM_MODEL
    });

    expect(env.LLM_BASE_URL).toBe(NVIDIA_NIM_BASE_URL);
    expect(env.LLM_API_BASE_URL).toBe(NVIDIA_NIM_BASE_URL);
  });

  it("rejects NVIDIA shorthand and a non-hosted base without exposing the key", () => {
    const secret = "do-not-print-nvidia-key";

    try {
      loadEnv({
        DATABASE_URL: "file:./dev.db",
        LLM_PROVIDER: "nvidia",
        LLM_API_KEY: secret,
        LLM_BASE_URL: "https://example.invalid/v1",
        LLM_MODEL: "deepseek-v4-flash"
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(String(error)).toContain("NVIDIA NIM hosted LLM_BASE_URL");
      expect(String(error)).toContain(`LLM_MODEL=${NVIDIA_NIM_MODEL}`);
      expect(String(error)).not.toContain(secret);
    }
  });

  it("preserves provider-absent generic behavior and legacy embedding inheritance", () => {
    const env = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_API_KEY: "placeholder-key",
      LLM_BASE_URL: "https://canonical.example.invalid/v1/",
      LLM_API_BASE_URL: "https://legacy.example.invalid/v1/",
      LLM_MODEL: "generic-model",
      EMBEDDING_MODEL: "embedding-model"
    });

    expect(env.LLM_PROVIDER).toBeUndefined();
    expect(env.LLM_BASE_URL).toBe("https://canonical.example.invalid/v1");
    expect(env.LLM_API_BASE_URL).toBe("https://canonical.example.invalid/v1");
    expect(env.LLM_MODEL).toBe("generic-model");
    expect(env.EMBEDDING_API_KEY).toBe("placeholder-key");
    expect(env.EMBEDDING_API_BASE_URL).toBe("https://legacy.example.invalid/v1/");
  });

  it("does not inherit provider-specific LLM credentials or base URLs into embeddings", () => {
    const env = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "nvidia",
      LLM_API_KEY: "placeholder-key",
      LLM_BASE_URL: NVIDIA_NIM_BASE_URL,
      LLM_MODEL: NVIDIA_NIM_MODEL,
      EMBEDDING_MODEL: "embedding-model"
    });

    expect(env.EMBEDDING_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_API_BASE_URL).toBeUndefined();

    const deepseek = loadEnv({
      DATABASE_URL: "file:./dev.db",
      LLM_PROVIDER: "deepseek",
      LLM_API_KEY: "placeholder-deepseek-key",
      LLM_BASE_URL: DEEPSEEK_BASE_URL,
      LLM_API_BASE_URL: "https://legacy-embedding.example.invalid/v1",
      EMBEDDING_MODEL: "embedding-model"
    });
    expect(deepseek.EMBEDDING_API_KEY).toBeUndefined();
    expect(deepseek.EMBEDDING_API_BASE_URL).toBeUndefined();
  });

  it.each(["LLM_BASE_URL", "LLM_API_BASE_URL"] as const)(
    "rejects credential-bearing or parameterized %s values without echoing them",
    (key) => {
      const unsafeUrl = "https://user:private-password@example.invalid/v1?token=private-token#fragment";
      try {
        loadEnv({
          DATABASE_URL: "file:./dev.db",
          LLM_PROVIDER: "openai-compatible",
          [key]: unsafeUrl
        });
        throw new Error("expected validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        expect(String(error)).toContain(key);
        expect(String(error)).not.toContain(unsafeUrl);
        expect(String(error)).not.toContain("private-password");
        expect(String(error)).not.toContain("private-token");
      }
    }
  );
});
