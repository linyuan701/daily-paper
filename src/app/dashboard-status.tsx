import React from "react";

import type { DashboardStatusViewModel } from "./dashboard-state";

export type DashboardStatusProps = {
  status: DashboardStatusViewModel;
  operationsHref?: string;
};

export function DashboardStatus({ status, operationsHref = "/operations" }: DashboardStatusProps) {
  return (
    <section
      className={`dashboard-status status-${status.statusTone}`}
      aria-labelledby="dashboard-status-title"
    >
      <div className="dashboard-status-heading">
        <div>
          <p className="dashboard-context-label">{status.contextLabel}</p>
          <h2 id="dashboard-status-title">业务日期 {status.businessDate}</h2>
        </div>
        <a href={operationsHref}>Operations</a>
      </div>

      {status.isHistorical ? (
        <p className="historical-view-notice" role="status">
          这是历史运行结果，不是今日最新推荐。
        </p>
      ) : null}

      <dl className="dashboard-status-grid">
        <div>
          <dt>运行状态</dt>
          <dd>
            <span className="status-symbol" aria-hidden="true">{statusSymbol(status.statusTone)}</span>{" "}
            {status.statusLabel}
          </dd>
        </div>
        <div>
          <dt>推荐数量</dt>
          <dd>{status.recommendationCount} 篇</dd>
        </div>
        <div>
          <dt>生成时间</dt>
          <dd>{formatGeneratedAt(status.generatedAt)}</dd>
        </div>
        <div>
          <dt>运行提示</dt>
          <dd>{status.warningSummary ?? "无警告"}</dd>
        </div>
      </dl>
    </section>
  );
}

function statusSymbol(tone: DashboardStatusViewModel["statusTone"]) {
  if (tone === "success") return "✓";
  if (tone === "warning") return "!";
  if (tone === "error") return "×";
  if (tone === "running") return "…";
  return "?";
}

function formatGeneratedAt(value: string | undefined) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN");
}
