import { afterEach, describe, expect, it, vi } from "vitest";

import { createFeedbackController } from "./feedback-interactions";

afterEach(() => {
  vi.useRealTimers();
});

describe("feedback controller", () => {
  it("persists a dismiss after the undo window and marks it successful", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(undefined);
    const controller = createFeedbackController({
      runId: "run-1",
      dismissDelayMs: 1_000,
      persist
    });

    await expect(controller.perform("candidate-1", "dismiss")).resolves.toEqual({
      accepted: true,
      delayed: true
    });
    expect(controller.getState()["candidate-1"]).toMatchObject({
      action: "dismiss",
      pendingAction: "dismiss",
      status: "pending"
    });
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(persist).toHaveBeenCalledWith({
      runId: "run-1",
      candidateId: "candidate-1",
      action: "dismiss"
    });
    expect(controller.getState()["candidate-1"]).toEqual({
      action: "dismiss",
      persistedAction: "dismiss",
      status: "success"
    });
  });

  it("restores the previous UI action when persistence fails", async () => {
    const controller = createFeedbackController({
      runId: "run-1",
      initialActions: { "candidate-1": "promote" },
      persist: vi.fn().mockRejectedValue(new Error("offline"))
    });

    await controller.perform("candidate-1", "save");
    expect(controller.getState()["candidate-1"]).toEqual({
      action: "promote",
      persistedAction: "promote",
      status: "failure",
      error: "offline"
    });
  });

  it("rolls an optimistic dismiss back when its delayed write fails", async () => {
    vi.useFakeTimers();
    const controller = createFeedbackController({
      runId: "run-1",
      initialActions: { "candidate-1": "save" },
      dismissDelayMs: 1_000,
      persist: vi.fn().mockRejectedValue(new Error("offline"))
    });

    await controller.perform("candidate-1", "dismiss");
    expect(controller.getState()["candidate-1"]?.action).toBe("dismiss");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()["candidate-1"]).toEqual({
      action: "save",
      persistedAction: "save",
      status: "failure",
      error: "offline"
    });
  });

  it("cancels an uncommitted dismiss with Undo", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(undefined);
    const controller = createFeedbackController({
      runId: "run-1",
      dismissDelayMs: 1_000,
      persist
    });

    await controller.perform("candidate-1", "dismiss");
    expect(controller.undoDismiss("candidate-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(persist).not.toHaveBeenCalled();
    expect(controller.getState()["candidate-1"]).toEqual({
      action: undefined,
      persistedAction: undefined,
      status: "idle"
    });
    expect(controller.undoDismiss("candidate-1")).toBe(false);
  });

  it("protects a candidate from duplicate clicks while a request is pending", async () => {
    let resolveRequest!: () => void;
    const persist = vi.fn(
      () => new Promise<void>((resolve) => { resolveRequest = resolve; })
    );
    const controller = createFeedbackController({ runId: "run-1", persist });

    const first = controller.perform("candidate-1", "save");
    await expect(controller.perform("candidate-1", "promote")).resolves.toEqual({
      accepted: false,
      reason: "pending"
    });
    expect(persist).toHaveBeenCalledTimes(1);

    resolveRequest();
    await first;
    expect(controller.getState()["candidate-1"]).toMatchObject({
      action: "save",
      persistedAction: "save",
      status: "success"
    });
  });

  it("flushes delayed dismisses on dispose so navigation does not lose feedback", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(undefined);
    const controller = createFeedbackController({ runId: "run-1", dismissDelayMs: 5_000, persist });

    await controller.perform("candidate-1", "dismiss");
    controller.dispose();
    await Promise.resolve();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      runId: "run-1",
      candidateId: "candidate-1",
      action: "dismiss"
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
