export const DASHBOARD_VIEWS = ["today", "saved", "dismissed", "promoted", "all"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const DASHBOARD_SORTS = ["rank", "score", "newest", "oldest"] as const;
export type DashboardSort = (typeof DASHBOARD_SORTS)[number];

export const DASHBOARD_FEEDBACK_FILTERS = ["all", "none", "save", "dismiss", "promote"] as const;
export type DashboardFeedbackFilter = (typeof DASHBOARD_FEEDBACK_FILTERS)[number];
export type DashboardFeedbackAction = Exclude<DashboardFeedbackFilter, "all" | "none">;

export const DASHBOARD_VISIBLE_LIMIT_OPTIONS = [5, 10, 15, 20, 25, 30] as const;
export const MAX_DASHBOARD_VISIBLE_LIMIT = 30;
export const DEFAULT_MAX_DASHBOARD_VISIBLE_LIMIT = 20;

export type DashboardQueryState = {
  runId?: string;
  view: DashboardView;
  q: string;
  source?: string;
  journal?: string;
  tag?: string;
  feedback: DashboardFeedbackFilter;
  sort: DashboardSort;
  limit?: number;
};

export const DEFAULT_DASHBOARD_QUERY: Readonly<DashboardQueryState> = {
  view: "today",
  q: "",
  feedback: "all",
  sort: "rank"
};

export type DashboardRecommendation = {
  candidateId: string;
  selected?: boolean;
  rank?: number;
  finalScore?: number;
  title?: string;
  abstract?: string;
  publishedAt?: string;
  sources?: readonly string[];
  journal?: {
    name?: string;
  };
  labels?: {
    contentRecall?: { label?: string };
    researchType?: {
      category?: string;
      primaryKeyword?: string;
      secondaryKeyword?: string;
    };
  };
  reasons?: readonly string[];
  summary?: Record<string, unknown>;
};

export type DashboardFilterOptions = {
  sources: string[];
  journals: string[];
  tags: string[];
};

export type DashboardRunStatus =
  | "running"
  | "complete"
  | "complete_with_warnings"
  | "partial"
  | "failed"
  | "unknown";

export type DashboardOperationsRun = {
  runId: string;
  runDate: string;
  status: DashboardRunStatus;
  startedAt?: string;
  finishedAt?: string;
  errorSummary?: string;
  sourceDegradation: {
    degraded: boolean;
    sources?: ReadonlyArray<{
      source: string;
      status: "success" | "failed" | "unknown";
      error?: string;
    }>;
  };
};

export type DashboardStatusTone = "running" | "success" | "warning" | "error" | "neutral";

export type DashboardStatusViewModel = {
  businessDate: string;
  runStatus: DashboardRunStatus;
  statusLabel: string;
  statusTone: DashboardStatusTone;
  recommendationCount: number;
  generatedAt?: string;
  warningSummary?: string;
  isHistorical: boolean;
  contextLabel: string;
};

type SearchParamsLike = Pick<URLSearchParams, "get">;

export function parseDashboardQuery(input: string | SearchParamsLike): DashboardQueryState {
  const params = typeof input === "string"
    ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
    : input;

  const view = parseEnum(params.get("view"), DASHBOARD_VIEWS, DEFAULT_DASHBOARD_QUERY.view);
  const feedback = parseEnum(
    params.get("feedback"),
    DASHBOARD_FEEDBACK_FILTERS,
    DEFAULT_DASHBOARD_QUERY.feedback
  );
  const sort = parseEnum(params.get("sort"), DASHBOARD_SORTS, DEFAULT_DASHBOARD_QUERY.sort);
  const limit = parseDashboardVisibleLimit(params.get("limit"));

  return {
    ...optionalParam("runId", params.get("runId")),
    view,
    q: normalizeParam(params.get("q")) ?? "",
    ...optionalParam("source", params.get("source")),
    ...optionalParam("journal", params.get("journal")),
    ...optionalParam("tag", params.get("tag")),
    feedback,
    sort,
    ...(limit ? { limit } : {})
  };
}

export function serializeDashboardQuery(state: DashboardQueryState): URLSearchParams {
  const params = new URLSearchParams();
  setIfPresent(params, "runId", state.runId);
  if (state.view !== DEFAULT_DASHBOARD_QUERY.view) params.set("view", state.view);
  setIfPresent(params, "q", state.q);
  setIfPresent(params, "source", state.source);
  setIfPresent(params, "journal", state.journal);
  setIfPresent(params, "tag", state.tag);
  if (state.feedback !== DEFAULT_DASHBOARD_QUERY.feedback) params.set("feedback", state.feedback);
  if (state.sort !== DEFAULT_DASHBOARD_QUERY.sort) params.set("sort", state.sort);
  const limit = normalizeDashboardVisibleLimit(state.limit);
  if (limit) params.set("limit", String(limit));
  return params;
}

export function resolveDashboardVisibleLimit(
  configuredLimit: number | undefined,
  actualSelectedCount: number
): number {
  return normalizeDashboardVisibleLimit(configuredLimit) ??
    Math.min(Math.max(0, Math.trunc(actualSelectedCount)), DEFAULT_MAX_DASHBOARD_VISIBLE_LIMIT);
}

export function applyDashboardVisibleLimit<T>(recommendations: readonly T[], limit: number): T[] {
  return recommendations.slice(0, Math.max(0, Math.trunc(limit)));
}

export function selectDashboardRun(
  state: DashboardQueryState,
  runId: string | undefined
): DashboardQueryState {
  const selectedRunId = normalizeParam(runId);
  if (!selectedRunId) {
    const { runId: _runId, ...todayState } = state;
    return todayState;
  }
  return { ...state, runId: selectedRunId };
}

export function clearDashboardFilters(state: DashboardQueryState): DashboardQueryState {
  return {
    ...DEFAULT_DASHBOARD_QUERY,
    ...(state.runId ? { runId: state.runId } : {})
  };
}

export function dashboardFeedQuery(state: DashboardQueryState): URLSearchParams {
  const params = new URLSearchParams({ selectedOnly: "false" });
  if (state.runId) params.set("runId", state.runId);
  return params;
}

export function filterAndSortRecommendations<T extends DashboardRecommendation>(
  recommendations: readonly T[],
  feedbackByCandidate: Readonly<Record<string, DashboardFeedbackAction | undefined>>,
  state: DashboardQueryState
): T[] {
  const query = state.q.trim().toLocaleLowerCase();
  const source = normalizeForMatch(state.source);
  const journal = normalizeForMatch(state.journal);
  const tag = normalizeForMatch(state.tag);

  return recommendations
    .filter((item) => {
      if (item.selected === false) return false;
      const feedback = feedbackByCandidate[item.candidateId];
      if (!matchesView(state.view, feedback)) return false;
      if (!matchesFeedback(state.feedback, feedback)) return false;
      if (source && !item.sources?.some((value) => normalizeForMatch(value) === source)) return false;
      if (journal && normalizeForMatch(item.journal?.name) !== journal) return false;
      if (tag && !recommendationTags(item).some((value) => normalizeForMatch(value) === tag)) return false;
      if (query && !recommendationSearchText(item).includes(query)) return false;
      return true;
    })
    .sort(recommendationComparator(state.sort));
}

export function getDashboardFilterOptions(
  recommendations: readonly DashboardRecommendation[]
): DashboardFilterOptions {
  const sources = new Set<string>();
  const journals = new Set<string>();
  const tags = new Set<string>();

  for (const item of recommendations) {
    if (item.selected === false) continue;
    for (const source of item.sources ?? []) addNonEmpty(sources, source);
    addNonEmpty(journals, item.journal?.name);
    for (const tag of recommendationTags(item)) addNonEmpty(tags, tag);
  }

  return {
    sources: sortLabels(sources),
    journals: sortLabels(journals),
    tags: sortLabels(tags)
  };
}

export function createDashboardStatusViewModel(input: {
  run?: DashboardOperationsRun | null;
  feed?: { generatedAt?: string; runId?: string } | null;
  recommendationCount: number;
  selectedRunId?: string;
  fallbackBusinessDate?: string;
}): DashboardStatusViewModel {
  const status = input.run?.status ?? "unknown";
  const isHistorical = Boolean(normalizeParam(input.selectedRunId));
  const failedSources = input.run?.sourceDegradation.sources
    ?.filter((source) => source.status === "failed")
    .map((source) => source.source);
  const sourceWarning = input.run?.sourceDegradation.degraded
    ? failedSources && failedSources.length > 0
      ? `来源降级：${failedSources.join("、")}`
      : "存在来源降级"
    : undefined;
  const hasDetailedWarning = Boolean(sourceWarning || input.run?.errorSummary);
  const statusWarning = hasDetailedWarning
    ? undefined
    : status === "complete_with_warnings"
      ? "本次运行完成，但包含警告"
      : status === "partial"
        ? "本次运行仅部分完成"
        : undefined;

  return {
    businessDate: input.run?.runDate ?? input.fallbackBusinessDate ?? "未知",
    runStatus: status,
    statusLabel: RUN_STATUS_PRESENTATION[status].label,
    statusTone: RUN_STATUS_PRESENTATION[status].tone,
    recommendationCount: input.recommendationCount,
    generatedAt: input.feed?.generatedAt ?? input.run?.finishedAt,
    warningSummary: joinWarnings(sourceWarning, input.run?.errorSummary, statusWarning),
    isHistorical,
    contextLabel: isHistorical ? "历史结果" : "今日结果"
  };
}

const RUN_STATUS_PRESENTATION: Record<
  DashboardRunStatus,
  { label: string; tone: DashboardStatusTone }
> = {
  running: { label: "运行中", tone: "running" },
  complete: { label: "已完成", tone: "success" },
  complete_with_warnings: { label: "完成但有警告", tone: "warning" },
  partial: { label: "部分完成", tone: "warning" },
  failed: { label: "失败", tone: "error" },
  unknown: { label: "状态未知", tone: "neutral" }
};

function matchesView(
  view: DashboardView,
  feedback: DashboardFeedbackAction | undefined
) {
  if (view === "today") return feedback !== "dismiss";
  if (view === "saved") return feedback === "save";
  if (view === "dismissed") return feedback === "dismiss";
  if (view === "promoted") return feedback === "promote";
  return true;
}

function matchesFeedback(
  filter: DashboardFeedbackFilter,
  feedback: DashboardFeedbackAction | undefined
) {
  if (filter === "all") return true;
  if (filter === "none") return feedback === undefined;
  return feedback === filter;
}

function recommendationTags(item: DashboardRecommendation): string[] {
  return [
    item.labels?.contentRecall?.label,
    item.labels?.researchType?.category,
    item.labels?.researchType?.primaryKeyword,
    item.labels?.researchType?.secondaryKeyword
  ].filter((value): value is string => Boolean(normalizeParam(value)));
}

function recommendationSearchText(item: DashboardRecommendation): string {
  const summaryText = item.summary
    ? Object.values(item.summary).filter((value): value is string => typeof value === "string")
    : [];
  return [
    item.title,
    item.abstract,
    item.journal?.name,
    ...(item.sources ?? []),
    ...recommendationTags(item),
    ...(item.reasons ?? []),
    ...summaryText
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
}

function recommendationComparator(sort: DashboardSort) {
  return (left: DashboardRecommendation, right: DashboardRecommendation) => {
    if (sort === "score") return compareOptionalNumbers(left.finalScore, right.finalScore, "desc");
    if (sort === "newest") return compareOptionalDates(left.publishedAt, right.publishedAt, "desc");
    if (sort === "oldest") return compareOptionalDates(left.publishedAt, right.publishedAt, "asc");
    return compareNumbers(left.rank, right.rank);
  };
}

function compareNumbers(left: number | undefined, right: number | undefined) {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
  direction: "asc" | "desc"
) {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return direction === "asc" ? left - right : right - left;
}

function compareOptionalDates(
  left: string | undefined,
  right: string | undefined,
  direction: "asc" | "desc"
) {
  const leftValue = dateValue(left);
  const rightValue = dateValue(right);
  if (leftValue === undefined) return rightValue === undefined ? 0 : 1;
  if (rightValue === undefined) return -1;
  return direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
}

function dateValue(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseEnum<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

function parseDashboardVisibleLimit(value: string | null): number | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;
  return normalizeDashboardVisibleLimit(Number(normalized));
}

function normalizeDashboardVisibleLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= MAX_DASHBOARD_VISIBLE_LIMIT
    ? value
    : undefined;
}

function normalizeParam(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeForMatch(value: string | undefined) {
  return normalizeParam(value)?.toLocaleLowerCase();
}

function optionalParam<Key extends string>(key: Key, value: string | null | undefined) {
  const normalized = normalizeParam(value);
  return normalized ? ({ [key]: normalized } as Record<Key, string>) : {};
}

function setIfPresent(params: URLSearchParams, key: string, value: string | undefined) {
  const normalized = normalizeParam(value);
  if (normalized) params.set(key, normalized);
}

function addNonEmpty(target: Set<string>, value: string | undefined) {
  const normalized = normalizeParam(value);
  if (normalized) target.add(normalized);
}

function sortLabels(values: Set<string>) {
  return [...values].sort((left, right) => left.localeCompare(right, "zh-CN", { sensitivity: "base" }));
}

function joinWarnings(...warnings: Array<string | undefined>) {
  const present = warnings.filter((warning): warning is string => Boolean(normalizeParam(warning)));
  return present.length > 0 ? present.join("；") : undefined;
}
