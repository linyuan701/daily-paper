"use client";

import type { ReactNode } from "react";

import type { DailyRecommendationRecord, RecommendationSourceValue } from "../modules/ranking/explain/types";
import type { CandidateFeedbackState, TriageAction } from "./feedback-state";

export type RecommendationCardProps = {
  recommendation: DailyRecommendationRecord;
  feedback?: CandidateFeedbackState;
  onFeedback: (candidateId: string, action: TriageAction) => void | Promise<void>;
  detailsActions?: ReactNode;
};

const SOURCE_LABELS: Record<RecommendationSourceValue, string> = {
  biorxiv: "bioRxiv",
  arxiv: "arXiv",
  pubmed: "PubMed",
  journal: "期刊"
};

const ACTION_LABELS: Record<TriageAction, string> = {
  save: "收藏",
  dismiss: "不感兴趣",
  promote: "优先阅读"
};

export function RecommendationCard({
  recommendation,
  feedback,
  onFeedback,
  detailsActions
}: RecommendationCardProps) {
  const title = recommendation.title?.trim() || "题名暂缺";
  const titleId = `paper-${toDomId(recommendation.candidateId)}-title`;
  const statusId = `paper-${toDomId(recommendation.candidateId)}-feedback`;
  const originalUrl = getPrimaryPaperUrl(recommendation);
  const pending = feedback?.status === "pending";
  const projection = feedback?.current;
  const limitations = getSourceLimitations(recommendation, originalUrl);

  return (
    <article className="recommendation-card" aria-labelledby={titleId}>
      <header className="card-header">
        <div className="card-heading">
          <p className="card-rank">推荐 #{recommendation.rank}</p>
          <h2 id={titleId}>{title}</h2>
          <p className="meta-line">
            <span>推荐分 {formatScore(recommendation.finalScore)}</span>
            <span>{formatPublicationDate(recommendation.publishedAt)}</span>
            {recommendation.journal?.name ? <span>{recommendation.journal.name}</span> : null}
          </p>
        </div>
        <div className="badges" aria-label="论文来源">
          {recommendation.sources.length > 0 ? (
            recommendation.sources.map((source) => (
              <span className="badge source" key={`${recommendation.candidateId}-${source}`}>
                {SOURCE_LABELS[source]}
              </span>
            ))
          ) : (
            <span className="badge source">来源未标注</span>
          )}
          {recommendation.journal?.quartile ? (
            <span className="badge journal">{recommendation.journal.quartile}</span>
          ) : null}
          {projection?.saved && !projection.dismissed ? (
            <span className="badge feedback-state-badge">Saved</span>
          ) : null}
          {projection?.promoted && !projection.dismissed ? (
            <span className="badge feedback-state-badge promoted">Promoted</span>
          ) : null}
          {projection?.dismissed ? (
            <span className="badge feedback-state-badge dismissed">Dismissed</span>
          ) : null}
        </div>
      </header>

      <section className="card-summary" aria-label="中文摘要">
        <h3>中文摘要</h3>
        {recommendation.summary ? (
          <>
            <p>{recommendation.summary.mainFinding || "主要发现暂缺。"}</p>
            {recommendation.summary.relevanceToUser ? (
              <p className="summary-relevance">
                <strong>与你的研究相关：</strong> {recommendation.summary.relevanceToUser}
              </p>
            ) : null}
          </>
        ) : (
          <p className="field-fallback">当前记录未提供中文摘要。</p>
        )}
      </section>

      <section className="reasons" aria-label="推荐理由">
        <h3>为什么推荐</h3>
        <p>{recommendation.reasons[0] || "当前记录未提供可追溯的推荐理由。"}</p>
      </section>

      <StructuredTags recommendation={recommendation} />

      <div className="card-primary-actions">
        {originalUrl ? (
          <a
            className="paper-link"
            href={originalUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`查看原文：${title}（在新窗口打开）`}
          >
            查看原文
          </a>
        ) : (
          <span className="field-fallback">原文链接暂不可用</span>
        )}
        <FeedbackActions
          candidateId={recommendation.candidateId}
          feedback={feedback}
          pending={pending}
          statusId={statusId}
          onFeedback={onFeedback}
        />
      </div>

      <FeedbackStatus id={statusId} feedback={feedback} />

      <details className="paper-details">
        <summary>展开论文详情</summary>
        <div className="paper-details-content">
          <section aria-labelledby={`${titleId}-abstract`}>
            <h3 id={`${titleId}-abstract`}>Abstract</h3>
            <p>{recommendation.abstract?.trim() || "当前来源未提供原始摘要。"}</p>
          </section>

          <SummaryDetails recommendation={recommendation} titleId={titleId} />
          <RecommendationEvidence recommendation={recommendation} titleId={titleId} />
          <SourceIdentifiers recommendation={recommendation} titleId={titleId} />
          <JournalMetrics recommendation={recommendation} titleId={titleId} />

          {limitations.length > 0 ? (
            <section className="source-limitations" aria-labelledby={`${titleId}-limitations`}>
              <h3 id={`${titleId}-limitations`}>来源限制</h3>
              <ul>
                {limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby={`${titleId}-feedback-detail`}>
            <h3 id={`${titleId}-feedback-detail`}>反馈状态</h3>
            <p>{feedbackDetailText(feedback)}</p>
          </section>

          {detailsActions ? <div className="paper-details-actions">{detailsActions}</div> : null}
        </div>
      </details>
    </article>
  );
}

function FeedbackActions({
  candidateId,
  feedback,
  pending,
  statusId,
  onFeedback
}: {
  candidateId: string;
  feedback?: CandidateFeedbackState;
  pending: boolean;
  statusId: string;
  onFeedback: RecommendationCardProps["onFeedback"];
}) {
  const isActive = (action: TriageAction) => {
    if (action === "save") return Boolean(feedback?.current.saved);
    if (action === "promote") return Boolean(feedback?.current.promoted);
    return Boolean(feedback?.current.dismissed);
  };

  return (
    <div className="actions" aria-label="论文反馈操作" aria-describedby={statusId}>
      {(["save", "dismiss", "promote"] as const).map((action) => (
        <button
          key={action}
          type="button"
          className={`feedback-action feedback-${action}${isActive(action) ? " is-active" : ""}`}
          disabled={pending}
          aria-pressed={isActive(action)}
          onClick={() => void onFeedback(candidateId, action)}
        >
          {pending && feedback?.pendingAction === action ? "处理中…" : ACTION_LABELS[action]}
        </button>
      ))}
    </div>
  );
}

function FeedbackStatus({ id, feedback }: { id: string; feedback?: CandidateFeedbackState }) {
  if (!feedback || (feedback.status === "idle" && !hasFeedback(feedback.current))) {
    return <p id={id} className="triage-state">尚未反馈</p>;
  }

  if (feedback.status === "failure") {
    return (
      <p id={id} className="triage-state error" role="alert">
        操作未保存，已恢复先前状态。{feedback.error ? ` ${feedback.error}` : ""}
      </p>
    );
  }

  const action = feedback.pendingAction;
  const labels = feedbackLabels(feedback.current);
  const message = feedback.status === "pending"
    ? action === "dismiss" ? "已暂时移除，可在提示消失前撤销。" : `正在保存：${ACTION_LABELS[action ?? "save"]}…`
    : feedback.status === "success" ? `已保存：${labels}` : `当前反馈：${labels}`;

  return <p id={id} className={`triage-state status-${feedback.status}`} role="status">{message}</p>;
}

function StructuredTags({ recommendation }: { recommendation: DailyRecommendationRecord }) {
  const contentLabel = recommendation.labels.contentRecall?.label?.trim();
  const researchType = recommendation.labels.researchType;
  const researchTypeText = [
    researchType?.category,
    researchType?.primaryKeyword,
    researchType?.secondaryKeyword
  ].filter(Boolean).join(" · ");

  if (!contentLabel && !researchTypeText) {
    return <p className="field-fallback tags-fallback">结构化标签暂缺</p>;
  }

  return (
    <section className="labels-row" aria-label="结构化标签">
      {contentLabel ? <span className="badge label">内容 · {contentLabel}</span> : null}
      {researchTypeText ? <span className="badge label">类型 · {researchTypeText}</span> : null}
    </section>
  );
}

function SummaryDetails({
  recommendation,
  titleId
}: {
  recommendation: DailyRecommendationRecord;
  titleId: string;
}) {
  const summary = recommendation.summary;
  return (
    <section aria-labelledby={`${titleId}-summary-detail`}>
      <h3 id={`${titleId}-summary-detail`}>中文摘要详情</h3>
      {summary ? (
        <dl className="summary-grid">
          <div><dt>研究问题</dt><dd>{summary.researchQuestion || "未提供"}</dd></div>
          <div><dt>方法</dt><dd>{summary.method || "未提供"}</dd></div>
          <div><dt>主要发现</dt><dd>{summary.mainFinding || "未提供"}</dd></div>
          <div><dt>与你的研究相关</dt><dd>{summary.relevanceToUser || "未提供"}</dd></div>
          <div><dt>摘要来源</dt><dd>{summary.provider} · {provenanceLabel(summary.provenance)}</dd></div>
        </dl>
      ) : <p>当前记录未提供中文摘要。</p>}
    </section>
  );
}

function RecommendationEvidence({
  recommendation,
  titleId
}: {
  recommendation: DailyRecommendationRecord;
  titleId: string;
}) {
  return (
    <section aria-labelledby={`${titleId}-evidence`}>
      <h3 id={`${titleId}-evidence`}>推荐依据</h3>
      {recommendation.reasons.length > 0 ? (
        <ol>{recommendation.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ol>
      ) : <p>当前记录未提供可追溯的推荐理由。</p>}
      <dl className="evidence-labels">
        {recommendation.labels.contentRecall ? (
          <div>
            <dt>内容召回标签</dt>
            <dd>
              {recommendation.labels.contentRecall.label} · {recommendation.labels.contentRecall.provider} ·{" "}
              {provenanceLabel(recommendation.labels.contentRecall.provenance)}
            </dd>
          </div>
        ) : null}
        {recommendation.labels.researchType ? (
          <div>
            <dt>研究类型标签</dt>
            <dd>
              {recommendation.labels.researchType.rawText || "结构字段见上方标签"} ·{" "}
              {recommendation.labels.researchType.provider} ·{" "}
              {provenanceLabel(recommendation.labels.researchType.provenance)}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function SourceIdentifiers({
  recommendation,
  titleId
}: {
  recommendation: DailyRecommendationRecord;
  titleId: string;
}) {
  const sourceIdentifiers = recommendation.sourceIdentifiers ?? [];
  const identifiers = [
    recommendation.identifiers.doi ? ["DOI", recommendation.identifiers.doi, doiUrl(recommendation.identifiers.doi)] : null,
    recommendation.identifiers.pmid ? ["PubMed", recommendation.identifiers.pmid, pubmedUrl(recommendation.identifiers.pmid)] : null,
    recommendation.identifiers.arxivId ? ["arXiv", recommendation.identifiers.arxivId, arxivUrl(recommendation.identifiers.arxivId)] : null,
    recommendation.identifiers.bioRxivId ? ["bioRxiv", recommendation.identifiers.bioRxivId, bioRxivUrl(recommendation.identifiers.bioRxivId)] : null
  ].filter((entry): entry is [string, string, string] => Boolean(entry));

  return (
    <section aria-labelledby={`${titleId}-identifiers`}>
      <h3 id={`${titleId}-identifiers`}>来源标识</h3>
      {identifiers.length > 0 ? (
        <ul className="identifier-row">
          {identifiers.map(([label, value, url]) => (
            <li key={`${label}-${value}`}><a href={url} target="_blank" rel="noreferrer">{label}: {value}</a></li>
          ))}
        </ul>
      ) : <p>没有可链接的 DOI、PubMed、arXiv 或 bioRxiv 标识。</p>}
      {sourceIdentifiers.length > 0 ? (
        <dl className="source-identifiers">
          {sourceIdentifiers.map((identifier) => (
            <div key={`${identifier.source}-${identifier.externalId}`}>
              <dt>{SOURCE_LABELS[identifier.source]}</dt><dd>{identifier.externalId}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function JournalMetrics({
  recommendation,
  titleId
}: {
  recommendation: DailyRecommendationRecord;
  titleId: string;
}) {
  const journal = recommendation.journal;
  return (
    <section aria-labelledby={`${titleId}-journal`}>
      <h3 id={`${titleId}-journal`}>期刊信息</h3>
      {journal && (journal.name || journal.quartile || journal.impactScore !== undefined) ? (
        <dl className="journal-metrics">
          {journal.name ? <div><dt>期刊</dt><dd>{journal.name}</dd></div> : null}
          {journal.quartile ? <div><dt>分区</dt><dd>{journal.quartile}</dd></div> : null}
          {journal.impactScore !== undefined ? <div><dt>影响力指标</dt><dd>{journal.impactScore}</dd></div> : null}
        </dl>
      ) : <p>当前记录未提供期刊指标。</p>}
    </section>
  );
}

export function getPrimaryPaperUrl(recommendation: DailyRecommendationRecord): string | undefined {
  const directUrl = safeHttpUrl(recommendation.url);
  if (directUrl) return directUrl;
  if (recommendation.identifiers.doi) return doiUrl(recommendation.identifiers.doi);
  if (recommendation.identifiers.pmid) return pubmedUrl(recommendation.identifiers.pmid);
  if (recommendation.identifiers.arxivId) return arxivUrl(recommendation.identifiers.arxivId);
  if (recommendation.identifiers.bioRxivId) return bioRxivUrl(recommendation.identifiers.bioRxivId);
  return undefined;
}

function getSourceLimitations(recommendation: DailyRecommendationRecord, originalUrl?: string): string[] {
  const limitations: string[] = [];
  if (!recommendation.abstract?.trim()) limitations.push("当前 feed 未提供原始摘要。");
  if (!recommendation.summary) limitations.push("当前 feed 未提供中文摘要。");
  if (recommendation.reasons.length === 0) limitations.push("当前 feed 未提供推荐理由。");
  if (!originalUrl) limitations.push("当前 feed 未提供可用的原文链接或标准标识。");
  if ((recommendation.sourceIdentifiers ?? []).length === 0) limitations.push("当前 feed 未提供来源侧标识。");
  return limitations;
}

function feedbackDetailText(feedback?: CandidateFeedbackState): string {
  if (!feedback || !hasFeedback(feedback.current)) {
    return feedback?.status === "failure" ? "操作失败，当前没有反馈状态。" : "尚未反馈。";
  }
  const persisted = projectionsEqual(feedback.persisted, feedback.current) ? "已写入" : "尚未写入";
  return `${feedbackLabels(feedback.current)} · ${persisted}`;
}

function feedbackLabels(projection: CandidateFeedbackState["current"]): string {
  if (projection.dismissed) return ACTION_LABELS.dismiss;
  const labels = [
    projection.saved ? ACTION_LABELS.save : undefined,
    projection.promoted ? ACTION_LABELS.promote : undefined
  ].filter((value): value is string => Boolean(value));
  return labels.join(" + ") || "尚未反馈";
}

function hasFeedback(projection: CandidateFeedbackState["current"]): boolean {
  return projection.saved || projection.promoted || projection.dismissed;
}

function projectionsEqual(
  left: CandidateFeedbackState["current"],
  right: CandidateFeedbackState["current"]
): boolean {
  return left.saved === right.saved &&
    left.promoted === right.promoted &&
    left.dismissed === right.dismissed;
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : "未提供";
}

function formatPublicationDate(value?: string): string {
  if (!value) return "发表日期未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? `发表日期 ${value}`
    : `发表日期 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date)}`;
}

function provenanceLabel(value: "generated" | "user_corrected"): string {
  return value === "user_corrected" ? "用户修订" : "自动生成";
}

function safeHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function doiUrl(value: string): string {
  return `https://doi.org/${encodeURIComponent(value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""))}`;
}

function pubmedUrl(value: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(value)}/`;
}

function arxivUrl(value: string): string {
  return `https://arxiv.org/abs/${encodeURIComponent(value)}`;
}

function bioRxivUrl(value: string): string {
  return value.startsWith("10.")
    ? doiUrl(value)
    : `https://www.biorxiv.org/content/${encodeURIComponent(value)}`;
}

function toDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
