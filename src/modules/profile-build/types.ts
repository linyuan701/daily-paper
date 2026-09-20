import type { NegativeFeedbackSignal } from "../feedback/types";

import type { PersistedFeedbackEvidence } from "./persisted-evidence";

export type ProfileInterestSegmentValue = "recent_core" | "stable_long_term" | "background";
export type ProfileRepresentationSourceValue = "structured_tags" | "title_abstract";

export type ProfileEligibleItem = {
  itemId: string;
  zoteroItemKey: string;
  title?: string;
  abstractNote?: string;
  dateAdded?: Date;
  libraryVersion?: number;
  collectionPriorities: Array<"primary" | "secondary">;
  attentionLevel: number;
  contentRecallLabels: string[];
  researchCategories: Array<"method" | "biology" | "resource" | "benchmark">;
  researchKeywords: string[];
};

export type ProfileSnapshotItemInput = {
  itemId: string;
  segment: ProfileInterestSegmentValue;
  finalWeight: number;
  collectionWeight: number;
  attentionWeight: number;
  recencyWeight: number;
  representationSource: ProfileRepresentationSourceValue;
  contentRecallLabel?: string;
  researchCategory?: "method" | "biology" | "resource" | "benchmark";
  representationText: string;
};

export type ProfileResearchPreferenceInput = {
  category: "method" | "biology" | "resource" | "benchmark";
  weight: number;
  itemCount: number;
};

export type ProfileSnapshotSummary = {
  feedbackIntegration?: PersistedFeedbackEvidence;
  positiveLabels?: string[];
  id: string;
  status: "active" | "superseded";
  builtAt: string;
  sourceLibraryVersion?: number;
  itemsCount: number;
  segments: {
    recentCore: number;
    stableLongTerm: number;
    background: number;
  };
  researchTypePreferences: Array<{
    category: "method" | "biology" | "resource" | "benchmark";
    weight: number;
    itemCount: number;
  }>;
};

export type ProfileFeedbackLogRecord = {
  id: string;
  runId: string;
  candidateId: string;
  actionType: "save" | "dismiss" | "promote" | "label_edit" | "summary_edit";
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  candidate?: {
    paperIdentityKey: string;
    title?: string;
    abstractNote?: string;
    contentRecallLabels: string[];
    researchCategories: Array<"method" | "biology" | "resource" | "benchmark">;
    researchKeywords: string[];
  };
};

export type ProfileRefreshTriggerValue = "initial" | "manual" | "scheduled";
export type ProfileRefreshJobStatusValue = "running" | "success" | "failed";

export type ProfileRefreshJobSummary = {
  id: string;
  trigger: ProfileRefreshTriggerValue;
  status: ProfileRefreshJobStatusValue;
  startedAt: string;
  finishedAt?: string;
  snapshotId?: string;
  errorMessage?: string;
};

export type ProfileReminderCheckSummary = {
  id: string;
  checkedAt: string;
  lastRefreshAt?: string;
  isDue: boolean;
};

export interface ProfileSnapshotRepository {
  listEligibleItems(): Promise<ProfileEligibleItem[]>;
  listFeedbackLogs(input?: { since?: Date; limit?: number }): Promise<ProfileFeedbackLogRecord[]>;
  listTriageFeedbackLogs(): Promise<ProfileFeedbackLogRecord[]>;
  saveActiveSnapshot(input: {
    sourceLibraryVersion?: number;
    items: ProfileSnapshotItemInput[];
    researchPreferences: ProfileResearchPreferenceInput[];
    summaryJson: Record<string, unknown>;
  }): Promise<ProfileSnapshotSummary>;
  getActiveSnapshot(): Promise<ProfileSnapshotSummary | null>;
}

export type ProfileNegativeFeedbackSignal = NegativeFeedbackSignal;

export interface ProfileBuildService {
  buildSnapshot(): Promise<ProfileSnapshotSummary>;
  getActiveSnapshot(): Promise<ProfileSnapshotSummary | null>;
}

export interface ProfileRefreshRepository {
  createRefreshJob(input: { trigger: ProfileRefreshTriggerValue }): Promise<{ id: string }>;
  markRefreshJobSucceeded(input: {
    jobId: string;
    snapshotId: string;
  }): Promise<ProfileRefreshJobSummary>;
  markRefreshJobFailed(input: {
    jobId: string;
    errorMessage: string;
  }): Promise<ProfileRefreshJobSummary>;
  getLatestRefreshJob(): Promise<ProfileRefreshJobSummary | null>;
  recordReminderCheck(input: {
    isDue: boolean;
    lastRefreshAt?: Date;
  }): Promise<ProfileReminderCheckSummary>;
  getLatestReminderCheck(): Promise<ProfileReminderCheckSummary | null>;
}

export interface ProfileRefreshService {
  runManualRefresh(): Promise<{ job: ProfileRefreshJobSummary; snapshot: ProfileSnapshotSummary }>;
  runScheduledRefresh(): Promise<{ job: ProfileRefreshJobSummary; snapshot: ProfileSnapshotSummary }>;
  getRefreshStatus(): Promise<{
    latestJob: ProfileRefreshJobSummary | null;
    activeSnapshot: ProfileSnapshotSummary | null;
    latestReminder: ProfileReminderCheckSummary | null;
  }>;
  runMonthlyReminderCheck(now?: Date): Promise<ProfileReminderCheckSummary>;
}
