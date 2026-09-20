import {
  correctionPayload,
  correctionConfirmed,
  draftAfterWrite,
} from "./contracts.js";
const main = document.querySelector("#main");
const state = {
  data: {},
  errors: {},
  busy: false,
  writes: new Set(),
  drafts: new Map(),
  revision: 0,
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ],
  );
const time = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
const num = (value) =>
  typeof value === "number" ? Number(value.toFixed(4)).toString() : "未知";
const messages = {
  BACKEND_CONNECTION_NOT_CONFIGURED:
    "云端连接尚未配置。需要在 Site 服务器设置 Access 凭据。",
  BACKEND_ACCESS_DENIED:
    "云端 API 拒绝了 Site 身份。请完成 Worker 的 Site API 授权配置。",
  SITE_OWNER_REQUIRED: "当前账户没有此站点的数据权限。",
  CHATGPT_SIGN_IN_REQUIRED: "登录已失效，请重新通过 ChatGPT 登录。",
  BACKEND_HTTP_404: "生产 Worker 尚未提供此 API contract。",
  BACKEND_UNAVAILABLE: "云端请求未完成，请稍后刷新。",
  WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY:
    "写入结果未知。请先检查反馈历史，避免重复提交。",
};
async function api(name, options = {}) {
  const response = await fetch(
    name.startsWith("/") ? name : `/api/bridge/${name}`,
    { cache: "no-store", ...options },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("服务器未返回有效 JSON。");
  }
  if (!response.ok || body.status === "error" || body.status === "unavailable")
    throw new Error(
      messages[body.code] ?? `请求失败：${body.code ?? response.status}`,
    );
  return body;
}
const currentRun = () => new URL(location.href).searchParams.get("runId");
const query = (id) => (id ? `?runId=${encodeURIComponent(id)}` : "");
const feed = () => state.data.feed?.feed;
const runs = () => state.data.operations?.runs ?? [];
const snapshot = () => state.data.profile?.snapshot;
function triage() {
  const result = new Map();
  for (const log of [...(state.data.logs?.logs ?? [])].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )) {
    if (
      log.runId === feed()?.runId &&
      ["save", "dismiss", "promote"].includes(log.actionType) &&
      !result.has(log.candidateId)
    )
      result.set(log.candidateId, log.actionType);
  }
  return result;
}
function badge(status) {
  const cls = [
    "success",
    "complete",
    "ready",
    "active",
    "save",
    "promote",
  ].includes(status)
    ? "success"
    : ["failed", "failure", "dismiss"].includes(status)
      ? "error"
      : ["partial", "complete_with_warnings", "running", "pending"].includes(
            status,
          )
        ? "warning"
        : "";
  return `<span class="badge ${cls}">${esc(status ?? "未知")}</span>`;
}
function heading(title, subtitle = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${currentRun() ? '<a href="/papers">返回最新推荐</a>' : ""}</div>`;
}
function error(name) {
  return state.errors[name]
    ? `<p class="message error-message" role="alert">${esc(state.errors[name])}</p>`
    : "";
}
function evidence(value, title = "原始证据") {
  return `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(value ?? null, null, 2))}</pre></details>`;
}
function actions(paper) {
  const active = triage().get(paper.candidateId);
  const blocked =
    !state.data.capabilities ||
    !state.data.logs ||
    state.writes.has(paper.candidateId);
  return `<div class="actions">${["save", "dismiss", "promote"].map((action) => `<button data-action="${action}" data-id="${esc(paper.candidateId)}" ${blocked ? "disabled" : ""} class="${active === action ? "active" : ""}" aria-pressed="${active === action}">${{ save: "Save · 保存", dismiss: "Dismiss · 忽略", promote: "Promote · 关注" }[action]}</button>`).join("")}${active ? badge(active) : ""}</div>`;
}
function card(paper) {
  return `<article class="paper"><div class="rank">${String(paper.rank).padStart(2, "0")}</div><div><h3><a href="/paper?runId=${encodeURIComponent(feed().runId)}&id=${encodeURIComponent(paper.candidateId)}">${esc(paper.title || "无标题")}</a></h3><div class="meta">${esc((paper.sources ?? []).join(" / "))} · ${paper.publishedAt ? esc(paper.publishedAt.slice(0, 10)) : "发表日期未知"} · score ${num(paper.finalScore)}</div><div class="tags">${[
    paper.labels?.contentRecall?.label,
    paper.labels?.researchType?.category,
    paper.labels?.researchType?.primaryKeyword,
  ]
    .filter(Boolean)
    .map((x) => `<span class="badge">${esc(x)}</span>`)
    .join(
      "",
    )}</div><p>${esc(paper.summary?.mainFinding || paper.abstractNote?.slice(0, 230) || "摘要尚未提供")}</p><p class="reason">${esc(paper.summary?.relevanceToUser || paper.reasons?.join(" · ") || "推荐理由尚未提供")}</p>${actions(paper)}</div></article>`;
}
function paperList(limit = 20) {
  if (state.errors.feed) return error("feed");
  if (!feed()) return '<p class="empty">尚无已完成的推荐。</p>';
  const papers = (feed().recommendations ?? [])
    .filter((p) => triage().get(p.candidateId) !== "dismiss")
    .slice(0, limit);
  return `${error("logs")}${error("capabilities")}${!state.data.logs ? '<p class="warning-line">反馈状态尚未确认，操作暂不可用。</p>' : ""}${papers.length ? papers.map(card).join("") : '<p class="empty">当前推荐均已忽略。可以在历史与反馈中查看。</p>'}`;
}
function sources(run) {
  return ["arxiv", "pubmed", "biorxiv", "journal"]
    .map((source) => {
      const health = run?.sourceDegradation?.sources?.find(
        (x) => x.source === source,
      );
      return `<div class="source-row"><span>${source}</span>${badge(health?.status)}</div>${health?.error ? `<p class="warning-line">${esc(health.error)}</p>` : ""}`;
    })
    .join("");
}
function dashboard() {
  const run = runs()[0];
  return (
    heading(
      "今天，读什么？",
      `最新已持久化推荐 · ${feed() ? time(feed().generatedAt) : "等待云端数据"}`,
    ) +
    `<div class="grid"><section class="panel"><div><div class="meta">推荐 / 目标 20</div><div class="metric">${feed() ? feed().recommendations.length : "—"}</div></div></section><section class="panel"><div><div class="meta">最近业务日期 · UTC</div><div class="metric">${esc(run?.runDate ?? "未知")}</div></div></section><section class="panel"><div><div class="meta">最近 daily run</div><div class="metric">${badge(run?.status)}</div></div></section></div><div class="split"><section class="panel lead-paper"><div class="section-heading"><h2>推荐阅读</h2><a href="/papers">查看全部 →</a></div>${paperList(3)}</section><div><section class="panel"><div class="section-heading"><h2>来源状态</h2><a href="/operations">详情</a></div>${error("operations")}${sources(run)}</section><section class="panel"><h2>当前研究画像</h2>${error("profile")}<p>${snapshot() ? `${snapshot().itemsCount} 篇文献 · ${badge(snapshot().status)}` : "尚未读取到 active snapshot"}</p><p class="meta">更新于 ${time(snapshot()?.builtAt)}</p><a href="/profile">查看兴趣与负反馈 →</a></section></div></div>`
  );
}
function papers() {
  return (
    heading(
      currentRun() ? "历史推荐" : "今日论文",
      `Top 20 · ${feed() ? `生成于 ${time(feed().generatedAt)}；保留云端排序，已忽略条目隐藏。` : "等待推荐数据"}`,
    ) + `<section class="panel">${paperList()}</section>`
  );
}
function detail() {
  const id = new URL(location.href).searchParams.get("id");
  const paper = feed()?.recommendations?.find((p) => p.candidateId === id);
  if (!paper)
    return (
      heading("论文详情") +
      error("feed") +
      '<p class="empty">当前推荐中未找到这篇论文。</p>'
    );
  const recall = state.data.recall?.result,
    rerank = state.data.rerank?.result;
  const rec = recall?.results?.find((x) => x.candidateId === id),
    rank = rerank?.results?.find((x) => x.candidateId === id);
  const matchingRerank = rerank?.run?.id === feed().rerankRunId;
  const matchingRecall =
    matchingRerank && rerank?.run?.recallRunId === recall?.run?.id;
  return (
    heading(
      "论文详情",
      `${esc(paper.sources.join(" / "))} · 排名 ${paper.rank}`,
    ) +
    `<section class="panel"><h1>${esc(paper.title)}</h1>${actions(paper)}${error("capabilities")}<h2 class="spaced">原始摘要</h2><p class="abstract">${esc(paper.abstractNote ?? "当前云端 feed 尚未提供原始摘要。")}</p><h2 class="spaced">中文摘要</h2>${["researchQuestion", "method", "mainFinding", "relevanceToUser"].map((key) => `<h3>${{ researchQuestion: "研究问题", method: "方法", mainFinding: "主要发现", relevanceToUser: "与你的关联" }[key]}</h3><p>${esc(paper.summary?.[key] ?? "尚未提供")}</p>`).join("")}<p class="meta">摘要来源：${esc(paper.summary?.provider ?? "未知")} / ${esc(paper.summary?.provenance ?? "未知")}</p></section><section class="panel"><h2>Recall / Rerank 解释</h2><p class="meta">展示云端保存的评分，不在 Site 重算。semanticScore 在当前 master 中表示词元重叠。</p><p>${esc(paper.reasons?.join(" · "))}</p>${error("recall")}${error("rerank")}${!matchingRerank ? '<p class="warning-line">最新评分运行与当前 feed 不一致，暂不展示其分数。</p>' : ""}${matchingRecall ? scoreTable("Recall", rec?.scores) : '<p class="meta">没有与当前 rerank 对应的 Recall 证据。</p>'}${matchingRerank ? scoreTable("Rerank", rank?.scores) : ""}${matchingRerank ? evidence(rerank.run, "排名使用的 snapshot 与运行信息") : ""}</section>${editForm(paper)}`
  );
}
function scoreTable(title, scores) {
  if (!scores) return `<p>${title} 证据未返回</p>`;
  return `<h3>${title}</h3><div class="table-wrap"><table><thead><tr><th>特征</th><th>保存的值</th></tr></thead><tbody>${Object.entries(
    scores,
  )
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${num(v)}</td></tr>`)
    .join(
      "",
    )}</tbody></table></div>${evidence(scores, `${title} 完整证据与权重`)}`;
}
function editForm(paper) {
  const draft = state.drafts.get(paper.candidateId);
  if (draft)
    paper = {
      ...paper,
      labels: {
        contentRecall: { label: draft.contentRecallLabel },
        researchType: {
          category: draft.category,
          primaryKeyword: draft.primaryKeyword,
          secondaryKeyword: draft.secondaryKeyword,
        },
      },
      summary: draft,
    };
  return `<section class="panel"><h2>更正标签与摘要</h2><p class="meta">保存后使用现有内容接口，并记录反馈日志。</p><form id="correction" data-id="${esc(paper.candidateId)}"><div class="field-grid"><div><label for="label">内容标签</label><input id="label" name="contentRecallLabel" maxlength="500" value="${esc(paper.labels?.contentRecall?.label)}"></div><div><label for="category">研究类型</label><select id="category" name="category">${["", "method", "biology", "resource", "benchmark"].map((v) => `<option value="${v}" ${paper.labels?.researchType?.category === v ? "selected" : ""}>${v || "未设置"}</option>`).join("")}</select></div><div><label for="primary">主要关键词</label><input id="primary" name="primaryKeyword" maxlength="500" value="${esc(paper.labels?.researchType?.primaryKeyword)}"></div><div><label for="secondary">次要关键词</label><input id="secondary" name="secondaryKeyword" maxlength="500" value="${esc(paper.labels?.researchType?.secondaryKeyword)}"></div></div>${["researchQuestion", "method", "mainFinding", "relevanceToUser"].map((key) => `<label for="${key}">${{ researchQuestion: "研究问题", method: "方法", mainFinding: "主要发现", relevanceToUser: "与你的关联" }[key]}</label><textarea id="${key}" name="${key}" maxlength="10000">${esc(paper.summary?.[key])}</textarea>`).join("")}<div class="actions"><button class="primary" type="submit" ${!state.data.capabilities || state.writes.has(paper.candidateId) ? "disabled" : ""}>保存更正</button></div></form></section>`;
}
function profile() {
  const s = snapshot(),
    refresh = state.data.refresh,
    learn = s?.feedbackIntegration;
  return (
    heading("研究画像", "当前 active snapshot 与已持久化的反馈学习证据") +
    error("profile") +
    `<section class="panel"><h2>Active snapshot</h2>${s ? `<p>${badge(s.status)} · ${s.itemsCount} 篇文献</p><p class="meta">${esc(s.id)} · 更新 ${time(s.builtAt)}</p><h3 class="spaced">正向兴趣</h3><div class="tags">${(s.positiveLabels ?? []).map((x) => `<span class="badge">${esc(x)}</span>`).join("") || '<span class="meta">云端尚未返回兴趣标签。</span>'}</div><div class="table-wrap"><table><thead><tr><th>研究类型</th><th>保存的权重</th><th>文献数</th></tr></thead><tbody>${s.researchTypePreferences.map((p) => `<tr><td>${esc(p.category)}</td><td>${num(p.weight)}</td><td>${p.itemCount}</td></tr>`).join("")}</tbody></table></div>${evidence(s.segments, "近期 / 长期 / 背景分层")}` : '<p class="empty">尚未返回画像。</p>'}</section><section class="panel"><h2>Dismiss-derived negative feedback</h2><p class="meta">Save / Promote 可覆盖同一论文的 Dismiss 状态；当前 master 不将 Save / Promote 直接转换为正向排名权重。</p>${learn ? `<p>本次刷新消费日志：<strong>${num(learn.logsConsumed)}</strong> · 已存负向信号：<strong>${num(learn.negativeFeedback?.signalCount)}</strong></p><p class="meta">${esc(learn.negativeFeedback?.modelVersion ?? "模型版本未知")} · max penalty ${num(learn.negativeFeedback?.maxPenalty)}</p>${(learn.negativeFeedback?.signals ?? []).map((signal) => `<div class="message"><strong>${esc(signal.contentRecallLabel ?? signal.researchCategory ?? "负向信号")}</strong><p>${esc(signal.representationText)}</p><p class="meta">${time(signal.effectiveAt)} · feedback ${esc(signal.sourceFeedbackLogId)}</p></div>`).join("")}${evidence(learn, "持久化消费证据")}` : '<p class="empty">此 API 未提供消费证据，不能据更新时间推断反馈已被消费。</p>'}</section><section class="panel"><h2>Profile refresh</h2>${error("refresh")}${refresh?.latestJob ? `<p>${badge(refresh.latestJob.status)} · ${esc(refresh.latestJob.trigger)}</p><p>开始 ${time(refresh.latestJob.startedAt)} · 完成 ${time(refresh.latestJob.finishedAt)}</p>${refresh.latestJob.errorMessage ? `<p class="error-message message">${esc(refresh.latestJob.errorMessage)}</p>` : ""}` : "<p>没有可用的刷新任务状态。</p>"}<p class="meta">刷新由 GitHub Actions 执行，Site 仅查看状态。</p></section>`
  );
}
function operations() {
  const build = state.data.capabilities?.worker;
  return (
    heading("运行状态", "持久化 pipeline 状态与 GitHub 工作流分别展示") +
    error("operations") +
    `<section class="panel"><h2>Worker 部署</h2>${error("capabilities")}<p>SHA <code>${esc(build?.sha ?? "未知：生产部署尚未提供版本标记")}</code></p><p class="meta">构建时间 ${time(build?.builtAt)}</p><p>Site API ${badge(state.data.capabilities?.status)}</p></section>${
      runs()
        .map(
          (run) =>
            `<section class="panel"><div class="section-heading"><h2>${esc(run.runDate)} <span class="meta">UTC · attempt ${run.attempt}</span></h2>${badge(run.status)}</div><p class="meta">${esc(run.runId)} · 开始 ${time(run.startedAt)} · 完成 ${time(run.finishedAt)}</p>${run.errorSummary ? `<p class="message error-message">${esc(run.errorSummary)}</p>` : ""}<div class="stages">${[
              "ingestion",
              "enrichment",
              "normalization",
              "representation",
              "recall",
              "rerank",
              "summary",
            ]
              .map((name) => {
                const stage = run.stages.find((s) => s.stage === name);
                return `<div class="stage">${name}<small>${esc(stage?.status ?? "未知")}</small>${stage?.error ? `<small class="warning-line">${esc(stage.error)}</small>` : ""}</div>`;
              })
              .join(
                "",
              )}</div>${sources(run)}${evidence(run.stages, "阶段时间与证据")}<a href="/papers?runId=${encodeURIComponent(run.runId)}">查看此次推荐 →</a></section>`,
        )
        .join("") || '<p class="empty">没有可用运行。</p>'
    }<section class="panel"><h2>GitHub daily runs</h2><p class="meta">工作流 SHA 与 Worker 部署 SHA 不同；以下记录未与数据库 run 自动匹配。</p>${error("github")}<div class="table-wrap"><table><thead><tr><th>时间</th><th>结果</th><th>SHA</th></tr></thead><tbody>${(state.data.github?.runs ?? []).map((run) => `<tr><td><a href="${esc(run.url)}" target="_blank" rel="noopener noreferrer">${time(run.createdAt)}</a></td><td>${badge(run.conclusion ?? run.status)}</td><td><code>${esc(run.sha)}</code></td></tr>`).join("")}</tbody></table></div></section>`
  );
}
function historyPage() {
  const logs = state.data.logs?.logs ?? [];
  return (
    heading(
      "历史与反馈",
      "最近 10 次运行；所选运行最多 500 条反馈。消费状态以 Profile 中的持久化证据为准。",
    ) +
    error("operations") +
    `<section class="panel"><h2>推荐历史</h2>${
      runs()
        .map(
          (run) =>
            `<div class="source-row"><a href="/history?runId=${encodeURIComponent(run.runId)}">${esc(run.runDate)} · ${esc(run.runId)}</a>${badge(run.status)}<a href="/papers?runId=${encodeURIComponent(run.runId)}">论文</a></div>`,
        )
        .join("") || "<p>暂无历史记录。</p>"
    }</section><section class="panel"><h2>反馈日志</h2><p class="meta">run ${esc(feed()?.runId ?? currentRun() ?? "未知")}</p>${error("logs")}<div class="table-wrap"><table><thead><tr><th>操作</th><th>论文</th><th>时间</th><th>日志 ID</th></tr></thead><tbody>${logs.map((log) => `<tr><td>${badge(log.actionType)}</td><td><a href="/paper?runId=${encodeURIComponent(log.runId)}&id=${encodeURIComponent(log.candidateId)}">${esc(feed()?.recommendations?.find((p) => p.candidateId === log.candidateId)?.title ?? log.candidateId)}</a></td><td>${time(log.createdAt)}</td><td><code>${esc(log.id)}</code></td></tr>`).join("")}</tbody></table></div>${!logs.length ? '<p class="empty">尚无可用反馈日志。</p>' : ""}${logs.length >= 500 ? '<p class="warning-line">已达到接口返回上限，记录可能不完整。</p>' : ""}<a href="/profile">检查 Profile 中的消费证据 →</a></section>`
  );
}
function render() {
  const path = location.pathname;
  const names = {
    "/": "概览",
    "/papers": "今日论文",
    "/paper": "论文详情",
    "/profile": "研究画像",
    "/operations": "运行状态",
    "/history": "历史与反馈",
  };
  document.querySelector("#breadcrumb").textContent = names[path] ?? "概览";
  document.title = `${names[path] ?? "概览"} · Daily Paper`;
  document
    .querySelectorAll("nav a")
    .forEach((a) =>
      a.setAttribute(
        "aria-current",
        a.dataset.route === (path === "/paper" ? "/papers" : path)
          ? "page"
          : "false",
      ),
    );
  main.innerHTML =
    (state.busy ? '<p class="meta" role="status">正在读取云端数据…</p>' : "") +
    (
      {
        "/": dashboard,
        "/papers": papers,
        "/paper": detail,
        "/profile": profile,
        "/operations": operations,
        "/history": historyPage,
      }[path] ?? dashboard
    )();
  document.querySelector("#reload").disabled = state.busy;
}
async function load() {
  const revision = ++state.revision;
  state.busy = true;
  state.errors = {};
  state.data = {};
  render();
  const get = async (key, route) => {
    try {
      const data = await api(route);
      if (revision === state.revision) state.data[key] = data;
    } catch (e) {
      if (revision === state.revision) state.errors[key] = e.message;
    }
  };
  await Promise.all([
    get("feed", "feed" + query(currentRun())),
    get("profile", "profile"),
    get("refresh", "refresh"),
    get("operations", "operations"),
    get("capabilities", "capabilities"),
    get("github", "/api/github-runs"),
  ]);
  if (revision !== state.revision) return;
  const runId = feed()?.runId ?? currentRun();
  if (runId)
    await Promise.all([
      get("logs", "logs" + query(runId)),
      ...(location.pathname === "/paper"
        ? [
            get("recall", "recall" + query(runId)),
            get("rerank", "rerank" + query(runId)),
          ]
        : []),
    ]);
  if (revision === state.revision) {
    state.busy = false;
    render();
  }
}
function notice(text) {
  document.querySelector("#notice").textContent = text;
}
document.addEventListener("click", async (event) => {
  const action = event.target.closest("button[data-action]");
  if (action) {
    if (action.disabled || state.writes.has(action.dataset.id)) return;
    const id = action.dataset.id;
    state.writes.add(id);
    render();
    try {
      const result = await api("feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: feed().runId,
          candidateId: id,
          action: action.dataset.action,
        }),
      });
      if (!result.log?.id)
        throw new Error("反馈响应缺少日志 ID，请检查历史确认结果。");
      notice("反馈已保存，正在重新读取云端日志。");
      await load();
      if (!state.data.logs?.logs?.some((log) => log.id === result.log.id))
        notice("写入已响应，但日志回读尚未确认。请检查历史，避免重复提交。");
      else notice("反馈已保存，云端日志回读已确认。");
    } catch (e) {
      notice(e.message);
    } finally {
      state.writes.delete(id);
      render();
    }
    return;
  }
  const link = event.target.closest("a[href]");
  if (
    link &&
    link.origin === location.origin &&
    link.pathname !== "/signin-with-chatgpt" &&
    !link.hash &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  ) {
    event.preventDefault();
    history.pushState(null, "", link.href);
    notice("");
    await load();
    main.focus();
    window.scrollTo(0, 0);
  }
});
document.addEventListener("input", (event) => {
  const form = event.target.closest("#correction");
  if (form)
    state.drafts.set(form.dataset.id, Object.fromEntries(new FormData(form)));
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "correction") return;
  event.preventDefault();
  const form = event.target,
    id = form.dataset.id;
  if (state.writes.has(id)) return;
  const data = Object.fromEntries(new FormData(form));
  state.drafts.set(id, data);
  const old = feed().recommendations.find((p) => p.candidateId === id);
  const body = correctionPayload(old, data);
  if (!body.labels && !body.summary) {
    notice("内容没有变化。");
    return;
  }
  state.writes.add(id);
  render();
  try {
    const result = await api("content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!result.output) throw new Error("更正结果未确认，请检查历史。");
    await load();
    if (
      correctionConfirmed(
        feed()?.recommendations?.find((paper) => paper.candidateId === id),
        body,
      )
    ) {
      if (draftAfterWrite(state.drafts.get(id), data, true) === undefined) {
        state.drafts.delete(id);
        notice("更正已保存，内容回读已确认。");
      } else notice("提交内容已确认；保存期间的新编辑仍保留在草稿中。");
    } else
      notice("写入已响应，但更正内容回读尚未确认。草稿已保留，请检查历史。");
  } catch (e) {
    notice(e.message);
  } finally {
    state.writes.delete(id);
    render();
  }
});
document.querySelector("#reload").addEventListener("click", load);
window.addEventListener("popstate", load);
await load();
