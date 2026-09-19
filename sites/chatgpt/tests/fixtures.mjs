// Synthetic disposable data only. Not imported by the hosted build.
export function fixtureBackend() {
  const logs = [];
  const recommendations = Array.from({ length: 20 }, (_, i) => ({
    candidateId: `fixture-paper-${i + 1}`,
    rank: i + 1,
    selected: true,
    finalScore: 0.9 - i * 0.02,
    title: `[测试数据] ${i === 0 ? "Cross-species regulatory conservation and gene expression" : "Research paper " + (i + 1)}`,
    abstractNote:
      "Synthetic abstract for isolated UI verification. No production data or database is used.",
    sources: [["pubmed", "biorxiv", "arxiv", "journal"][i % 4]],
    publishedAt: "2026-09-17T00:00:00Z",
    labels: {
      contentRecall: {
        label: "#regulatory-genomics",
        provider: "fixture",
        provenance: "generated",
      },
      researchType: {
        category: "biology",
        primaryKeyword: "gene regulation",
        secondaryKeyword: "comparative genomics",
      },
    },
    summary: {
      researchQuestion: "跨物种调控元件如何与表达保守性关联？（测试）",
      method: "比较序列与表达矩阵。（测试）",
      mainFinding: "这是用于验证页面布局和反馈流程的测试内容。",
      relevanceToUser: "来自隔离 fixture，不能用于科研结论。",
      provider: "fixture",
      provenance: "generated",
    },
    reasons: ["fixture_profile_overlap"],
    identifiers: {},
  }));
  const feed = {
    runId: "fixture-run",
    rerankRunId: "fixture-rerank",
    generatedAt: "2026-09-19T04:37:00Z",
    recommendations,
  };
  const operations = {
    runId: "fixture-run",
    runDate: "2026-09-18",
    attempt: 1,
    status: "complete_with_warnings",
    startedAt: "2026-09-19T04:32:00Z",
    finishedAt: "2026-09-19T04:37:00Z",
    retryable: false,
    stages: [
      "ingestion",
      "enrichment",
      "normalization",
      "representation",
      "recall",
      "rerank",
      "summary",
    ].map((stage) => ({
      stage,
      status: stage === "ingestion" ? "partial" : "success",
    })),
    sourceDegradation: {
      degraded: true,
      sources: ["arxiv", "pubmed", "biorxiv", "journal"].map((source) => ({
        source,
        status: source === "arxiv" ? "failed" : "success",
        ...(source === "arxiv" ? { error: "Synthetic timeout" } : {}),
      })),
    },
  };
  const snapshot = {
    id: "fixture-snapshot",
    status: "active",
    builtAt: "2026-09-19T04:35:00Z",
    itemsCount: 42,
    segments: { recentCore: 20, stableLongTerm: 15, background: 7 },
    positiveLabels: ["#regulatory-genomics", "#cross-species"],
    researchTypePreferences: [
      { category: "biology", weight: 0.7, itemCount: 25 },
      { category: "method", weight: 0.3, itemCount: 17 },
    ],
    feedbackIntegration: {
      logsConsumed: 2,
      actionCounts: { dismiss: 2 },
      negativeFeedback: {
        modelVersion: "fixture",
        signalCount: 1,
        maxPenalty: 0.2,
        signals: [
          {
            sourceFeedbackLogId: "fixture-old-log",
            representationText: "Synthetic unrelated topic",
            contentRecallLabel: "#fixture-negative",
            effectiveAt: "2026-09-18T10:00:00Z",
          },
        ],
      },
    },
  };
  return async (url, init = {}) => {
    const target = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (target.hostname === "api.github.com")
      return Response.json({
        workflow_runs: [
          {
            id: 123,
            head_sha: "a".repeat(40),
            created_at: "2026-09-19T04:32:00Z",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    if (target.origin !== "https://fixture.example.test")
      throw new Error("Fixture forbids network access");
    const path = target.pathname;
    if (path === "/api/feedback/actions") {
      const log = {
        id: `fixture-log-${logs.length + 1}`,
        runId: body.runId,
        candidateId: body.candidateId,
        actionType: body.action,
        createdAt: new Date().toISOString(),
      };
      logs.unshift(log);
      return Response.json({ status: "ok", log });
    }
    if (path === "/api/candidates/content") {
      const paper = recommendations.find(
        (p) => p.candidateId === body.candidateId,
      );
      if (body.summary)
        paper.summary = {
          ...paper.summary,
          ...body.summary,
          provenance: "user_corrected",
        };
      if (body.labels?.contentRecallLabel !== undefined)
        paper.labels.contentRecall = {
          label: body.labels.contentRecallLabel,
          provenance: "user_corrected",
        };
      if (body.labels?.researchType)
        paper.labels.researchType = {
          ...body.labels.researchType,
          provenance: "user_corrected",
        };
      logs.unshift({
        id: `fixture-log-${logs.length + 1}`,
        runId: feed.runId,
        candidateId: paper.candidateId,
        actionType: body.summary ? "summary_edit" : "label_edit",
        createdAt: new Date().toISOString(),
      });
      return Response.json({ status: "ok", output: paper });
    }
    const routes = {
      "/api/recommendations/daily": { feed },
      "/api/feedback/logs": { logs },
      "/api/profile/snapshot": { snapshot },
      "/api/profile/refresh": {
        activeSnapshot: snapshot,
        latestJob: {
          status: "success",
          trigger: "scheduled",
          startedAt: snapshot.builtAt,
          finishedAt: snapshot.builtAt,
          snapshotId: snapshot.id,
        },
      },
      "/api/operations/runs": { runs: [operations] },
      "/api/site/capabilities": {
        contractVersion: 1,
        worker: { sha: "b".repeat(40), builtAt: "2026-09-19T00:00:00Z" },
        feedback: ["save", "dismiss", "promote", "label_edit", "summary_edit"],
      },
      "/api/health/ready": { status: "ready" },
      "/api/ranking/recall": {
        result: {
          run: { id: "fixture-recall", profileSnapshotId: snapshot.id },
          results: recommendations.map((p) => ({
            candidateId: p.candidateId,
            scores: {
              recallScore: 0.8,
              semanticScore: 0.3,
              reasons: ["fixture"],
            },
          })),
        },
      },
      "/api/ranking/rerank": {
        result: {
          run: {
            id: feed.rerankRunId,
            recallRunId: "fixture-recall",
            profileSnapshotId: snapshot.id,
          },
          results: recommendations.map((p) => ({
            candidateId: p.candidateId,
            scores: {
              finalScore: p.finalScore,
              recallScore: 0.8,
              featureWeights: { recall: 0.4 },
              reasons: ["fixture"],
            },
          })),
        },
      },
    };
    return routes[path]
      ? Response.json({ status: "ok", ...routes[path] })
      : Response.json({ code: "NOT_FOUND" }, { status: 404 });
  };
}
