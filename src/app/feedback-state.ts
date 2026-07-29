export type TriageAction = "save" | "dismiss" | "promote";

export type FeedbackRequestStatus = "idle" | "pending" | "success" | "failure";

export type CandidateFeedbackState = {
  /** The action currently reflected by the UI, including optimistic changes. */
  action?: TriageAction;
  /** The latest action known to have been persisted by the API. */
  persistedAction?: TriageAction;
  pendingAction?: TriageAction;
  previousAction?: TriageAction;
  status: FeedbackRequestStatus;
  error?: string;
  undoExpiresAt?: number;
};

export type FeedbackState = Record<string, CandidateFeedbackState | undefined>;

export type FeedbackStateEvent =
  | {
      type: "start";
      candidateId: string;
      action: TriageAction;
      undoExpiresAt?: number;
    }
  | { type: "succeed"; candidateId: string; action: TriageAction }
  | { type: "fail"; candidateId: string; action: TriageAction; error: string }
  | { type: "undo-dismiss"; candidateId: string };

export function createFeedbackState(
  actions: Readonly<Record<string, TriageAction | undefined>> = {}
): FeedbackState {
  return Object.fromEntries(
    Object.entries(actions).flatMap(([candidateId, action]) =>
      action
        ? [[candidateId, { action, persistedAction: action, status: "idle" } satisfies CandidateFeedbackState]]
        : []
    )
  );
}

export function feedbackStateReducer(state: FeedbackState, event: FeedbackStateEvent): FeedbackState {
  const current = state[event.candidateId] ?? { status: "idle" };

  if (event.type === "start") {
    if (current.pendingAction) return state;

    return {
      ...state,
      [event.candidateId]: {
        ...current,
        action: event.action,
        pendingAction: event.action,
        previousAction: current.action,
        status: "pending",
        error: undefined,
        undoExpiresAt: event.undoExpiresAt
      }
    };
  }

  if (event.type === "succeed") {
    if (current.pendingAction !== event.action) return state;

    return {
      ...state,
      [event.candidateId]: {
        action: event.action,
        persistedAction: event.action,
        status: "success"
      }
    };
  }

  if (event.type === "fail") {
    if (current.pendingAction !== event.action) return state;

    return {
      ...state,
      [event.candidateId]: {
        action: current.previousAction,
        persistedAction: current.persistedAction,
        status: "failure",
        error: event.error
      }
    };
  }

  if (current.pendingAction !== "dismiss") return state;

  return {
    ...state,
    [event.candidateId]: {
      action: current.previousAction,
      persistedAction: current.persistedAction,
      status: "idle"
    }
  };
}

export function effectiveTriageActions(state: FeedbackState): Record<string, TriageAction> {
  return Object.fromEntries(
    Object.entries(state).flatMap(([candidateId, item]) =>
      item?.action ? [[candidateId, item.action]] : []
    )
  );
}

export function excludeDismissedRecommendations<T extends { candidateId: string }>(
  recommendations: readonly T[],
  actions: Readonly<Record<string, TriageAction | undefined>>
): T[] {
  return recommendations.filter((recommendation) => actions[recommendation.candidateId] !== "dismiss");
}

export function latestTriageActions(logs: unknown): Record<string, TriageAction> {
  if (!Array.isArray(logs)) return {};

  const state: Record<string, TriageAction> = {};

  for (const entry of logs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const candidateId = (entry as Record<string, unknown>).candidateId;
    const actionType = (entry as Record<string, unknown>).actionType;
    if (
      typeof candidateId !== "string" ||
      candidateId === "" ||
      candidateId in state ||
      !isTriageAction(actionType)
    ) {
      continue;
    }

    state[candidateId] = actionType;
  }

  return state;
}

function isTriageAction(value: unknown): value is TriageAction {
  return value === "save" || value === "dismiss" || value === "promote";
}
