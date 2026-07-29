"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { DailyRecommendationFeed, DailyRecommendationRecord } from "../modules/ranking/explain/types";
import { DashboardControls } from "./dashboard-controls";
import {
  createDashboardStatusViewModel,
  dashboardFeedQuery,
  DEFAULT_DASHBOARD_QUERY,
  filterAndSortRecommendations,
  getDashboardFilterOptions,
  parseDashboardQuery,
  serializeDashboardQuery,
  type DashboardOperationsRun,
  type DashboardQueryState
} from "./dashboard-state";
import { DashboardStatus } from "./dashboard-status";
import { createFeedbackController, type FeedbackController } from "./feedback-interactions";
import {
  createFeedbackState,
  effectiveTriageActions,
  latestTriageActions,
  type FeedbackState,
  type TriageAction
} from "./feedback-state";
import { RecommendationCard } from "./recommendation-card";

const IS_CLOUD_MODE = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === "cloud";

type LabelEditState = {
  contentRecallLabel: string;
  category: "" | "method" | "biology" | "resource" | "benchmark";
  primaryKeyword: string;
  secondaryKeyword: string;
};

export default function HomePage() {
  const [query, setQuery] = useState<DashboardQueryState>({ ...DEFAULT_DASHBOARD_QUERY });
  const [feed, setFeed] = useState<DailyRecommendationFeed | null>(null);
  const [runs, setRuns] = useState<DashboardOperationsRun[]>([]);
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({});
  const [loading, setLoading] = useState(true);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [feedbackLoadError, setFeedbackLoadError] = useState<string | null>(null);
  const [labelEdits, setLabelEdits] = useState<Record<string, LabelEditState>>({});
  const [labelPending, setLabelPending] = useState<Record<string, boolean>>({});
  const [labelMessage, setLabelMessage] = useState<Record<string, string | undefined>>({});
  const [exportState, setExportState] = useState<{ tone: "success" | "error" | "pending"; message: string }>();
  const [refreshTick, setRefreshTick] = useState(0);
  const feedbackController = useRef<FeedbackController | null>(null);

  useEffect(() => {
    setQuery(parseDashboardQuery(window.location.search));
    const onPopState = () => setQuery(parseDashboardQuery(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const flushPendingFeedback = () => {
      feedbackController.current?.dispose();
      feedbackController.current = null;
    };
    const restoreAfterBackForwardCache = (event: PageTransitionEvent) => {
      if (event.persisted) setRefreshTick((value) => value + 1);
    };
    window.addEventListener("pagehide", flushPendingFeedback);
    window.addEventListener("pageshow", restoreAfterBackForwardCache);
    return () => {
      window.removeEventListener("pagehide", flushPendingFeedback);
      window.removeEventListener("pageshow", restoreAfterBackForwardCache);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadRuns() {
      try {
        setOperationsLoading(true);
        setOperationsError(null);
        const response = await fetch("/api/operations/runs?limit=30", {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`请求失败 (${response.status})`);
        const payload = await response.json() as { status?: string; runs?: DashboardOperationsRun[] };
        if (payload.status !== "ok" || !Array.isArray(payload.runs)) throw new Error("返回数据格式无效");
        setRuns(payload.runs);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setOperationsError(loadError instanceof Error ? loadError.message : "无法读取运行历史");
        }
      } finally {
        if (!controller.signal.aborted) setOperationsLoading(false);
      }
    }
    void loadRuns();
    return () => controller.abort();
  }, [refreshTick]);

  useEffect(() => {
    const controller = new AbortController();
    feedbackController.current?.dispose();
    feedbackController.current = null;

    async function loadFeed() {
      try {
        setLoading(true);
        setError(null);
        setFeedbackLoadError(null);
        setFeed(null);
        setFeedbackState({});

        const response = await fetch(`/api/recommendations/daily?${dashboardFeedQuery(query)}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`请求失败 (${response.status})`);
        const payload = await response.json() as { status?: string; feed?: DailyRecommendationFeed | null };
        if (payload.status !== "ok") throw new Error("推荐接口未返回成功状态");
        const nextFeed = payload.feed ?? null;
        if (!nextFeed) return;

        let initialActions: Record<string, TriageAction> = {};
        try {
          const feedbackQuery = new URLSearchParams({ runId: nextFeed.runId, limit: "500" });
          const feedbackResponse = await fetch(`/api/feedback/logs?${feedbackQuery}`, {
            cache: "no-store",
            signal: controller.signal
          });
          if (!feedbackResponse.ok) throw new Error(`请求失败 (${feedbackResponse.status})`);
          const feedbackPayload = await feedbackResponse.json() as { status?: string; logs?: unknown };
          if (feedbackPayload.status !== "ok") throw new Error("反馈接口未返回成功状态");
          initialActions = latestTriageActions(feedbackPayload.logs);
        } catch (loadError) {
          if (controller.signal.aborted) return;
          setFeedbackLoadError(loadError instanceof Error ? loadError.message : "无法恢复反馈状态");
        }

        const initialState = createFeedbackState(initialActions);
        setFeedbackState(initialState);
        feedbackController.current = createFeedbackController({
          runId: nextFeed.runId,
          initialActions,
          onChange: setFeedbackState
        });
        setFeed(nextFeed);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "无法读取推荐");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadFeed();
    return () => {
      controller.abort();
      feedbackController.current?.dispose();
      feedbackController.current = null;
    };
  }, [query.runId, refreshTick]);

  const currentRun = useMemo(() => {
    if (query.runId) return runs.find((run) => run.runId === query.runId) ?? null;
    return runs[0] ?? null;
  }, [query.runId, runs]);

  const visibleFeed = useMemo(() => {
    if (!feed) return null;
    if (query.runId) return feed.runId === query.runId ? feed : null;
    if (operationsLoading || operationsError || !currentRun) return null;
    return feed.runId === currentRun.runId ? feed : null;
  }, [currentRun, feed, operationsError, operationsLoading, query.runId]);

  const effectiveActions = useMemo(() => effectiveTriageActions(feedbackState), [feedbackState]);
  const filterOptions = useMemo(
    () => getDashboardFilterOptions(visibleFeed?.recommendations ?? []),
    [visibleFeed]
  );
  const recommendations = useMemo(
    () => filterAndSortRecommendations(visibleFeed?.recommendations ?? [], effectiveActions, query),
    [effectiveActions, query, visibleFeed]
  );
  const viewTotalCount = useMemo(() => filterAndSortRecommendations(
    visibleFeed?.recommendations ?? [],
    effectiveActions,
    {
      ...query,
      q: "",
      source: undefined,
      journal: undefined,
      tag: undefined,
      feedback: "all"
    }
  ).length, [effectiveActions, query, visibleFeed]);
  const status = useMemo(() => createDashboardStatusViewModel({
    run: currentRun,
    feed: visibleFeed,
    recommendationCount: visibleFeed?.recommendations.filter((item) => item.selected !== false).length ?? 0,
    selectedRunId: query.runId
  }), [currentRun, query.runId, visibleFeed]);
  const pendingDismisses = useMemo(() => Object.entries(feedbackState).filter(
    ([, item]) => item?.pendingAction === "dismiss"
  ), [feedbackState]);

  function updateQuery(next: DashboardQueryState) {
    const runChanged = next.runId !== query.runId;
    setQuery(next);
    const serialized = serializeDashboardQuery(next).toString();
    const href = `${window.location.pathname}${serialized ? `?${serialized}` : ""}`;
    window.history[runChanged ? "pushState" : "replaceState"]({}, "", href);
  }

  async function handleFeedback(candidateId: string, action: TriageAction) {
    await feedbackController.current?.perform(candidateId, action);
  }

  function getEditState(item: DailyRecommendationRecord): LabelEditState {
    return labelEdits[item.candidateId] ?? {
      contentRecallLabel: item.labels.contentRecall?.label ?? "",
      category: item.labels.researchType?.category ?? "",
      primaryKeyword: item.labels.researchType?.primaryKeyword ?? "",
      secondaryKeyword: item.labels.researchType?.secondaryKeyword ?? ""
    };
  }

  function updateEditState(item: DailyRecommendationRecord, patch: Partial<LabelEditState>) {
    setLabelEdits((previous) => ({
      ...previous,
      [item.candidateId]: { ...(previous[item.candidateId] ?? defaultEditState(item)), ...patch }
    }));
  }

  async function saveLabelEdit(item: DailyRecommendationRecord) {
    const edit = getEditState(item);
    setLabelPending((previous) => ({ ...previous, [item.candidateId]: true }));
    setLabelMessage((previous) => ({ ...previous, [item.candidateId]: undefined }));
    try {
      const response = await fetch("/api/candidates/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: item.candidateId,
          labels: {
            contentRecallLabel: edit.contentRecallLabel,
            researchType: {
              category: edit.category || undefined,
              primaryKeyword: edit.primaryKeyword || undefined,
              secondaryKeyword: edit.secondaryKeyword || undefined
            }
          }
        })
      });
      if (!response.ok) throw new Error(`保存失败 (${response.status})`);
      setLabelMessage((previous) => ({ ...previous, [item.candidateId]: "标签已保存" }));
      setRefreshTick((value) => value + 1);
    } catch (saveError) {
      setLabelMessage((previous) => ({
        ...previous,
        [item.candidateId]: saveError instanceof Error ? saveError.message : "标签保存失败"
      }));
    } finally {
      setLabelPending((previous) => ({ ...previous, [item.candidateId]: false }));
    }
  }

  async function exportToObsidian() {
    if (!visibleFeed) return;
    setExportState({ tone: "pending", message: "正在导出到 Obsidian…" });
    try {
      const response = await fetch("/api/obsidian/export/daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: visibleFeed.runId,
          selectedOnly: true,
          source: isRecommendationSource(query.source) ? query.source : undefined
        })
      });
      const payload = await response.json() as {
        status?: string;
        result?: { recommendationCount: number; dailyNotePath: string };
        message?: string;
      };
      if (!response.ok || payload.status !== "ok" || !payload.result) {
        throw new Error(payload.message ?? `导出失败 (${response.status})`);
      }
      setExportState({
        tone: "success",
        message: `已导出 ${payload.result.recommendationCount} 篇推荐到 ${payload.result.dailyNotePath}`
      });
    } catch (exportError) {
      setExportState({ tone: "error", message: exportError instanceof Error ? exportError.message : "导出失败" });
    }
  }

  const staleLatestFeed = !query.runId && Boolean(
    feed && !operationsLoading && (operationsError || !currentRun || feed.runId !== currentRun.runId)
  );

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">DAILY PAPER</p>
          <h1>每日论文发现与分诊</h1>
          <p className="subtitle">快速判断今天是否有新推荐，并把最值得读的论文排到前面。</p>
        </div>
        <nav className="header-links" aria-label="主要导航">
          <a href="/operations">Operations</a>
          <a href="/collections">Collection Priorities</a>
          <a href="/journals">Journal Pool</a>
          <a href="/api/recommendations/daily">Feed API</a>
        </nav>
      </header>

      <DashboardStatus status={status} />

      {operationsError ? (
        <p className="inline-warning" role="status">运行状态暂不可用：{operationsError}</p>
      ) : null}

      <DashboardControls
        state={query}
        options={filterOptions}
        runs={runs}
        resultCount={recommendations.length}
        totalCount={viewTotalCount}
        onChange={updateQuery}
        disabled={loading || operationsLoading}
      />

      {!IS_CLOUD_MODE && visibleFeed ? (
        <div className="dashboard-secondary-actions">
          <button type="button" onClick={() => void exportToObsidian()} disabled={exportState?.tone === "pending"}>
            {exportState?.tone === "pending" ? "导出中…" : "导出本次推荐到 Obsidian"}
          </button>
        </div>
      ) : null}
      {exportState ? (
        <p className={exportState.tone === "error" ? "error" : "success"} role={exportState.tone === "error" ? "alert" : "status"}>
          {exportState.message}
        </p>
      ) : null}

      {loading || (!query.runId && operationsLoading) ? (
        <DashboardMessage kind="loading" message="正在读取推荐并核对业务运行…" />
      ) : null}
      {!loading && error ? <DashboardMessage kind="error" message={`推荐加载失败：${error}`} /> : null}
      {feedbackLoadError ? <DashboardMessage kind="warning" message={`反馈状态未完全恢复：${feedbackLoadError}`} /> : null}
      {!loading && !operationsLoading && !error && staleLatestFeed ? (
        <DashboardMessage
          kind="warning"
          message="最新业务运行还没有对应的可用推荐结果。为避免把旧结果误认为今日推荐，旧 feed 已隐藏。"
        />
      ) : null}
      {!loading && !operationsLoading && !operationsError && !error && !staleLatestFeed && !visibleFeed ? (
        <DashboardMessage
          kind="empty"
          message={query.runId ? "该历史运行没有可用推荐结果。" : "今天还没有可用推荐。请稍后刷新查看运行结果。"}
        />
      ) : null}
      {!loading && !error && visibleFeed && recommendations.length === 0 ? (
        <DashboardMessage kind="empty" message="当前筛选条件下没有推荐。可清除筛选或切换视图。" />
      ) : null}

      {pendingDismisses.length > 0 ? (
        <aside className="undo-toast" role="status" aria-live="assertive">
          <strong>已暂时移除 {pendingDismisses.length} 篇论文</strong>
          <ul className="undo-toast-list">
            {pendingDismisses.map(([candidateId]) => (
              <li key={candidateId}>
                <span>{feed?.recommendations.find((item) => item.candidateId === candidateId)?.title ?? "题名暂缺"}</span>
                <button type="button" onClick={() => feedbackController.current?.undoDismiss(candidateId)}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      {recommendations.length > 0 ? (
        <section className="recommendation-list" aria-label="论文推荐列表">
          {recommendations.map((item) => (
            <RecommendationCard
              key={item.candidateId}
              recommendation={item}
              feedback={feedbackState[item.candidateId]}
              onFeedback={handleFeedback}
              detailsActions={
                <LabelEditor
                  item={item}
                  edit={getEditState(item)}
                  pending={Boolean(labelPending[item.candidateId])}
                  message={labelMessage[item.candidateId]}
                  onChange={(patch) => updateEditState(item, patch)}
                  onSave={() => void saveLabelEdit(item)}
                />
              }
            />
          ))}
        </section>
      ) : null}
    </main>
  );
}

function DashboardMessage({ kind, message }: { kind: "loading" | "error" | "warning" | "empty"; message: string }) {
  return (
    <section className={`dashboard-message message-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <strong>{kind === "loading" ? "加载中" : kind === "error" ? "出现问题" : kind === "warning" ? "请注意" : "暂无结果"}</strong>
      <p>{message}</p>
    </section>
  );
}

function LabelEditor({
  item,
  edit,
  pending,
  message,
  onChange,
  onSave
}: {
  item: DailyRecommendationRecord;
  edit: LabelEditState;
  pending: boolean;
  message?: string;
  onChange: (patch: Partial<LabelEditState>) => void;
  onSave: () => void;
}) {
  return (
    <section className="label-edit" aria-labelledby={`label-edit-${item.candidateId}`}>
      <h3 id={`label-edit-${item.candidateId}`}>编辑结构化标签</h3>
      <div className="edit-grid">
        <label>内容召回<input value={edit.contentRecallLabel} onChange={(event) => onChange({ contentRecallLabel: event.target.value })} /></label>
        <label>研究类别<select value={edit.category} onChange={(event) => onChange({ category: event.target.value as LabelEditState["category"] })}>
          <option value="">未知</option><option value="method">method</option><option value="biology">biology</option>
          <option value="resource">resource</option><option value="benchmark">benchmark</option>
        </select></label>
        <label>主要关键词<input value={edit.primaryKeyword} onChange={(event) => onChange({ primaryKeyword: event.target.value })} /></label>
        <label>次要关键词<input value={edit.secondaryKeyword} onChange={(event) => onChange({ secondaryKeyword: event.target.value })} /></label>
      </div>
      <button type="button" onClick={onSave} disabled={pending}>{pending ? "保存中…" : "保存标签编辑"}</button>
      {message ? <p className="triage-state" role="status">{message}</p> : null}
    </section>
  );
}

function defaultEditState(item: DailyRecommendationRecord): LabelEditState {
  return {
    contentRecallLabel: item.labels.contentRecall?.label ?? "",
    category: item.labels.researchType?.category ?? "",
    primaryKeyword: item.labels.researchType?.primaryKeyword ?? "",
    secondaryKeyword: item.labels.researchType?.secondaryKeyword ?? ""
  };
}

function isRecommendationSource(value: string | undefined): value is "biorxiv" | "arxiv" | "pubmed" | "journal" {
  return value === "biorxiv" || value === "arxiv" || value === "pubmed" || value === "journal";
}
