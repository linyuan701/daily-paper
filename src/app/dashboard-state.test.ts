import { describe, expect, it } from "vitest";

import {
  clearDashboardFilters,
  createDashboardStatusViewModel,
  dashboardFeedQuery,
  filterAndSortRecommendations,
  getDashboardFilterOptions,
  parseDashboardQuery,
  selectDashboardRun,
  serializeDashboardQuery,
  type DashboardOperationsRun,
  type DashboardQueryState,
  type DashboardRecommendation
} from "./dashboard-state";

const DEFAULT_STATE: DashboardQueryState = {
  view: "today",
  q: "",
  feedback: "all",
  sort: "rank"
};

const RECOMMENDATIONS: DashboardRecommendation[] = [
  {
    candidateId: "paper-1",
    rank: 2,
    finalScore: 0.8,
    title: "Spatial atlas of immune cells",
    abstract: "Single-cell analysis of tissue immunity",
    publishedAt: "2026-07-28T00:00:00.000Z",
    sources: ["pubmed", "journal"],
    journal: { name: "Nature Methods" },
    labels: {
      contentRecall: { label: "single-cell" },
      researchType: { category: "resource", primaryKeyword: "atlas" }
    },
    reasons: ["Matches immune atlas interest"],
    summary: { mainFinding: "建立空间免疫图谱" }
  },
  {
    candidateId: "paper-2",
    rank: 1,
    finalScore: 0.95,
    title: "Protein language model",
    publishedAt: "2026-07-29T00:00:00.000Z",
    sources: ["arxiv"],
    labels: {
      contentRecall: { label: "protein-design" },
      researchType: { category: "method", primaryKeyword: "transformer" }
    },
    reasons: ["Strong method match"]
  },
  {
    candidateId: "paper-3",
    rank: 3,
    title: "No date or score",
    sources: ["biorxiv"]
  }
];

describe("dashboard query state", () => {
  it("restores every frozen query parameter and trims values", () => {
    expect(parseDashboardQuery(
      "?runId=run-2&view=saved&q=%20immune%20&source=pubmed&journal=Nature+Methods" +
      "&tag=single-cell&feedback=save&sort=newest"
    )).toEqual({
      runId: "run-2",
      view: "saved",
      q: "immune",
      source: "pubmed",
      journal: "Nature Methods",
      tag: "single-cell",
      feedback: "save",
      sort: "newest"
    });
  });

  it("falls back safely for invalid enums and omits default values when serializing", () => {
    expect(parseDashboardQuery("?view=invalid&feedback=oops&sort=random")).toEqual(DEFAULT_STATE);
    expect(serializeDashboardQuery(DEFAULT_STATE).toString()).toBe("");
  });

  it("round trips non-default state without adding unrelated parameters", () => {
    const state: DashboardQueryState = {
      runId: "run-7",
      view: "dismissed",
      q: "CRISPR",
      source: "biorxiv",
      journal: "Cell",
      tag: "screen",
      feedback: "dismiss",
      sort: "score"
    };
    expect(parseDashboardQuery(serializeDashboardQuery(state))).toEqual(state);
  });

  it("keeps filters when selecting history and removes runId when returning to today", () => {
    const filtered = { ...DEFAULT_STATE, q: "immune", source: "pubmed" };
    const history = selectDashboardRun(filtered, "run-history");
    expect(history).toEqual({ ...filtered, runId: "run-history" });
    expect(selectDashboardRun(history, undefined)).toEqual(filtered);
    expect(dashboardFeedQuery(history).toString()).toBe("selectedOnly=false&runId=run-history");
  });

  it("clears filters but retains the selected historical run", () => {
    expect(clearDashboardFilters({
      ...DEFAULT_STATE,
      runId: "run-history",
      view: "promoted",
      q: "x",
      tag: "method"
    })).toEqual({ ...DEFAULT_STATE, runId: "run-history" });
  });
});

describe("dashboard filtering and sorting", () => {
  const feedback = {
    "paper-1": "save",
    "paper-2": "promote",
    "paper-3": "dismiss"
  } as const;

  it("keeps dismissed papers out of Today while exposing each feedback view and All", () => {
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, DEFAULT_STATE)))
      .toEqual(["paper-2", "paper-1"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, {
      ...DEFAULT_STATE, view: "saved"
    }))).toEqual(["paper-1"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, {
      ...DEFAULT_STATE, view: "dismissed"
    }))).toEqual(["paper-3"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, {
      ...DEFAULT_STATE, view: "promoted"
    }))).toEqual(["paper-2"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, {
      ...DEFAULT_STATE, view: "all"
    }))).toEqual(["paper-2", "paper-1", "paper-3"]);
  });

  it("applies keyword, source, journal, tag, and feedback filters in the browser", () => {
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, {
      ...DEFAULT_STATE,
      view: "all",
      q: "空间免疫",
      source: "PUBMED",
      journal: "nature methods",
      tag: "SINGLE-CELL",
      feedback: "save"
    }))).toEqual(["paper-1"]);
  });

  it("keeps rerank-unselected candidates in All without presenting them as Today recommendations", () => {
    const unselected = { candidateId: "paper-unselected", rank: 4, selected: false };
    expect(ids(filterAndSortRecommendations([...RECOMMENDATIONS, unselected], feedback, DEFAULT_STATE)))
      .not.toContain("paper-unselected");
    expect(ids(filterAndSortRecommendations([...RECOMMENDATIONS, unselected], feedback, {
      ...DEFAULT_STATE,
      view: "all"
    }))).toContain("paper-unselected");
  });

  it("sorts by rank, score, newest, and oldest with missing values last", () => {
    const all = { ...DEFAULT_STATE, view: "all" } as const;
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, all)))
      .toEqual(["paper-2", "paper-1", "paper-3"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, { ...all, sort: "score" })))
      .toEqual(["paper-2", "paper-1", "paper-3"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, { ...all, sort: "newest" })))
      .toEqual(["paper-2", "paper-1", "paper-3"]);
    expect(ids(filterAndSortRecommendations(RECOMMENDATIONS, feedback, { ...all, sort: "oldest" })))
      .toEqual(["paper-1", "paper-2", "paper-3"]);
  });

  it("builds deduplicated options from existing feed fields", () => {
    expect(getDashboardFilterOptions(RECOMMENDATIONS)).toEqual({
      sources: ["arxiv", "biorxiv", "journal", "pubmed"],
      journals: ["Nature Methods"],
      tags: ["atlas", "method", "protein-design", "resource", "single-cell", "transformer"]
    });
  });
});

describe("dashboard status view model", () => {
  it("presents complete_with_warnings as a warning completion, not a failure", () => {
    const status = createDashboardStatusViewModel({
      run: run({
        status: "complete_with_warnings",
        errorSummary: "期刊源超时",
        sourceDegradation: {
          degraded: true,
          sources: [
            { source: "journal", status: "failed" },
            { source: "pubmed", status: "success" }
          ]
        }
      }),
      feed: { generatedAt: "2026-07-30T01:00:00.000Z", runId: "run-latest" },
      recommendationCount: 12
    });

    expect(status).toMatchObject({
      businessDate: "2026-07-30",
      runStatus: "complete_with_warnings",
      statusLabel: "完成但有警告",
      statusTone: "warning",
      recommendationCount: 12,
      isHistorical: false,
      contextLabel: "今日结果",
      warningSummary: "来源降级：journal；期刊源超时"
    });
  });

  it("keeps a useful warning summary when detailed degradation fields are absent", () => {
    expect(createDashboardStatusViewModel({
      run: run({ status: "complete_with_warnings" }),
      recommendationCount: 0
    }).warningSummary).toBe("本次运行完成，但包含警告");
  });

  it("marks any explicit run selection as historical and never labels it as today", () => {
    expect(createDashboardStatusViewModel({
      run: run({ runId: "old-run", runDate: "2026-07-25", status: "complete" }),
      recommendationCount: 4,
      selectedRunId: "old-run"
    })).toMatchObject({
      isHistorical: true,
      contextLabel: "历史结果",
      businessDate: "2026-07-25",
      statusLabel: "已完成",
      statusTone: "success"
    });
  });
});

function ids(items: DashboardRecommendation[]) {
  return items.map((item) => item.candidateId);
}

function run(overrides: Partial<DashboardOperationsRun>): DashboardOperationsRun {
  return {
    runId: "run-latest",
    runDate: "2026-07-30",
    status: "complete",
    sourceDegradation: { degraded: false, sources: [] },
    ...overrides
  };
}
