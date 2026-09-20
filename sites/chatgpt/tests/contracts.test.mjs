import test from "node:test";
import assert from "node:assert/strict";
import {
  correctionPayload,
  correctionConfirmed,
  draftAfterWrite,
} from "../public/contracts.js";
const paper = {
  candidateId: "fixture",
  labels: {
    contentRecall: { label: "#old" },
    researchType: {
      category: "biology",
      primaryKeyword: "first",
      secondaryKeyword: "second",
      rawText: "#Biology - first - second",
      provenance: "generated",
    },
  },
  summary: {
    researchQuestion: "q",
    method: "m",
    mainFinding: "f",
    relevanceToUser: "r",
  },
};
const draft = {
  contentRecallLabel: "#old",
  category: "biology",
  primaryKeyword: "first",
  secondaryKeyword: "second",
  ...paper.summary,
};
test("content-only correction does not replace researchType or discard raw label evidence", () => {
  assert.deepEqual(
    correctionPayload(paper, { ...draft, contentRecallLabel: "#new" }),
    { candidateId: "fixture", labels: { contentRecallLabel: "#new" } },
  );
});
test("research-type correction preserves rawText and excludes unchanged content/summary", () => {
  const payload = correctionPayload(paper, {
    ...draft,
    primaryKeyword: "changed",
  });
  assert.equal(
    payload.labels.researchType.rawText,
    paper.labels.researchType.rawText,
  );
  assert.equal(payload.labels.researchType.primaryKeyword, "changed");
  assert.equal(payload.labels.contentRecallLabel, undefined);
  assert.equal(payload.summary, undefined);
});
test("readback confirmation rejects stale, missing, or different candidate content", () => {
  const payload = correctionPayload(paper, {
    ...draft,
    researchQuestion: "new question",
  });
  assert.equal(correctionConfirmed(paper, payload), false);
  assert.equal(correctionConfirmed(null, payload), false);
  assert.equal(
    correctionConfirmed(
      {
        ...paper,
        summary: { ...paper.summary, researchQuestion: "new question" },
      },
      payload,
    ),
    true,
  );
});
test("failed/uncertain PUT preserves draft; confirmed readback clears only the submitted revision", () => {
  assert.deepEqual(draftAfterWrite(draft, draft, false), draft);
  assert.equal(draftAfterWrite(draft, draft, true), undefined);
  const newer = { ...draft, researchQuestion: "typed while saving" };
  assert.deepEqual(draftAfterWrite(newer, draft, true), newer);
});
test("readback follows backend whitespace normalization and verifies category removal", () => {
  assert.equal(
    correctionConfirmed(
      { ...paper, labels: { ...paper.labels, contentRecall: undefined } },
      { candidateId: "fixture", labels: { contentRecallLabel: "  " } },
    ),
    true,
  );
  assert.equal(
    correctionConfirmed(paper, {
      candidateId: "fixture",
      labels: { contentRecallLabel: " #old " },
    }),
    true,
  );
  const payload = correctionPayload(paper, { ...draft, category: "" });
  assert.equal(correctionConfirmed(paper, payload), false);
  assert.equal(
    correctionConfirmed(
      {
        ...paper,
        labels: {
          ...paper.labels,
          researchType: { ...paper.labels.researchType, category: undefined },
        },
      },
      payload,
    ),
    true,
  );
});
