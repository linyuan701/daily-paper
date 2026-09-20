// Wire-format adapters only. Ranking/profile/learning remain in Daily Paper.
export function correctionPayload(paper, draft) {
  const body = { candidateId: paper.candidateId };
  const labels = {};
  if (draft.contentRecallLabel !== (paper.labels?.contentRecall?.label ?? "")) {
    labels.contentRecallLabel = draft.contentRecallLabel;
  }
  const research = paper.labels?.researchType;
  if (
    ["category", "primaryKeyword", "secondaryKeyword"].some(
      (key) => draft[key] !== (research?.[key] ?? ""),
    )
  ) {
    labels.researchType = {
      ...(draft.category ? { category: draft.category } : {}),
      primaryKeyword: draft.primaryKeyword,
      secondaryKeyword: draft.secondaryKeyword,
      ...(research?.rawText === undefined ? {} : { rawText: research.rawText }),
    };
  }
  if (Object.keys(labels).length) body.labels = labels;
  const summary = Object.fromEntries(
    ["researchQuestion", "method", "mainFinding", "relevanceToUser"].map(
      (key) => [key, draft[key]],
    ),
  );
  if (
    Object.entries(summary).some(
      ([key, value]) => value !== (paper.summary?.[key] ?? ""),
    )
  )
    body.summary = summary;
  return body;
}

export function correctionConfirmed(paper, body) {
  if (!paper || paper.candidateId !== body.candidateId) return false;
  if (
    body.summary &&
    Object.entries(body.summary).some(
      ([key, value]) => paper.summary?.[key] !== value,
    )
  )
    return false;
  if (
    body.labels?.contentRecallLabel !== undefined &&
    (paper.labels?.contentRecall?.label ?? "") !==
      body.labels.contentRecallLabel.trim()
  )
    return false;
  if (
    body.labels?.researchType &&
    ["category", "primaryKeyword", "secondaryKeyword", "rawText"].some(
      (key) =>
        (paper.labels?.researchType?.[key] ?? "") !==
        (body.labels.researchType[key] ?? ""),
    )
  )
    return false;
  return true;
}

export function draftAfterWrite(current, submitted, confirmed) {
  if (!confirmed || !current) return current;
  return Object.keys(current).length === Object.keys(submitted).length &&
    Object.entries(submitted).every(([key, value]) => current[key] === value)
    ? undefined
    : current;
}
