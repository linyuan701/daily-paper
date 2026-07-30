import { describe, expect, it } from "vitest";

import {
  applyTriageAction,
  createFeedbackState,
  effectiveFeedbackProjections,
  EMPTY_FEEDBACK_PROJECTION,
  excludeDismissedRecommendations,
  feedbackStateReducer,
  foldFeedbackProjections,
  type FeedbackProjection,
  type TriageAction
} from "./feedback-state";

const NONE: FeedbackProjection = { saved: false, promoted: false, dismissed: false };

describe("feedback projection rules", () => {
  it.each([
    ["initial", [], NONE],
    ["SAVE", ["save"], { saved: true, promoted: false, dismissed: false }],
    ["PROMOTE", ["promote"], { saved: false, promoted: true, dismissed: false }],
    ["SAVE -> PROMOTE", ["save", "promote"], { saved: true, promoted: true, dismissed: false }],
    ["PROMOTE -> SAVE", ["promote", "save"], { saved: true, promoted: true, dismissed: false }],
    ["SAVE -> DISMISS", ["save", "dismiss"], { saved: false, promoted: false, dismissed: true }],
    ["PROMOTE -> DISMISS", ["promote", "dismiss"], { saved: false, promoted: false, dismissed: true }],
    ["DISMISS -> SAVE", ["dismiss", "save"], { saved: true, promoted: false, dismissed: false }],
    ["DISMISS -> PROMOTE", ["dismiss", "promote"], { saved: false, promoted: true, dismissed: false }]
  ] as Array<[string, TriageAction[], FeedbackProjection]>) (
    "%s",
    (_label, actions, expected) => {
      const actual = actions.reduce(applyTriageAction, { ...EMPTY_FEEDBACK_PROJECTION });
      expect(actual).toEqual(expected);
    }
  );

  it("folds a saved + promoted state identically after refresh", () => {
    expect(foldFeedbackProjections([
      log("z-save", "save", "2026-07-30T01:00:00.000Z"),
      log("z-promote", "promote", "2026-07-30T01:01:00.000Z")
    ])).toEqual({ "candidate-1": { saved: true, promoted: true, dismissed: false } });
  });

  it("uses id as the stable tie-breaker when createdAt is identical", () => {
    const createdAt = "2026-07-30T01:00:00.000Z";
    expect(foldFeedbackProjections([
      log("b-dismiss", "dismiss", createdAt),
      log("a-save", "save", createdAt)
    ])).toEqual({ "candidate-1": { saved: false, promoted: false, dismissed: true } });
  });

  it("ignores non-triage and malformed logs", () => {
    expect(foldFeedbackProjections([
      log("a", "save", "2026-07-30T01:00:00.000Z"),
      { ...log("b", "label_edit", "2026-07-30T01:01:00.000Z") },
      null
    ])).toEqual({ "candidate-1": { saved: true, promoted: false, dismissed: false } });
    expect(foldFeedbackProjections(undefined)).toEqual({});
  });
});

describe("feedback reducer", () => {
  it("rolls an API failure back to the complete prior state", () => {
    const combined = { saved: true, promoted: true, dismissed: false };
    const initial = createFeedbackState({ "candidate-1": combined });
    const pending = feedbackStateReducer(initial, {
      type: "start", candidateId: "candidate-1", action: "dismiss", undoExpiresAt: 10_000
    });
    expect(pending["candidate-1"]).toMatchObject({
      current: { saved: false, promoted: false, dismissed: true },
      persisted: combined,
      previous: combined,
      pendingAction: "dismiss",
      status: "pending"
    });

    expect(feedbackStateReducer(pending, {
      type: "fail", candidateId: "candidate-1", action: "dismiss", error: "offline"
    })["candidate-1"]).toEqual({
      current: combined,
      persisted: combined,
      status: "failure",
      error: "offline"
    });
  });

  it("undoes only an uncommitted dismiss and restores the complete prior state", () => {
    const combined = { saved: true, promoted: true, dismissed: false };
    const pending = feedbackStateReducer(createFeedbackState({ "candidate-1": combined }), {
      type: "start", candidateId: "candidate-1", action: "dismiss"
    });
    expect(feedbackStateReducer(pending, {
      type: "undo-dismiss", candidateId: "candidate-1"
    })["candidate-1"]).toEqual({
      current: combined,
      persisted: combined,
      status: "idle"
    });
  });

  it("does not start an already-applied action", () => {
    const initial = createFeedbackState({
      "candidate-1": { saved: true, promoted: true, dismissed: false }
    });
    expect(feedbackStateReducer(initial, {
      type: "start", candidateId: "candidate-1", action: "save"
    })).toBe(initial);
    expect(feedbackStateReducer(initial, {
      type: "start", candidateId: "candidate-1", action: "promote"
    })).toBe(initial);
  });
});

describe("feed feedback helpers", () => {
  it("removes only dismissed candidates", () => {
    const recommendations = [
      { candidateId: "candidate-1" },
      { candidateId: "candidate-2" },
      { candidateId: "candidate-3" }
    ];
    const state = createFeedbackState({
      "candidate-1": { saved: false, promoted: false, dismissed: true },
      "candidate-2": { saved: true, promoted: true, dismissed: false }
    });
    expect(excludeDismissedRecommendations(
      recommendations,
      effectiveFeedbackProjections(state)
    )).toEqual([{ candidateId: "candidate-2" }, { candidateId: "candidate-3" }]);
  });
});

function log(id: string, actionType: string, createdAt: string) {
  return { id, candidateId: "candidate-1", actionType, createdAt };
}
