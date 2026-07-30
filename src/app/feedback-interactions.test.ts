import { afterEach, describe, expect, it, vi } from "vitest";

import { createFeedbackController } from "./feedback-interactions";
import type { FeedbackProjection } from "./feedback-state";

const NONE: FeedbackProjection = { saved: false, promoted: false, dismissed: false };
const SAVED: FeedbackProjection = { saved: true, promoted: false, dismissed: false };
const PROMOTED: FeedbackProjection = { saved: false, promoted: true, dismissed: false };
const COMBINED: FeedbackProjection = { saved: true, promoted: true, dismissed: false };

afterEach(() => vi.useRealTimers());

describe("feedback controller", () => {
  it("persists Save then Promote without clearing either dimension", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const controller = createFeedbackController({ runId: "run-1", persist });
    await controller.perform("candidate-1", "save");
    await controller.perform("candidate-1", "promote");
    expect(controller.getState()["candidate-1"]).toEqual({
      current: COMBINED, persisted: COMBINED, status: "success"
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("persists Promote then Save without clearing either dimension", async () => {
    const controller = createFeedbackController({
      runId: "run-1", persist: vi.fn().mockResolvedValue(undefined)
    });
    await controller.perform("candidate-1", "promote");
    await controller.perform("candidate-1", "save");
    expect(controller.getState()["candidate-1"]?.current).toEqual(COMBINED);
  });

  it.each([
    ["save", SAVED],
    ["promote", PROMOTED],
    ["save + promote", COMBINED]
  ] as Array<[string, FeedbackProjection]>) (
    "Undo dismiss restores %s",
    async (_label, initial) => {
      vi.useFakeTimers();
      const persist = vi.fn().mockResolvedValue(undefined);
      const controller = createFeedbackController({
        runId: "run-1", initialProjections: { "candidate-1": initial }, dismissDelayMs: 1_000, persist
      });
      await controller.perform("candidate-1", "dismiss");
      expect(controller.getState()["candidate-1"]?.current).toEqual({
        saved: false, promoted: false, dismissed: true
      });
      expect(controller.undoDismiss("candidate-1")).toBe(true);
      expect(controller.getState()["candidate-1"]?.current).toEqual(initial);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(persist).not.toHaveBeenCalled();
    }
  );

  it("rolls an API failure back to all three prior values", async () => {
    const controller = createFeedbackController({
      runId: "run-1",
      initialProjections: { "candidate-1": COMBINED },
      persist: vi.fn().mockRejectedValue(new Error("offline"))
    });
    vi.useFakeTimers();
    await controller.perform("candidate-1", "dismiss");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.getState()["candidate-1"]).toEqual({
      current: COMBINED,
      persisted: COMBINED,
      status: "failure",
      error: "offline"
    });
  });

  it.each([
    ["save", SAVED],
    ["promote", PROMOTED]
  ] as const)("repeated %s is a no-op and sends no request", async (action, initial) => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const controller = createFeedbackController({
      runId: "run-1", initialProjections: { "candidate-1": initial }, persist
    });
    await expect(controller.perform("candidate-1", action)).resolves.toEqual({
      accepted: false, reason: "already_applied"
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("protects a candidate from a second action while a request is pending", async () => {
    let resolveRequest!: () => void;
    const persist = vi.fn(() => new Promise<void>((resolve) => { resolveRequest = resolve; }));
    const controller = createFeedbackController({ runId: "run-1", persist });
    const first = controller.perform("candidate-1", "save");
    await expect(controller.perform("candidate-1", "promote")).resolves.toEqual({
      accepted: false, reason: "pending"
    });
    resolveRequest();
    await first;
    expect(controller.getState()["candidate-1"]?.current).toEqual(SAVED);
  });

  it("flushes a delayed dismiss on dispose", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(undefined);
    const controller = createFeedbackController({ runId: "run-1", persist });
    await controller.perform("candidate-1", "dismiss");
    controller.dispose();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledWith({
      runId: "run-1", candidateId: "candidate-1", action: "dismiss"
    });
  });

  it("starts from the empty three-dimensional state", () => {
    const controller = createFeedbackController({ runId: "run-1" });
    expect(controller.getState()["candidate-1"]?.current ?? NONE).toEqual(NONE);
  });
});
