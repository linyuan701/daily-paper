import { describe, expect, it } from "vitest";

import {
  createFeedbackState,
  effectiveTriageActions,
  excludeDismissedRecommendations,
  feedbackStateReducer,
  latestTriageActions
} from "./feedback-state";

describe("feedback state", () => {
  it("optimistically dismisses and rolls back to the prior persisted action on failure", () => {
    const initial = createFeedbackState({ "candidate-1": "save" });
    const pending = feedbackStateReducer(initial, {
      type: "start",
      candidateId: "candidate-1",
      action: "dismiss",
      undoExpiresAt: 10_000
    });

    expect(pending["candidate-1"]).toMatchObject({
      action: "dismiss",
      persistedAction: "save",
      previousAction: "save",
      pendingAction: "dismiss",
      status: "pending"
    });

    const rolledBack = feedbackStateReducer(pending, {
      type: "fail",
      candidateId: "candidate-1",
      action: "dismiss",
      error: "offline"
    });
    expect(rolledBack["candidate-1"]).toEqual({
      action: "save",
      persistedAction: "save",
      status: "failure",
      error: "offline"
    });
  });

  it("undoes only an uncommitted dismiss and ignores duplicate starts", () => {
    const pending = feedbackStateReducer({}, {
      type: "start",
      candidateId: "candidate-1",
      action: "dismiss"
    });
    expect(
      feedbackStateReducer(pending, {
        type: "start",
        candidateId: "candidate-1",
        action: "save"
      })
    ).toBe(pending);

    expect(
      feedbackStateReducer(pending, { type: "undo-dismiss", candidateId: "candidate-1" })[
        "candidate-1"
      ]
    ).toEqual({ action: undefined, persistedAction: undefined, status: "idle" });
  });
});

describe("feed feedback helpers", () => {
  it("removes dismissed candidates while preserving other candidates", () => {
    const recommendations = [
      { candidateId: "candidate-1", rank: 1 },
      { candidateId: "candidate-2", rank: 2 },
      { candidateId: "candidate-3", rank: 3 }
    ];
    const state = createFeedbackState({
      "candidate-1": "dismiss",
      "candidate-2": "save"
    });

    expect(excludeDismissedRecommendations(recommendations, effectiveTriageActions(state))).toEqual([
      { candidateId: "candidate-2", rank: 2 },
      { candidateId: "candidate-3", rank: 3 }
    ]);
  });

  it("keeps the newest triage action from descending logs and ignores malformed entries", () => {
    expect(
      latestTriageActions([
        { candidateId: "candidate-1", actionType: "dismiss" },
        { candidateId: "candidate-1", actionType: "save" },
        { candidateId: "candidate-2", actionType: "promote" },
        { candidateId: "candidate-3", actionType: "label_edit" },
        null
      ])
    ).toEqual({ "candidate-1": "dismiss", "candidate-2": "promote" });
    expect(latestTriageActions(undefined)).toEqual({});
  });
});
