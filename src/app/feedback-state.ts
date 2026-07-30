export type TriageAction = "save" | "dismiss" | "promote";

export type FeedbackRequestStatus = "idle" | "pending" | "success" | "failure";

export type FeedbackProjection = {
  saved: boolean;
  promoted: boolean;
  dismissed: boolean;
};

export type CandidateFeedbackState = {
  /** The full state currently reflected by the UI, including optimistic changes. */
  current: FeedbackProjection;
  /** The full state known to have been persisted by the API. */
  persisted: FeedbackProjection;
  pendingAction?: TriageAction;
  previous?: FeedbackProjection;
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

export const EMPTY_FEEDBACK_PROJECTION: Readonly<FeedbackProjection> = Object.freeze({
  saved: false,
  promoted: false,
  dismissed: false
});

export function applyTriageAction(
  current: Readonly<FeedbackProjection>,
  action: TriageAction
): FeedbackProjection {
  if (action === "save") {
    return { ...current, saved: true, dismissed: false };
  }
  if (action === "promote") {
    return { ...current, promoted: true, dismissed: false };
  }
  return { saved: false, promoted: false, dismissed: true };
}

export function isTriageActionApplied(
  current: Readonly<FeedbackProjection>,
  action: TriageAction
): boolean {
  if (action === "save") return current.saved;
  if (action === "promote") return current.promoted;
  return current.dismissed;
}

export function createFeedbackState(
  projections: Readonly<Record<string, FeedbackProjection | undefined>> = {}
): FeedbackState {
  return Object.fromEntries(
    Object.entries(projections).flatMap(([candidateId, projection]) => {
      if (!projection) return [];
      const current = cloneProjection(projection);
      return [[candidateId, {
        current,
        persisted: cloneProjection(projection),
        status: "idle"
      } satisfies CandidateFeedbackState]];
    })
  );
}

export function feedbackStateReducer(state: FeedbackState, event: FeedbackStateEvent): FeedbackState {
  const current = state[event.candidateId] ?? emptyCandidateState();

  if (event.type === "start") {
    if (current.pendingAction || isTriageActionApplied(current.current, event.action)) return state;

    return {
      ...state,
      [event.candidateId]: {
        ...current,
        current: applyTriageAction(current.current, event.action),
        pendingAction: event.action,
        previous: cloneProjection(current.current),
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
        current: cloneProjection(current.current),
        persisted: cloneProjection(current.current),
        status: "success"
      }
    };
  }

  if (event.type === "fail") {
    if (current.pendingAction !== event.action) return state;
    const restored = cloneProjection(current.previous ?? current.persisted);

    return {
      ...state,
      [event.candidateId]: {
        current: restored,
        persisted: cloneProjection(current.persisted),
        status: "failure",
        error: event.error
      }
    };
  }

  if (current.pendingAction !== "dismiss") return state;
  const restored = cloneProjection(current.previous ?? current.persisted);

  return {
    ...state,
    [event.candidateId]: {
      current: restored,
      persisted: cloneProjection(current.persisted),
      status: "idle"
    }
  };
}

export function effectiveFeedbackProjections(
  state: FeedbackState
): Record<string, FeedbackProjection> {
  return Object.fromEntries(
    Object.entries(state).flatMap(([candidateId, item]) =>
      item ? [[candidateId, item.current]] : []
    )
  );
}

export function excludeDismissedRecommendations<T extends { candidateId: string }>(
  recommendations: readonly T[],
  feedback: Readonly<Record<string, FeedbackProjection | undefined>>
): T[] {
  return recommendations.filter((recommendation) => !feedback[recommendation.candidateId]?.dismissed);
}

/** Replays append-only triage logs in stable chronological order. */
export function foldFeedbackProjections(logs: unknown): Record<string, FeedbackProjection> {
  if (!Array.isArray(logs)) return {};

  const entries = logs.flatMap((entry, inputIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (
      typeof value.candidateId !== "string" ||
      value.candidateId === "" ||
      !isTriageAction(value.actionType)
    ) {
      return [];
    }
    return [{
      candidateId: value.candidateId,
      action: value.actionType,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
      id: typeof value.id === "string" ? value.id : "",
      inputIndex
    }];
  }).sort((left, right) => {
    const createdAt = left.createdAt.localeCompare(right.createdAt);
    if (createdAt !== 0) return createdAt;
    const id = left.id.localeCompare(right.id);
    return id !== 0 ? id : left.inputIndex - right.inputIndex;
  });

  const projections: Record<string, FeedbackProjection> = {};
  for (const entry of entries) {
    projections[entry.candidateId] = applyTriageAction(
      projections[entry.candidateId] ?? EMPTY_FEEDBACK_PROJECTION,
      entry.action
    );
  }
  return projections;
}

function emptyCandidateState(): CandidateFeedbackState {
  return {
    current: cloneProjection(EMPTY_FEEDBACK_PROJECTION),
    persisted: cloneProjection(EMPTY_FEEDBACK_PROJECTION),
    status: "idle"
  };
}

function cloneProjection(value: Readonly<FeedbackProjection>): FeedbackProjection {
  return {
    saved: value.saved,
    promoted: value.promoted,
    dismissed: value.dismissed
  };
}

function isTriageAction(value: unknown): value is TriageAction {
  return value === "save" || value === "dismiss" || value === "promote";
}
