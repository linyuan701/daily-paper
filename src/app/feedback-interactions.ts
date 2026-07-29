import {
  createFeedbackState,
  feedbackStateReducer,
  type FeedbackState,
  type TriageAction
} from "./feedback-state";

export type PersistFeedbackAction = (input: {
  runId: string;
  candidateId: string;
  action: TriageAction;
}) => Promise<void>;

export type FeedbackActionResult =
  | { accepted: true; delayed: boolean }
  | { accepted: false; reason: "pending" | "disposed" };

export type FeedbackController = {
  getState(): FeedbackState;
  perform(candidateId: string, action: TriageAction): Promise<FeedbackActionResult>;
  undoDismiss(candidateId: string): boolean;
  dispose(): void;
};

export type FeedbackControllerOptions = {
  runId: string;
  initialActions?: Readonly<Record<string, TriageAction | undefined>>;
  dismissDelayMs?: number;
  persist?: PersistFeedbackAction;
  onChange?: (state: FeedbackState) => void;
  now?: () => number;
};

const DEFAULT_DISMISS_DELAY_MS = 5_000;

export function createFeedbackController(options: FeedbackControllerOptions): FeedbackController {
  const dismissDelayMs = options.dismissDelayMs ?? DEFAULT_DISMISS_DELAY_MS;
  const now = options.now ?? Date.now;
  const persist = options.persist ?? persistFeedbackAction;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let state = createFeedbackState(options.initialActions);
  let disposed = false;

  function dispatch(event: Parameters<typeof feedbackStateReducer>[1]) {
    const next = feedbackStateReducer(state, event);
    if (next === state) return;
    state = next;
    options.onChange?.(state);
  }

  async function commit(candidateId: string, action: TriageAction) {
    try {
      await persist({ runId: options.runId, candidateId, action });
      if (!disposed) dispatch({ type: "succeed", candidateId, action });
    } catch (error) {
      if (!disposed) {
        dispatch({
          type: "fail",
          candidateId,
          action,
          error: error instanceof Error ? error.message : "反馈写入失败"
        });
      }
    }
  }

  return {
    getState() {
      return state;
    },

    async perform(candidateId, action) {
      if (disposed) return { accepted: false, reason: "disposed" };
      if (state[candidateId]?.pendingAction) return { accepted: false, reason: "pending" };

      if (action === "dismiss") {
        dispatch({
          type: "start",
          candidateId,
          action,
          undoExpiresAt: now() + dismissDelayMs
        });
        const timer = setTimeout(() => {
          timers.delete(candidateId);
          void commit(candidateId, action);
        }, dismissDelayMs);
        timers.set(candidateId, timer);
        return { accepted: true, delayed: true };
      }

      dispatch({ type: "start", candidateId, action });
      await commit(candidateId, action);
      return { accepted: true, delayed: false };
    },

    undoDismiss(candidateId) {
      const timer = timers.get(candidateId);
      if (!timer || state[candidateId]?.pendingAction !== "dismiss") return false;

      clearTimeout(timer);
      timers.delete(candidateId);
      dispatch({ type: "undo-dismiss", candidateId });
      return true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [candidateId, timer] of timers) {
        clearTimeout(timer);
        if (state[candidateId]?.pendingAction === "dismiss") {
          void persist({ runId: options.runId, candidateId, action: "dismiss" }).catch(() => undefined);
        }
      }
      timers.clear();
    }
  };
}

export async function persistFeedbackAction(input: {
  runId: string;
  candidateId: string;
  action: TriageAction;
}): Promise<void> {
  const response = await fetch("/api/feedback/actions", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!response.ok) throw new Error(`反馈写入失败 (${response.status})`);

  const payload = (await response.json()) as { status?: string; message?: string };
  if (payload.status !== "ok") throw new Error(payload.message ?? "反馈写入失败");
}
