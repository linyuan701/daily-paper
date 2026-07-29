import { expect, test, type Page } from "@playwright/test";

type JsonRecord = Record<string, unknown>;

type DashboardMocks = {
  runs?: JsonRecord[];
  latestFeed?: JsonRecord | null;
  feedsByRunId?: Record<string, JsonRecord | null>;
  logsByRunId?: Record<string, JsonRecord[]>;
  operationsStatus?: number;
  recommendationStatus?: number;
  feedbackLogs?: (runId: string) => Promise<JsonRecord[]>;
  feedbackAction?: (body: JsonRecord) => Promise<{ status?: number; body?: JsonRecord }>;
};

const TODAY_RUN = run({
  runId: "run-today",
  runDate: "2026-07-30",
  status: "complete",
  finishedAt: "2026-07-30T00:20:00.000Z"
});

test("complete_with_warnings is presented as a warning, not a failure", async ({ page }) => {
  await installDashboardMocks(page, {
    runs: [run({
      runId: "run-today",
      runDate: "2026-07-30",
      status: "complete_with_warnings",
      errorSummary: "journal feed timed out",
      sourceDegradation: {
        degraded: true,
        sources: [{ source: "pubmed", status: "failed", error: "timeout" }]
      }
    })],
    latestFeed: feed("run-today", [paper()])
  });

  await page.goto("/");

  const status = page.locator(".dashboard-status");
  await expect(status).toContainText("完成但有警告");
  await expect(status).toContainText("来源降级：pubmed");
  await expect(status).not.toContainText("失败");
  await expect(status).toHaveClass(/status-warning/);
  await expect(status).not.toHaveClass(/status-error/);
});

test("switching to a historical run loads that feed and clearly marks it as historical", async ({ page }) => {
  const oldRun = run({
    runId: "run-old",
    runDate: "2026-07-28",
    status: "complete",
    finishedAt: "2026-07-28T00:20:00.000Z"
  });
  await installDashboardMocks(page, {
    runs: [TODAY_RUN, oldRun],
    latestFeed: feed("run-today", [paper({ title: "Today paper" })]),
    feedsByRunId: {
      "run-old": feed("run-old", [paper({ candidateId: "candidate-old", title: "Historical paper" })])
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today paper" })).toBeVisible();

  await page.getByLabel("查看日期").selectOption("run-old");

  await expect(page).toHaveURL(/(?:\?|&)runId=run-old(?:&|$)/);
  await expect(page.getByText("正在查看历史结果", { exact: true })).toBeVisible();
  await expect(page.getByText("这是历史运行结果，不是今日最新推荐。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "业务日期 2026-07-28" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Historical paper" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today paper" })).toHaveCount(0);
});

test("Today withholds an unaligned feed when Operations is unavailable", async ({ page }) => {
  await installDashboardMocks(page, {
    operationsStatus: 503,
    latestFeed: feed("run-old", [paper({ title: "Old paper must stay hidden" })])
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Old paper must stay hidden" })).toHaveCount(0);
  await expect(page.getByText(/旧 feed 已隐藏/)).toBeVisible();
  await expect(page.getByText(/运行状态暂不可用/)).toBeVisible();
});

test("cards wait for feedback hydration before becoming interactive", async ({ page }) => {
  let releaseLogs!: (logs: JsonRecord[]) => void;
  const logs = new Promise<JsonRecord[]>((resolve) => { releaseLogs = resolve; });
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper()]),
    feedbackLogs: async () => logs
  });

  await page.goto("/");
  await expect(page.getByText("正在读取推荐并核对业务运行…", { exact: true })).toBeVisible();
  await expect(page.locator(".feedback-action")).toHaveCount(0);

  releaseLogs([{ candidateId: "candidate-a", actionType: "dismiss" }]);
  await expect(page.getByRole("heading", { name: "A traceable paper" })).toHaveCount(0);
});

test("status and Today denominator count selected recommendations only", async ({ page }) => {
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [
      paper(),
      paper({ candidateId: "candidate-unselected", title: "Unselected candidate", selected: false })
    ])
  });

  await page.goto("/");

  await expect(page.locator(".dashboard-status")).toContainText("1 篇");
  await expect(page.getByText("显示 1 / 1 篇推荐", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All" }).click();
  await expect(page.getByText("显示 2 / 2 篇推荐", { exact: true })).toBeVisible();
});

test("URL query filters are restored after refresh", async ({ page }) => {
  const savedPaper = paper({
    title: "Genome atlas for immune cells",
    sources: ["pubmed"],
    journal: { name: "Nature Methods", quartile: "Q1", impactScore: 42 },
    labels: {
      contentRecall: { label: "genomics", provider: "fixture", provenance: "generated" },
      researchType: {
        category: "resource",
        primaryKeyword: "atlas",
        secondaryKeyword: "immune",
        rawText: "resource | atlas, immune",
        provider: "fixture",
        provenance: "generated"
      }
    }
  });
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [savedPaper, paper({ candidateId: "candidate-b", title: "Other study" })]),
    logsByRunId: {
      "run-today": [{ candidateId: "candidate-a", actionType: "save" }]
    }
  });

  const query = "?view=saved&q=Genome&source=pubmed&journal=Nature%20Methods&tag=genomics&feedback=save&sort=score";
  await page.goto(`/${query}`);
  await assertRestoredFilters(page);

  await page.reload();
  await assertRestoredFilters(page);
});

test("dismiss removes immediately and sends one POST after five seconds", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-07-30T00:00:00.000Z") });
  const posts: JsonRecord[] = [];
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper()]),
    feedbackAction: async (body) => {
      posts.push(body);
      return { body: { status: "ok", log: { id: "feedback-1" } } };
    }
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "A traceable paper" });
  await card.getByRole("button", { name: "不感兴趣" }).click();

  await expect(card).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  expect(posts).toHaveLength(0);

  await page.clock.fastForward(4_999);
  expect(posts).toHaveLength(0);
  await page.clock.fastForward(1);

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ runId: "run-today", candidateId: "candidate-a", action: "dismiss" });
});

test("pagehide flushes a pending dismiss exactly once", async ({ page }) => {
  const posts: JsonRecord[] = [];
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper()]),
    feedbackAction: async (body) => {
      posts.push(body);
      return { body: { status: "ok", log: { id: "feedback-1" } } };
    }
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "A traceable paper" });
  await card.getByRole("button", { name: "不感兴趣" }).click();
  await expect(card).toHaveCount(0);
  expect(posts).toHaveLength(0);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ runId: "run-today", candidateId: "candidate-a", action: "dismiss" });
});

test("BFCache restore rehydrates feedback and rebuilds interactions", async ({ page }) => {
  const posts: JsonRecord[] = [];
  const persistedActions = new Map<string, string>();
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [
      paper(),
      paper({ candidateId: "candidate-b", title: "A second paper", rank: 2 })
    ]),
    feedbackLogs: async () => [...persistedActions].map(([candidateId, actionType]) => ({ candidateId, actionType })),
    feedbackAction: async (body) => {
      posts.push(body);
      persistedActions.set(String(body.candidateId), String(body.action));
      return { body: { status: "ok", log: { id: `feedback-${posts.length}` } } };
    }
  });

  await page.goto("/");
  await page.getByRole("article", { name: "A traceable paper" }).getByRole("button", { name: "不感兴趣" }).click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => posts.length).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("article", { name: "A traceable paper" })).toHaveCount(0);

  const secondCard = page.getByRole("article", { name: "A second paper" });
  await secondCard.getByRole("button", { name: "收藏" }).click();
  await expect(secondCard.getByText("已保存：收藏", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
});

test("a failed dismiss POST rolls the optimistic removal back", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-07-30T00:00:00.000Z") });
  let postCount = 0;
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper()]),
    feedbackAction: async () => {
      postCount += 1;
      return { status: 500, body: { status: "error", message: "fixture failure" } };
    }
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "A traceable paper" });
  await card.getByRole("button", { name: "不感兴趣" }).click();
  await expect(card).toHaveCount(0);

  await page.clock.fastForward(5_000);

  const restoredCard = page.getByRole("article", { name: "A traceable paper" });
  await expect(restoredCard).toBeVisible();
  await expect(restoredCard.getByRole("alert")).toContainText("操作未保存，已恢复先前状态");
  expect(postCount).toBe(1);
});

test("Undo restores a dismissed card without writing feedback", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-07-30T00:00:00.000Z") });
  let postCount = 0;
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper()]),
    feedbackAction: async () => {
      postCount += 1;
      return { body: { status: "ok" } };
    }
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "A traceable paper" });
  await card.getByRole("button", { name: "不感兴趣" }).click();
  await expect(card).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("article", { name: "A traceable paper" })).toBeVisible();
  await page.clock.fastForward(6_000);
  expect(postCount).toBe(0);
});

test("every concurrently dismissed paper has an Undo control", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-07-30T00:00:00.000Z") });
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [
      paper({ title: "First paper" }),
      paper({ candidateId: "candidate-b", title: "Second paper", rank: 2 })
    ])
  });

  await page.goto("/");
  await page.getByRole("article", { name: /First paper/ }).getByRole("button", { name: "不感兴趣" }).click();
  await page.getByRole("article", { name: /Second paper/ }).getByRole("button", { name: "不感兴趣" }).click();
  await expect(page.locator(".undo-toast-list").getByRole("button", { name: "Undo" })).toHaveCount(2);

  await page.locator(".undo-toast-list li").filter({ hasText: "Second paper" }).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("heading", { name: "Second paper" })).toBeVisible();
});

test("duplicate feedback clicks are ignored while the first request is pending", async ({ page }) => {
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const posts: JsonRecord[] = [];
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper()]),
    feedbackAction: async (body) => {
      posts.push(body);
      await requestGate;
      return { body: { status: "ok", log: { id: "feedback-1" } } };
    }
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "A traceable paper" });
  const save = card.locator("button.feedback-save");
  await save.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
    button.click();
  });

  await expect.poll(() => posts.length).toBe(1);
  await expect(save).toBeDisabled();
  releaseRequest();
  await expect(card.getByText("已保存：收藏", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(1);
});

test("empty feed shows an explicit empty state", async ({ page }) => {
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: null
  });

  await page.goto("/");

  await expect(page.getByText("暂无结果", { exact: true })).toBeVisible();
  await expect(page.getByText("今天还没有可用推荐。请稍后刷新查看运行结果。", { exact: true })).toBeVisible();
  await expect(page.locator(".recommendation-card")).toHaveCount(0);
});

test("recommendation API errors show an explicit error state", async ({ page }) => {
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    recommendationStatus: 503
  });

  await page.goto("/");

  const error = page.locator(".dashboard-message[role='alert']");
  await expect(error).toContainText("出现问题");
  await expect(error).toContainText("推荐加载失败：请求失败 (503)");
  await expect(page.locator(".recommendation-card")).toHaveCount(0);
});

test("shared styles keep supporting pages within desktop and mobile viewports", async ({ page }) => {
  test.setTimeout(90_000);
  await page.route("**/api/operations/runs?limit=20", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", runs: [] }) });
  });
  await page.route("**/api/zotero/collections/priorities", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", tree: [] }) });
  });
  await page.route("**/api/journals/pool/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", reports: [] }) });
  });
  await page.route("**/api/journals/pool", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", feeds: [] }) });
  });

  const pages = [
    { path: "/operations", heading: "Operations" },
    { path: "/collections", heading: "Collection Priorities" },
    { path: "/journals", heading: "Journal Pool" }
  ];

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const target of pages) {
      await page.goto(target.path);
      await expect(page.getByRole("heading", { level: 1, name: target.heading })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test("mobile 390x844 has no horizontal overflow and feedback controls remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDashboardMocks(page, {
    runs: [TODAY_RUN],
    latestFeed: feed("run-today", [paper({
      title: "A long but readable mobile recommendation title about single-cell immune atlases"
    })])
  });

  await page.goto("/");
  const card = page.getByRole("article", {
    name: "A long but readable mobile recommendation title about single-cell immune atlases"
  });
  const promote = card.getByRole("button", { name: "优先阅读" });
  await expect(card).toBeVisible();
  await expect(promote).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  const buttonBox = await promote.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThanOrEqual(0);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(390);

  await promote.click();
  await expect(card.getByText("已保存：优先阅读", { exact: true })).toBeVisible();
});

test("tablet layout does not overflow and keyboard focus is visibly indicated", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await installDashboardMocks(page, { runs: [TODAY_RUN], latestFeed: feed("run-today", [paper()]) });
  await page.goto("/");

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return null;
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focus).not.toBeNull();
  expect(focus?.outlineStyle).not.toBe("none");
  expect(focus?.outlineWidth).not.toBe("0px");
});

async function assertRestoredFilters(page: Page) {
  expect(new URL(page.url()).searchParams.get("view")).toBe("saved");
  await expect(page.getByRole("heading", { name: "Genome atlas for immune cells" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Saved" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#dashboard-search")).toHaveValue("Genome");
  await expect(page.locator("#dashboard-source")).toHaveValue("pubmed");
  await expect(page.locator("#dashboard-journal")).toHaveValue("Nature Methods");
  await expect(page.locator("#dashboard-tag")).toHaveValue("genomics");
  await expect(page.locator("#dashboard-feedback")).toHaveValue("save");
  await expect(page.locator("#dashboard-sort")).toHaveValue("score");
  await expect(page.getByText("显示 1 / 1 篇推荐", { exact: true })).toBeVisible();
}

async function installDashboardMocks(page: Page, options: DashboardMocks) {
  await page.route("**/api/operations/runs?**", async (route) => {
    const responseStatus = options.operationsStatus ?? 200;
    await route.fulfill({
      status: responseStatus,
      contentType: "application/json",
      body: JSON.stringify(responseStatus === 200
        ? { status: "ok", runs: options.runs ?? [TODAY_RUN] }
        : { status: "error", message: "fixture operations error" })
    });
  });

  await page.route("**/api/recommendations/daily?**", async (route) => {
    const responseStatus = options.recommendationStatus ?? 200;
    if (responseStatus !== 200) {
      await route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        body: JSON.stringify({ status: "error", message: "fixture recommendation error" })
      });
      return;
    }

    const runId = new URL(route.request().url()).searchParams.get("runId");
    const hasRunFixture = Boolean(
      runId && options.feedsByRunId && Object.prototype.hasOwnProperty.call(options.feedsByRunId, runId)
    );
    const selectedFeed = hasRunFixture
      ? options.feedsByRunId![runId!]
      : options.latestFeed ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", feed: selectedFeed })
    });
  });

  await page.route("**/api/feedback/logs?**", async (route) => {
    const runId = new URL(route.request().url()).searchParams.get("runId") ?? "";
    const logs = options.feedbackLogs
      ? await options.feedbackLogs(runId)
      : options.logsByRunId?.[runId] ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", logs })
    });
  });

  await page.context().route("**/api/feedback/actions", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as JsonRecord;
    const response = options.feedbackAction
      ? await options.feedbackAction(body)
      : { body: { status: "ok", log: { id: "feedback-default" } } };
    await route.fulfill({
      status: response.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(response.body ?? { status: "ok" })
    });
  });
}

function run(overrides: JsonRecord = {}): JsonRecord {
  return {
    runId: "run-today",
    runDate: "2026-07-30",
    attempt: 1,
    status: "complete",
    stages: [],
    sourceDegradation: { degraded: false, sources: [] },
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T00:20:00.000Z",
    retryable: false,
    ...overrides
  };
}

function feed(runId: string, recommendations: JsonRecord[]): JsonRecord {
  return {
    rerankRunId: `rerank-${runId}`,
    runId,
    generatedAt: runId === "run-old" ? "2026-07-28T00:20:00.000Z" : "2026-07-30T00:20:00.000Z",
    recommendations
  };
}

function paper(overrides: JsonRecord = {}): JsonRecord {
  return {
    candidateId: "candidate-a",
    rank: 1,
    selected: true,
    finalScore: 0.93,
    title: "A traceable paper",
    abstract: "A fixture abstract about genomics and immune cells.",
    publishedAt: "2026-07-29T00:00:00.000Z",
    url: "https://example.test/paper/candidate-a",
    sources: ["pubmed"],
    sourceIdentifiers: [{ source: "pubmed", externalId: "12345678" }],
    identifiers: { doi: "10.1000/fixture", pmid: "12345678" },
    summary: {
      researchQuestion: "How can this process be measured?",
      method: "A stable route-mocked fixture.",
      mainFinding: "The fixture renders predictable dashboard content.",
      relevanceToUser: "It supports reliable daily triage tests.",
      provider: "fixture",
      provenance: "generated"
    },
    labels: {
      contentRecall: { label: "genomics", provider: "fixture", provenance: "generated" },
      researchType: {
        category: "method",
        primaryKeyword: "testing",
        secondaryKeyword: "dashboard",
        rawText: "method | testing, dashboard",
        provider: "fixture",
        provenance: "generated"
      }
    },
    reasons: ["Matches the active genomics profile."],
    journal: { name: "Fixture Journal", quartile: "Q1", impactScore: 8.5 },
    ...overrides
  };
}
