import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildPreferredTopicReference, computeTopicHeuristicScore } from "../src/modules/ranking/topic-heuristics.ts";
import { buildSourceRankingAudit } from "../src/modules/diagnostics/source-ranking/index.ts";
import { selectSourceRankingAuditAttempt } from "../src/modules/diagnostics/source-ranking/sqlite-attempt-selection.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.dbPath) {
  fail("Usage: npx tsx scripts/source-ranking-audit.mjs --db <sqlite-path> [--run-id <id>] [--top-n <n>]");
}

const databasePath = resolve(args.dbPath);
const before = databaseFingerprint(databasePath);
const database = new DatabaseSync(databasePath, { readOnly: true });

try {
  database.exec("PRAGMA query_only = ON");
  const attempt = selectSourceRankingAuditAttempt(database, args.runId);
  if (!attempt) {
    fail(args.runId
      ? "The requested run has no successful rerank linked to a successful recall."
      : "No successful aggregated run with a linked successful recall/rerank attempt was found.");
  }

  const snapshot = loadSnapshot(database, attempt);
  const report = buildSourceRankingAudit(snapshot, { topN: args.topN });
  database.close();
  const after = databaseFingerprint(databasePath);

  process.stdout.write(`${JSON.stringify({
    privacy: {
      rawTitlesEmitted: false,
      rawAbstractsEmitted: false,
      personalLabelsEmitted: false,
      candidateIdentifiers: "sha256(runId + candidateId), first 12 hex characters"
    },
    databaseVerification: {
      openedReadOnly: true,
      bytesUnchanged: before.size === after.size,
      modifiedTimeUnchanged: before.mtimeMs === after.mtimeMs,
      sha256Unchanged: before.sha256 === after.sha256
    },
    report
  }, null, 2)}\n`);
} finally {
  try {
    database.close();
  } catch {
    // It may already be closed after a successful report.
  }
}

function loadSnapshot(database, attempt) {
  const { runId, recallRunId, rerankRunId, profileSnapshotId } = attempt;

  const ingestionStage = database.prepare(`
    SELECT detailsJson
    FROM DailyPipelineStageRun
    WHERE runId = ? AND stage = 'INGESTION'
  `).get(runId);
  const fetchedCounts = extractFetchedCounts(parseJson(ingestionStage?.detailsJson));
  const acceptedCounts = sourceCountRows(database.prepare(`
    SELECT source, COUNT(*) AS count
    FROM DailyCandidate
    WHERE runId = ?
    GROUP BY source
  `).all(runId));

  const preferredTopicReference = loadPreferredTopicReference(database, profileSnapshotId);
  const canonicalRows = database.prepare(`
    SELECT
      candidate.id,
      candidate.title,
      candidate.abstractNote,
      EXISTS(
        SELECT 1 FROM DailyCandidateStructuredLabel label
        WHERE label.canonicalCandidateId = candidate.id
      ) AS represented,
      (
        SELECT label.researchCategory
        FROM DailyCandidateStructuredLabel label
        WHERE label.canonicalCandidateId = candidate.id AND label.labelType = 'RESEARCH_TYPE'
        LIMIT 1
      ) AS researchCategory
    FROM DailyCanonicalCandidate candidate
    WHERE candidate.runId = ?
    ORDER BY candidate.id
  `).all(runId);
  const provenanceRows = database.prepare(`
    SELECT
      provenance.canonicalCandidateId,
      provenance.source,
      sourceCandidate.journalName,
      enrichment.status AS enrichmentStatus,
      enrichment.quartile,
      enrichment.impactScore
    FROM DailyCanonicalCandidateProvenance provenance
    JOIN DailyCandidate sourceCandidate ON sourceCandidate.id = provenance.sourceCandidateId
    LEFT JOIN DailyCandidateJournalEnrichment enrichment ON enrichment.candidateId = sourceCandidate.id
    WHERE sourceCandidate.runId = ?
  `).all(runId);
  const recallRows = database.prepare(`
    SELECT canonicalCandidateId, rank, selected
    FROM DailyRecallResult
    WHERE recallRunId = ?
  `).all(recallRunId);
  const rerankRows = database.prepare(`
    SELECT
      canonicalCandidateId,
      rank,
      selected,
      finalScore,
      recallScore,
      recentCoreScore,
      stableLongTermScore,
      highAttentionScore,
      contentTagScore,
      researchTypeScore,
      collectionWeightScore,
      sourcePriorityScore,
      journalQualityScore,
      userCorrectedScore,
      recencyScore,
      featureWeightsJson,
      finalScore AS formulaScore
    FROM DailyRecommendationResult
    WHERE rerankRunId = ?
  `).all(rerankRunId);

  const provenances = groupBy(provenanceRows, (row) => row.canonicalCandidateId);
  const recallByCandidate = new Map(recallRows.map((row) => [row.canonicalCandidateId, row]));
  const rerankByCandidate = new Map(rerankRows.map((row) => [row.canonicalCandidateId, row]));
  const candidates = canonicalRows.map((candidate) => {
    const candidateProvenance = provenances.get(candidate.id) ?? [];
    const sources = unique(candidateProvenance.map((row) => fromDbSource(row.source)).filter(Boolean));
    const recall = recallByCandidate.get(candidate.id);
    const rerank = rerankByCandidate.get(candidate.id);
    const text = `${candidate.title ?? ""} ${candidate.abstractNote ?? ""}`;
    const topic = computeTopicHeuristicScore(text, preferredTopicReference);
    return {
      candidateId: anonymize(runId, candidate.id),
      sources,
      title: candidate.title ?? undefined,
      abstractNote: candidate.abstractNote ?? undefined,
      researchCategory: fromDbResearchCategory(candidate.researchCategory),
      represented: Boolean(candidate.represented),
      ...(recall ? { recall: { rank: recall.rank, selected: Boolean(recall.selected) } } : {}),
      ...(rerank ? {
        rerank: {
          rank: rerank.rank,
          selected: Boolean(rerank.selected),
          metricState: deriveMetricState(candidateProvenance),
          featureWeights: mapPersistedFeatureWeights(parseJson(rerank.featureWeightsJson), anonymize(runId, candidate.id)),
          formulaScore: rerank.formulaScore,
          features: {
            recallScore: rerank.recallScore,
            recentInterestScore: rerank.recentCoreScore,
            stableInterestScore: rerank.stableLongTermScore,
            starredProfileScore: rerank.highAttentionScore,
            contentTagScore: rerank.contentTagScore,
            studyTypeScore: rerank.researchTypeScore,
            journalQualityScore: rerank.journalQualityScore,
            freshnessScore: rerank.recencyScore,
            requiredTopicGate: topic.strongPositiveMatches.length > 0,
            noisePenalty: topic.penalty,
            finalScore: rerank.finalScore,
            collectionWeightScore: rerank.collectionWeightScore,
            sourcePriorityScore: rerank.sourcePriorityScore,
            userCorrectedScore: rerank.userCorrectedScore,
            topicHeuristicScore: topic.score
          }
        }
      } : {})
    };
  });

  return { runId, fetchedCounts, acceptedCounts, candidates };
}

function mapPersistedFeatureWeights(value, anonymousCandidateId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Persisted featureWeightsJson is missing for candidate ${anonymousCandidateId}.`);
  }
  return {
    recallScore: requiredWeight(value, "recallScore", anonymousCandidateId),
    recentInterestScore: requiredWeight(value, "recentCoreScore", anonymousCandidateId),
    stableInterestScore: requiredWeight(value, "stableLongTermScore", anonymousCandidateId),
    starredProfileScore: requiredWeight(value, "highAttentionScore", anonymousCandidateId),
    contentTagScore: requiredWeight(value, "contentTagScore", anonymousCandidateId),
    studyTypeScore: requiredWeight(value, "researchTypeScore", anonymousCandidateId),
    journalQualityScore: requiredWeight(value, "journalQualityScore", anonymousCandidateId),
    freshnessScore: requiredWeight(value, "recencyScore", anonymousCandidateId),
    noisePenalty: requiredWeight(value, "genericNoisePenalty", anonymousCandidateId),
    collectionWeightScore: optionalNotApplicableWeight(value, "collectionWeightScore", anonymousCandidateId),
    sourcePriorityScore: optionalNotApplicableWeight(value, "sourcePriorityScore", anonymousCandidateId),
    userCorrectedScore: requiredWeight(value, "userCorrectedScore", anonymousCandidateId),
    topicHeuristicScore: requiredWeight(value, "topicHeuristic", anonymousCandidateId)
  };
}

function requiredWeight(value, key, anonymousCandidateId) {
  const weight = value[key];
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    fail(`Persisted feature weight ${key} is missing or invalid for candidate ${anonymousCandidateId}.`);
  }
  return weight;
}

function optionalNotApplicableWeight(value, key, anonymousCandidateId) {
  if (!Object.hasOwn(value, key)) return 0;
  return requiredWeight(value, key, anonymousCandidateId);
}

function loadPreferredTopicReference(database, profileSnapshotId) {
  const rows = database.prepare(`
    SELECT representationText, contentRecallLabel
    FROM ProfileSnapshotItemSignal
    WHERE snapshotId = ?
  `).all(profileSnapshotId);
  return buildPreferredTopicReference(
    rows.map((row) => row.representationText).filter(Boolean),
    rows.map((row) => row.contentRecallLabel).filter(Boolean)
  );
}

function extractFetchedCounts(details) {
  if (!details || !Array.isArray(details.sources)) return undefined;
  const counts = {};
  for (const source of details.sources) {
    if (!source || typeof source !== "object") continue;
    if (!isSource(source.source) || !Number.isInteger(source.fetchedCount) || source.fetchedCount < 0) continue;
    counts[source.source] = source.fetchedCount;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function sourceCountRows(rows) {
  const counts = { pubmed: 0, biorxiv: 0, arxiv: 0, journal: 0 };
  for (const row of rows) {
    const source = fromDbSource(row.source);
    if (source) counts[source] = Number(row.count);
  }
  return counts;
}

function deriveMetricState(rows) {
  if (rows.some((row) => row.enrichmentStatus === "ENRICHED" && (row.quartile || positiveNumber(row.impactScore)))) {
    return "observed_metric";
  }
  if (rows.some((row) => row.enrichmentStatus === "FAILED")) return "enrichment_failure";
  const sources = unique(rows.map((row) => fromDbSource(row.source)).filter(Boolean));
  const preprintOnly = sources.length > 0 && sources.every((source) => source === "arxiv" || source === "biorxiv");
  const noFormalJournal = rows.every((row) => {
    if (typeof row.journalName !== "string" || row.journalName.trim() === "") return true;
    const normalized = row.journalName.trim().toLowerCase().replace(/[^a-z]/g, "");
    return normalized === "arxiv" || normalized === "biorxiv";
  });
  if (preprintOnly && noFormalJournal) return "not_applicable_preprint";
  if (rows.some((row) => row.enrichmentStatus === "NOT_FOUND")) return "unavailable_metric";
  return "unattempted_or_unknown";
}

function fromDbSource(value) {
  if (value === "PUBMED") return "pubmed";
  if (value === "BIORXIV") return "biorxiv";
  if (value === "ARXIV") return "arxiv";
  if (value === "JOURNAL") return "journal";
  return undefined;
}

function fromDbResearchCategory(value) {
  if (value === "METHOD") return "method";
  if (value === "BIOLOGY") return "biology";
  if (value === "RESOURCE") return "resource";
  if (value === "BENCHMARK") return "benchmark";
  return undefined;
}

function anonymize(runId, candidateId) {
  return createHash("sha256").update(`${runId}\0${candidateId}`).digest("hex").slice(0, 12);
}

function databaseFingerprint(path) {
  const stat = statSync(path);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
  };
}

function parseJson(value) {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const parsed = { topN: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db") {
      parsed.dbPath = value;
      index += 1;
    } else if (argument === "--run-id") {
      parsed.runId = value;
      index += 1;
    } else if (argument === "--top-n") {
      const topN = Number(value);
      if (!Number.isInteger(topN) || topN < 1) fail("--top-n must be a positive integer.");
      parsed.topN = topN;
      index += 1;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function unique(values) {
  return [...new Set(values)];
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSource(value) {
  return value === "pubmed" || value === "biorxiv" || value === "arxiv" || value === "journal";
}

function fail(message) {
  throw new Error(message);
}
