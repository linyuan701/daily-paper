"use client";

import React, { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import {
  clearDashboardFilters,
  DASHBOARD_VISIBLE_LIMIT_OPTIONS,
  MAX_DASHBOARD_VISIBLE_LIMIT,
  resolveDashboardVisibleLimit,
  selectDashboardRun,
  type DashboardFilterOptions,
  type DashboardOperationsRun,
  type DashboardQueryState,
  type DashboardSort,
  type DashboardView
} from "./dashboard-state";

const VIEW_OPTIONS: ReadonlyArray<{ value: DashboardView; label: string }> = [
  { value: "today", label: "Today" },
  { value: "saved", label: "Saved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "promoted", label: "Promoted" },
  { value: "all", label: "All" }
];

const SORT_OPTIONS: ReadonlyArray<{ value: DashboardSort; label: string }> = [
  { value: "rank", label: "推荐顺序" },
  { value: "score", label: "推荐分数" },
  { value: "newest", label: "最新发表" },
  { value: "oldest", label: "最早发表" }
];

export type DashboardControlsProps = {
  state: DashboardQueryState;
  options: DashboardFilterOptions;
  runs: readonly DashboardOperationsRun[];
  resultCount: number;
  totalCount: number;
  selectedRecommendationCount: number;
  onChange: (next: DashboardQueryState) => void;
  disabled?: boolean;
};

export function DashboardControls({
  state,
  options,
  runs,
  resultCount,
  totalCount,
  selectedRecommendationCount,
  onChange,
  disabled = false
}: DashboardControlsProps) {
  const automaticVisibleLimit = resolveDashboardVisibleLimit(undefined, selectedRecommendationCount);
  const visibleLimit = resolveDashboardVisibleLimit(state.limit, selectedRecommendationCount);
  const [manualLimit, setManualLimit] = useState(visibleLimit > 0 ? String(visibleLimit) : "");
  const [limitError, setLimitError] = useState<string>();

  useEffect(() => {
    setManualLimit(visibleLimit > 0 ? String(visibleLimit) : "");
    setLimitError(undefined);
  }, [visibleLimit]);

  function update(patch: Partial<DashboardQueryState>) {
    onChange({ ...state, ...patch });
  }

  function applyManualLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = manualLimit.trim();
    const parsed = Number(normalized);
    if (!/^\d+$/.test(normalized) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DASHBOARD_VISIBLE_LIMIT) {
      setLimitError(`请输入 1–${MAX_DASHBOARD_VISIBLE_LIMIT} 之间的整数。`);
      return;
    }
    setLimitError(undefined);
    update({ limit: parsed });
  }

  function updateOptional(
    key: "source" | "journal" | "tag",
    event: ChangeEvent<HTMLSelectElement>
  ) {
    const value = event.target.value || undefined;
    onChange({ ...state, [key]: value });
  }

  return (
    <section className="dashboard-controls" aria-labelledby="dashboard-filters-title">
      <div className="dashboard-view-tabs" aria-label="推荐视图">
        {VIEW_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            aria-pressed={state.view === option.value}
            className={state.view === option.value ? "is-active" : undefined}
            onClick={() => onChange(
              option.value === "today"
                ? selectDashboardRun({ ...state, view: "today" }, undefined)
                : { ...state, view: option.value }
            )}
            disabled={disabled}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="dashboard-history-control">
        <label htmlFor="dashboard-run">查看日期</label>
        <select
          id="dashboard-run"
          value={state.runId ?? ""}
          onChange={(event) => onChange(selectDashboardRun(state, event.target.value || undefined))}
          disabled={disabled}
        >
          <option value="">今日（最新运行）</option>
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.runDate} · {runStatusLabel(run.status)}
            </option>
          ))}
        </select>
        {state.runId ? <strong className="historical-view-marker">正在查看历史结果</strong> : null}
      </div>

      <fieldset disabled={disabled}>
        <legend id="dashboard-filters-title">筛选推荐</legend>
        <label htmlFor="dashboard-search">
          关键词
          <input
            id="dashboard-search"
            type="search"
            value={state.q}
            placeholder="标题、摘要、标签或推荐原因"
            onChange={(event) => update({ q: event.target.value })}
          />
        </label>
        <FilterSelect
          id="dashboard-source"
          label="来源"
          value={state.source}
          options={options.sources}
          onChange={(event) => updateOptional("source", event)}
        />
        <FilterSelect
          id="dashboard-journal"
          label="期刊"
          value={state.journal}
          options={options.journals}
          onChange={(event) => updateOptional("journal", event)}
        />
        <FilterSelect
          id="dashboard-tag"
          label="标签"
          value={state.tag}
          options={options.tags}
          onChange={(event) => updateOptional("tag", event)}
        />
        <label htmlFor="dashboard-feedback">
          Feedback 状态
          <select
            id="dashboard-feedback"
            value={state.feedback}
            onChange={(event) => update({
              feedback: event.target.value as DashboardQueryState["feedback"]
            })}
          >
            <option value="all">全部</option>
            <option value="none">未处理</option>
            <option value="save">已保存</option>
            <option value="dismiss">已忽略</option>
            <option value="promote">已提升</option>
          </select>
        </label>
        <label htmlFor="dashboard-sort">
          排序
          <select
            id="dashboard-sort"
            value={state.sort}
            onChange={(event) => update({ sort: event.target.value as DashboardSort })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => onChange(clearDashboardFilters(state))}>
          清除筛选
        </button>
      </fieldset>

      <fieldset className="dashboard-visible-limit" disabled={disabled}>
        <legend>页面显示数量</legend>
        <div className="dashboard-limit-options" aria-label="推荐显示数量快捷选项">
          <button
            type="button"
            aria-pressed={state.limit === undefined}
            className={state.limit === undefined ? "is-active" : undefined}
            onClick={() => update({ limit: undefined })}
          >
            自动（{automaticVisibleLimit}）
          </button>
          {DASHBOARD_VISIBLE_LIMIT_OPTIONS.map((limit) => (
            <button
              type="button"
              key={limit}
              aria-pressed={state.limit === limit}
              className={state.limit === limit ? "is-active" : undefined}
              onClick={() => update({ limit })}
            >
              {limit}
            </button>
          ))}
        </div>
        <form className="dashboard-limit-manual" onSubmit={applyManualLimit} noValidate>
          <label htmlFor="dashboard-limit">
            手动输入 1–30
            <input
              id="dashboard-limit"
              type="number"
              min="1"
              max="30"
              step="1"
              inputMode="numeric"
              placeholder="1–30"
              value={manualLimit}
              aria-invalid={Boolean(limitError)}
              aria-describedby={limitError ? "dashboard-limit-error" : "dashboard-limit-current"}
              onChange={(event) => {
                setManualLimit(event.target.value);
                setLimitError(undefined);
              }}
            />
          </label>
          <button type="submit">应用</button>
        </form>
        <p id="dashboard-limit-current" className="dashboard-limit-current" aria-live="polite">
          当前最多显示 {visibleLimit} 篇；可用结果不足时不会补齐。
        </p>
        {limitError ? <p id="dashboard-limit-error" className="dashboard-limit-error" role="alert">{limitError}</p> : null}
      </fieldset>

      <p className="dashboard-result-count" role="status" aria-live="polite" aria-atomic="true">
        显示 {resultCount} / {totalCount} 篇推荐
      </p>
    </section>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange
}: {
  id: string;
  label: string;
  value?: string;
  options: readonly string[];
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <label htmlFor={id}>
      {label}
      <select id={id} value={value ?? ""} onChange={onChange}>
        <option value="">全部</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function runStatusLabel(status: DashboardOperationsRun["status"]) {
  if (status === "complete_with_warnings") return "完成但有警告";
  if (status === "complete") return "已完成";
  if (status === "running") return "运行中";
  if (status === "partial") return "部分完成";
  if (status === "failed") return "失败";
  return "状态未知";
}
