# Site dashboard 只读接口

本接口现由 #45 正式收录，来源为远程 codex/site-read-worker-release 的 9f660d264d845d831993c4738c42ce6ff3f4928b。DTO v1 兼容现有线上 Site；查询参数现在明确拒绝为 400。仅聚合既有 repository 读取，不计算 ranking/profile、不创建任务、不直接向 Site 暴露数据库。

原线上发布候选以生产代码基线 `dd78ae8766c0c9ffb07afc6d17cbd0a804ac5974` 为起点，仅移植 `2f7a4db6d0a0b84e3830468d5d2dc3a38c155250` 的 Site 接口与认证改动。没有引入较新 master 的 ranking、profile refresh 或 ingestion 改动。下述 DTO v1 保持不变；旧数据未记录的证据仍返回 unknown / `null`。

## 请求与响应

`GET /api/site/dashboard`，无需 query 参数；始终读取数据库中最新的 aggregated daily run。不会接受外部 runId、任意查询、任务参数或刷新指令。

成功响应的实际结构如下（`?` 表示整个对象可以是 `null`，不是省略属性）：

```text
status: "ok"
schemaVersion: 1
observedAt: ISO timestamp
currentRun: Run?
recentRuns: Run[]                         最多 10 次，按数据库 startedAt 倒序
profile: Profile?                        当前 active snapshot
ranking:
  recall: RecallRun?
  rerank: RerankRun?
  profile: Profile?                      rerank 引用的 snapshot，可以已 superseded
  usesActiveProfile: boolean | null
  recommendationLink: "matched" | "unknown"
  recommendationsUnavailableReason:
    null | "no_run" | "run_not_finished_or_failed" | "ranking_evidence_unconfirmed"
recommendations: null | {
  runId, rerankRunId, profileSnapshotId, generatedAt,
  generatedAtMeaning: "rerank_started_at",
  items: Recommendation[],               已选论文按现有 rank 排序，最多 20 篇
  composition: {
    sources: { value, count }[],
    topics: { value, count }[]
  }
}
feedback:
  scope: "latest_100_global_logs"
  limit: 100
  possiblyTruncated: boolean
  latestCreatedAt: ISO timestamp | null
  logs: {
    id, runId, candidateId, actionType, createdAt,
    inActiveProfileDismissSignals: true | null,
    inRankingProfileDismissSignals: true | null
  }[]
limitations: string[]
```

`Run`：`runId/runDate/attempt/status/startedAt/finishedAt/errorSummary`，以及 `sha: null`、`githubRunId: null`、`trigger: "unknown"`；`stages[]` 含 `stage/status/startedAt/finishedAt/error`；`sources[]` 固定 arXiv、PubMed、bioRxiv、journal，含 `source/status/error/candidatesCount/fetchedCount/filteredCount/windowStart/windowEnd/filterMode/failureCategory`。缺失时间、计数和原因返回 `null`，来源状态缺失为 `unknown`。

`Profile`：`id/status/builtAt/sourceLibraryVersion/itemsCount/segments/researchTypePreferences`，其中 segments 含 `recentCore/stableLongTerm/background`，缺失计数为 `null`。`feedbackEvidence` 含：

```text
since: timestamp | null
logsConsumed: number | null
actionCounts: { save, dismiss, promote, label_edit, summary_edit }  每项 number | null
negativeFeedback:
  modelVersion: string | null
  signalCount, maxSignals, maxContributingSignals, weightPerSignal, maxPenalty: number | null
  signals: null | { sourceFeedbackLogId, sourceCandidateId, effectiveAt }[]
```

`RecallRun` / `RerankRun` 都含 `id/runId/profileSnapshotId/status/startedAt/finishedAt/requestedTopN/candidateCount/error`；recall 另有 `recalledCount`，rerank 另有 `recallRunId/recommendedCount`。

`Recommendation` 包含：

- `candidateId/rank/finalScore/title/publishedAt/sources`。
- `identifiers: { doi, pmid, arxivId, bioRxivId }`，缺失值为 `null`。
- `topic/researchType`，以及可为 `null` 的 `summary`、`journal`。summary 含现有 `researchQuestion/method/mainFinding/relevanceToUser/provider/provenance`；journal 含 `quartile/impactScore`。
- `reasons.recall[]` 和 `reasons.rerank[]` 保留已持久化的 reason codes，包括 topic alignment、oncology 和 dismiss 相关代码。单独的 `topicAlignment/oncologyPenalty/dismissPenalty` 数值未持久化，均为 `null`，不重新计算分数。
- `scores.recall`：`recallScore/semanticScore/tagOverlapScore/researchTypeScore/sourceScopeScore`。
- `scores.rerank`：`finalScore/recallScore/recentCoreScore/stableLongTermScore/highAttentionScore/contentTagScore/researchTypeScore/collectionWeightScore/sourcePriorityScore/journalQualityScore/userCorrectedScore/recencyScore`。

路由产生的响应均带 `Cache-Control: private, no-store`；middleware 提前拒绝时带 `no-store`。未认证返回 403，读取失败返回 500 与固定错误码 `SITE_DASHBOARD_READ_FAILED`；不会把失败显示成空的成功数据。非 GET 返回 405（云 middleware 可先对无权身份返回 403），显式禁止 HEAD 和 OPTIONS。

## 数据含义与复用范围

- 复用 `OperationsService.listRecentRuns`，以及现有 profile、feedback、recall、rerank、daily recommendation repository。新增 profile getter 仅做窄 `findFirst/select`，保留生产基线的 snapshot mapper 和已有 getter。Site 内部 `persisted-feedback-evidence` 仅校验已存 signal 的五个必填非空 string，按既有格式最多读取 50 条，只输出 feedback ID、candidate ID 和 effectiveAt；不导入或移植 penalty 计算。
- 使用一个 application Prisma client；Worker 路径完成读取后释放 client。没有写 SQL、事务、迁移、任务调用或外部业务请求。JWT 验证按现有机制读取 Cloudflare JWKS。
- `observedAt` 是读取完成时间；`builtAt` 是 profile 构建时间；`generatedAt` 沿用 feed 的 rerank 开始时间，并不表示摘要最后修改时间。不存在统一的业务 `updatedAt` 或数据库版本号。
- 最新数据库 run 可能是昨天，也不能确认是 scheduled 触发。SHA、GitHub run ID、触发类型没有对应可靠字段，继续由 Site 的 GitHub 只读数据源展示，不能凭日期或本地 HEAD 拼接到数据库运行。
- 推荐必须与最新 run、recall、rerank、profile ID 匹配，且 persisted recall/rerank stage 成功并记录对应 ID；候选 rank/score 也必须相符。运行状态为 complete、complete_with_warnings 或 partial 才展示推荐。运行中、失败、缺失或不一致时 recommendations 为 `null`。包括 summary-only 重试在内，运行未结束期间采取保守的 unknown 展示；完成后可复用已有成功排名。
- 旧 run 若没有持久化 `recallProfileSnapshotId`，即使其他 ID、日期和分数一致，也返回 `recommendations: null` 与 `ranking_evidence_unconfirmed`。旧 profile JSON 若没有 feedbackIntegration / negativeFeedback，相关 evidence 为 `null`。此接口不会运行任务补齐这些字段。
- 多表读取不是事务快照；`matched` 仅表示读到的关联证据一致。仓库会复用同一个 run ID，不能仅凭 ID 或 ingestion startedAt 声称新 attempt 已完成。
- 当前 profile 和排名使用的 profile 分开展示。只有 parser 接受的 signal 明确引用某 feedback ID，才标记 `true`；缺失时为 `null`，不推断该反馈从未被消费，也不按时间戳推断学习成功。
- feedback 日志仅为全局最近 100 条；`possiblyTruncated` 不代表总量或总消费率。snapshot 自带的历史 dismiss signal 引用独立展示。
- topic 构成按 content-recall 标签统计；source 构成对多来源论文分别计数，合计可超过 20。
- Top 20 是响应上限；为复用既有查询，本版 ranking/feed repository 仍可能读取该 run 的完整结果，尚未做 SQL 层 Top 20 优化。

## 认证与后续配置

沿用现有 `createRemoteJWKSet` + `jwtVerify`，固定 RS256、`TEAM_DOMAIN` issuer 和对应 audience，不直接信任调用方提交的 Client ID/Secret 头。

| 位置 | 环境变量 | 用途 |
| --- | --- | --- |
| Worker，已有 | `DEPLOYMENT_MODE=cloud` | 启用现有云端全站 Access 边界 |
| Worker，已有 | `TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`，校验 issuer/JWKS |
| Worker，已有 | `POLICY_AUD` | 原个人 Access 应用 AUD，不替换 |
| Worker，已有 | `ACCESS_ALLOWED_EMAIL` | 原唯一允许的个人身份 |
| Worker，新增可选 | `SITE_READ_POLICY_AUD` | 后续 Site 专用 Access 应用的 Application Audience (AUD) |
| Worker，新增可选 | `SITE_READ_ACCESS_CLIENT_ID` | 后续指定服务凭据的 Client ID，精确匹配签名 JWT 的 common_name |

新增两个变量必须同时存在，才启用 Site 服务身份；未配置不会影响原个人身份。没有新增必填数据库变量，继续使用原 `DATABASE_URL`。Worker 不需要保存 Site 的 Client Secret。

后续经单独授权部署时：

1. 在 Cloudflare Access 建立仅覆盖 `/api/site/dashboard` 的路径应用，保留原个人应用。为这个路径配置现有 owner 的 Allow policy，以及仅包含指定服务凭据的 Service Auth policy。不要给服务凭据配置全站 Allow，也不使用 Bypass。
2. 从该应用设置复制 Application Audience (AUD) 至 Worker 的 `SITE_READ_POLICY_AUD`；从指定 Service Token 获取 Client ID 至 `SITE_READ_ACCESS_CLIENT_ID`。这不是 Cloudflare 管理 API Token。
3. 在独立 Site 的**服务端** secret store 保存 `DAILY_PAPER_ACCESS_CLIENT_ID` 和 `DAILY_PAPER_ACCESS_CLIENT_SECRET`；`DAILY_PAPER_API_ORIGIN` 指向 Worker 的 HTTPS origin。Site 服务端适配层仅请求本 GET 接口，并向 Cloudflare 发送 `CF-Access-Client-Id` / `CF-Access-Client-Secret`。由 Access 校验凭据并给 Worker 注入签名断言。Site 的构建与发布独立于本 Worker 发布候选；Client Secret 不进入 Worker、浏览器、git 或日志。
4. 仅此 GET 额外接受 Site audience 下同一个 owner 的人类 JWT，以兼容路径应用的个人登录；该 JWT 不因此获得其他 API 权限。其他云 API 继续要求原 audience + owner email，任何带 `common_name` 的服务身份都不会成为个人管理员。
5. 后续部署与真实连通验证需要单独授权。本地测试不创建真实凭据、不调用 Cloudflare 配置 API、不触发 workflow。原本公开的 `/api/health/live` 继续公开；Local Mode 其他已有路由的行为不变，新 dashboard 即使本地也必须认证。

Cloudflare JWT 字段参考：[Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)。


## #45 的正式认证 contract

新增 SITE_API_POLICY_AUD / SITE_API_ACCESS_CLIENT_ID 用于 `src/lib/http/site-api-scope.ts` 的精确路径与方法白名单。旧 SITE_READ_POLICY_AUD / SITE_READ_ACCESS_CLIENT_ID 仅继续允许 GET /api/site/dashboard；不会继承新增读取或反馈写入权限。原 owner audience 始终独立保留。/api/health/ready 不属于任何 Site 服务授权。上述旧部署说明是来源记录，不代表 #45 已部署或可写。
