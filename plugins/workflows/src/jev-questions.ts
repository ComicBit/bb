/**
 * jev question sets for the workflow lane orchestrator.
 *
 * This module is a SUPPLEMENT pending validation: it is plain data plus pure
 * functions, has no side effects, and is deliberately not wired into the
 * plugin runtime or service. Nothing here decides anything until a real
 * `jev-1.13.0` run has calibrated the thresholds below.
 *
 * Every threshold in this file is UNCALIBRATED. The wordings are fixed (they
 * were tested for discrimination); the numbers are not.
 *
 * Rejected questions, recorded so they are not re-proposed:
 * - ESCALATION had a Score question named `blockage` ("how blocked is the
 *   lane"). It was REJECTED: it returned the same level on every input, so it
 *   carried no signal and only added latency and cost. Escalation now relies
 *   on `needs_outside_input` (noul) plus `decider` (choice) alone.
 */

/** Pinned jev model. Aliases move on release, so the version is explicit. */
export const JEV_MODEL = "jev-1.13.0";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Boolean question. jev answers with `{ bool: P(true) }`. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** Choice question. jev answers with `{ choice, probabilities, confidence }`. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: { [label: string]: string | null };
}

/** Score question. jev answers with `{ score, probabilities, confidence }`. */
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion
  | JevScoreQuestion;

export type JevQuestionSet = { [id: string]: JevQuestion };

export interface JevNoulAnswer {
  bool: number;
}

export interface JevChoiceAnswer<Label extends string = string> {
  choice: Label;
  probabilities: { [label: string]: number };
  confidence: number;
}

export interface JevScoreAnswer {
  score: number;
  probabilities: { [level: string]: number };
  confidence: number;
}

/**
 * Label prefixes (`F1| `, `C1| `) keep the findings addressable from the
 * instructions text and keep list indices stable across rounds.
 */
function label(prefix: string, entries: readonly string[]): string[] {
  return entries.map((entry, index) => `${prefix}${index + 1}| ${entry}`);
}

// ---------------------------------------------------------------------------
// 1. ESCALATION — should the executor ask anyone, and who?
// ---------------------------------------------------------------------------

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. Anti-chatty gate: below this
 * probability the executor is told to answer the question itself.
 */
export const ESCALATION_NEEDS_OUTSIDE_INPUT_MIN = 0.6;

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. Below this confidence the
 * `decider` choice is not trusted and the question goes to a human.
 */
export const ESCALATION_DECIDER_CONFIDENCE_MIN = 0.5;

export interface EscalationState {
  lane: { task: string; worktree_summary: string };
  question: string;
}

export type EscalationDecider =
  | "human_only"
  | "orchestrator"
  | "self_resolvable";

export interface EscalationAnswers {
  needs_outside_input: JevNoulAnswer;
  decider: JevChoiceAnswer<EscalationDecider>;
}

export type EscalationDecision =
  | { action: "refuse"; reason: string }
  | {
      action: "escalate";
      decider: "human_only" | "orchestrator";
      reason: string;
    };

function escalationState(input: {
  task: string;
  worktreeSummary: string;
  question: string;
}): EscalationState {
  return {
    lane: { task: input.task, worktree_summary: input.worktreeSummary },
    question: input.question,
  };
}

const ESCALATION_QUESTIONS: JevQuestionSet = {
  needs_outside_input: {
    type: "noul",
    instructions:
      "Answering `question` requires information or authority that cannot be obtained by reading the repository in `lane.worktree_summary`, running its tests, or re-reading `lane.task`.",
    criteria: {
      true: "The answer depends on a credential, an external account, a spend decision, or a product/scope call that is not recorded anywhere in the repository or the task text.",
      false:
        "The answer is discoverable by reading the code, running the tests, or following an instruction already present in `lane.task` — even if that takes effort.",
    },
  },
  decider: {
    type: "choice",
    instructions:
      "Who is the narrowest party able to answer `question` correctly?",
    criteria: {
      human_only:
        "Needs a credential, an external account, money, legal/policy authority, or a product decision no agent can derive from the repository.",
      orchestrator:
        "Needs a scope, priority, or interface decision that the agent who wrote `lane.task` made and can restate.",
      self_resolvable:
        "The answer is already determined by the repository or by `lane.task`; the executor should decide it itself.",
    },
  },
};

function routeEscalation(answers: EscalationAnswers): EscalationDecision {
  if (answers.needs_outside_input.bool < ESCALATION_NEEDS_OUTSIDE_INPUT_MIN) {
    return {
      action: "refuse",
      reason: `question is answerable from the worktree and task text (needs_outside_input ${answers.needs_outside_input.bool} < ${ESCALATION_NEEDS_OUTSIDE_INPUT_MIN})`,
    };
  }
  if (answers.decider.choice === "self_resolvable") {
    return {
      action: "refuse",
      reason: "the executor already has what it needs to decide this itself",
    };
  }
  if (answers.decider.confidence < ESCALATION_DECIDER_CONFIDENCE_MIN) {
    return {
      action: "escalate",
      decider: "human_only",
      reason: `decider choice ${answers.decider.choice} held at confidence ${answers.decider.confidence} < ${ESCALATION_DECIDER_CONFIDENCE_MIN}; asking a human is the safe superset`,
    };
  }
  return {
    action: "escalate",
    decider: answers.decider.choice,
    reason: `narrowest party able to answer is ${answers.decider.choice}`,
  };
}

export const escalation = {
  state: escalationState,
  questions: ESCALATION_QUESTIONS,
  route: routeEscalation,
};

// ---------------------------------------------------------------------------
// 2. NO_PROGRESS — is the ralph loop finding the same defects again?
// ---------------------------------------------------------------------------

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. A finding counts as a repeat
 * at or above this probability.
 */
export const NO_PROGRESS_REPEAT_MIN = 0.7;

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. The round counts as inert at
 * or above this probability.
 */
export const NO_PROGRESS_UNTOUCHED_CODE_MIN = 0.7;

export interface NoProgressState {
  previous_findings: string[];
  current_findings: string[];
  diff_since_previous_round: string;
}

/** `repeat_<index>` keys, index-aligned with `current_findings`. */
export type NoProgressAnswers = {
  untouched_code: JevNoulAnswer;
} & { [id: string]: JevNoulAnswer };

export type NoProgressDecision =
  | { action: "stop_loop"; reason: string }
  | { action: "continue"; reason: string };

function noProgressState(input: {
  previousFindings: readonly string[];
  currentFindings: readonly string[];
  diffSincePreviousRound: string;
}): NoProgressState {
  return {
    previous_findings: label("F", input.previousFindings),
    current_findings: label("C", input.currentFindings),
    diff_since_previous_round: input.diffSincePreviousRound,
  };
}

/** Per-finding question ids are `repeat_<index>` over `current_findings`. */
export const NO_PROGRESS_REPEAT_ID_PREFIX = "repeat_";

/**
 * One question per current finding. Asking per item keeps each answer a single
 * judgement; the counting is done in `routeNoProgress`, never in a question.
 */
function noProgressRepeat(index: number): JevNoulQuestion {
  return {
    type: "noul",
    instructions: `Finding \`current_findings[${index}]\` reports the same underlying defect as one of the entries in \`previous_findings\`.`,
    criteria: {
      true: "It points at the same code doing the same wrong thing, even if worded differently.",
      false:
        "It reports a defect that none of the previous findings mentioned, or the same code failing in a different way.",
    },
  };
}

const NO_PROGRESS_UNTOUCHED_CODE: JevNoulQuestion = {
  type: "noul",
  instructions:
    "`diff_since_previous_round` leaves the code named in `previous_findings` unchanged.",
  criteria: {
    true: "The diff does not touch the lines or functions the previous findings pointed at.",
    false:
      "The diff modifies the code the previous findings pointed at, whether or not the fix is correct.",
  },
};

function noProgressQuestions(currentFindingsCount: number): JevQuestionSet {
  const questions: JevQuestionSet = {};
  for (let index = 0; index < currentFindingsCount; index += 1) {
    questions[`${NO_PROGRESS_REPEAT_ID_PREFIX}${index}`] =
      noProgressRepeat(index);
  }
  questions.untouched_code = NO_PROGRESS_UNTOUCHED_CODE;
  return questions;
}

function routeNoProgress(answers: NoProgressAnswers): NoProgressDecision {
  const repeats: number[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (id.startsWith(NO_PROGRESS_REPEAT_ID_PREFIX)) repeats.push(answer.bool);
  }
  // An empty round says nothing about repetition; only `untouched_code` can
  // stop the loop in that case.
  const allRepeated =
    repeats.length > 0 &&
    repeats.every((bool) => bool >= NO_PROGRESS_REPEAT_MIN);
  if (allRepeated) {
    return {
      action: "stop_loop",
      reason: `all ${repeats.length} current finding(s) repeat a previous finding`,
    };
  }
  if (answers.untouched_code.bool >= NO_PROGRESS_UNTOUCHED_CODE_MIN) {
    return {
      action: "stop_loop",
      reason:
        "the round left the code named in the previous findings untouched",
    };
  }
  const newFindings = repeats.filter(
    (bool) => bool < NO_PROGRESS_REPEAT_MIN,
  ).length;
  return {
    action: "continue",
    reason: `${newFindings} of ${repeats.length} current finding(s) are new and the diff moved the named code`,
  };
}

export const noProgress = {
  state: noProgressState,
  repeat: noProgressRepeat,
  questions: noProgressQuestions,
  route: routeNoProgress,
};

// ---------------------------------------------------------------------------
// 3. REVIEWER_FAILURE — the reviewer returned something unusable
// ---------------------------------------------------------------------------

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. At or above this probability
 * the raw output is worth reformatting instead of re-reviewing.
 */
export const REVIEWER_FAILURE_SALVAGEABLE_MIN = 0.7;

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. Below this confidence the
 * failure kind is not trusted and the review is simply redone.
 */
export const REVIEWER_FAILURE_KIND_CONFIDENCE_MIN = 0.5;

export interface ReviewerFailureState {
  expected_schema: string;
  reviewer_raw_output: string;
  changed_files: string[];
}

export type ReviewerFailureKind =
  | "prose_instead_of_json"
  | "misunderstood_task"
  | "nothing_to_review"
  | "refused"
  | "truncated"
  | "other";

export interface ReviewerFailureAnswers {
  failure_kind: JevChoiceAnswer<ReviewerFailureKind>;
  salvageable: JevNoulAnswer;
}

export type ReviewerFailureDecision =
  | { action: "reformat"; reason: string }
  | { action: "drop_review"; reason: string }
  | { action: "small_model_reviewer"; reason: string };

function reviewerFailureState(input: {
  expectedSchema: string;
  reviewerRawOutput: string;
  changedFiles: readonly string[];
}): ReviewerFailureState {
  return {
    expected_schema: input.expectedSchema,
    reviewer_raw_output: input.reviewerRawOutput,
    changed_files: [...input.changedFiles],
  };
}

const REVIEWER_FAILURE_QUESTIONS: JevQuestionSet = {
  failure_kind: {
    type: "choice",
    instructions:
      "In what way does `reviewer_raw_output` fail to satisfy `expected_schema`?",
    criteria: {
      prose_instead_of_json:
        "It contains a genuine review but is written as prose rather than the required structure.",
      misunderstood_task:
        "It reviews something other than the changed files, or answers a different question than 'is this change acceptable'.",
      nothing_to_review:
        "It states there is no change, no diff, or nothing it could inspect.",
      refused:
        "It declines to review, asks for permission, or asks a question instead of reviewing.",
      truncated: "It stops mid-sentence or mid-structure, as if cut off.",
      other: null,
    },
  },
  salvageable: {
    type: "noul",
    instructions:
      "`reviewer_raw_output` already names at least one concrete defect with the file or location where it occurs.",
    criteria: {
      true: "A specific defect and its location can be read straight out of the text.",
      false:
        "It contains only general impressions, approval, or questions, with no located defect.",
    },
  },
};

function routeReviewerFailure(
  answers: ReviewerFailureAnswers,
): ReviewerFailureDecision {
  if (answers.salvageable.bool >= REVIEWER_FAILURE_SALVAGEABLE_MIN) {
    return {
      action: "reformat",
      reason: "the raw output already names a located defect",
    };
  }
  if (
    answers.failure_kind.choice === "nothing_to_review" &&
    answers.failure_kind.confidence >= REVIEWER_FAILURE_KIND_CONFIDENCE_MIN
  ) {
    return {
      action: "drop_review",
      reason: "the reviewer had nothing to inspect",
    };
  }
  return {
    action: "small_model_reviewer",
    reason: `failure kind ${answers.failure_kind.choice} at confidence ${answers.failure_kind.confidence}; redo the review`,
  };
}

export const reviewerFailure = {
  state: reviewerFailureState,
  questions: REVIEWER_FAILURE_QUESTIONS,
  route: routeReviewerFailure,
};

// ---------------------------------------------------------------------------
// 4. CONFLICT — can the lane rebase itself, or must integration park it?
// ---------------------------------------------------------------------------

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. A textual conflict is handed
 * back to the executor only at or above this probability.
 */
export const CONFLICT_LANE_CAN_RESOLVE_ALONE_MIN = 0.6;

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. Below this confidence the
 * conflict kind is not trusted and the lane parks.
 */
export const CONFLICT_KIND_CONFIDENCE_MIN = 0.5;

export interface ConflictState {
  lane_task: string;
  other_lane_tasks: string[];
  conflicted_paths: string[];
  conflict_hunks: string;
}

export type ConflictKind = "textual" | "semantic" | "structural";

export interface ConflictAnswers {
  conflict_kind: JevChoiceAnswer<ConflictKind>;
  lane_can_resolve_alone: JevNoulAnswer;
}

export type ConflictDecision =
  | { action: "executor_rebase"; reason: string }
  | { action: "park"; reason: string };

function conflictState(input: {
  laneTask: string;
  otherLaneTasks: readonly string[];
  conflictedPaths: readonly string[];
  conflictHunks: string;
}): ConflictState {
  return {
    lane_task: input.laneTask,
    other_lane_tasks: [...input.otherLaneTasks],
    conflicted_paths: [...input.conflictedPaths],
    conflict_hunks: input.conflictHunks,
  };
}

const CONFLICT_QUESTIONS: JevQuestionSet = {
  conflict_kind: {
    type: "choice",
    instructions: "What kind of conflict do `conflict_hunks` represent?",
    criteria: {
      textual:
        "Both sides add or edit neighbouring lines with compatible intent, such as two imports or two list entries; keeping both is correct.",
      semantic:
        "The two sides implement incompatible behaviour for the same thing, so keeping both would be wrong even if it compiled.",
      structural:
        "One side moved, renamed, or deleted the file, function, or symbol that the other side edited.",
    },
  },
  lane_can_resolve_alone: {
    type: "noul",
    instructions:
      "An agent that knows only `lane_task` can reapply its own change on top of the other side of `conflict_hunks` correctly.",
    criteria: {
      true: "Its change is expressible on top of the other side without deciding anything about the other lane's intent.",
      false:
        "Resolving it requires deciding how the other lane's change should behave, or knowledge only the other lane has.",
    },
  },
};

/**
 * min-across-parts, never max. In testing the two signals disagreed: jev
 * repeatedly called a `semantic` conflict resolvable by the lane alone,
 * because the lane's own patch does reapply cleanly — it just reapplies the
 * wrong behaviour. So `semantic` and `structural` park regardless of
 * `lane_can_resolve_alone`, and a `textual` conflict needs BOTH signals.
 */
function routeConflict(answers: ConflictAnswers): ConflictDecision {
  const kind = answers.conflict_kind.choice;
  if (answers.conflict_kind.confidence < CONFLICT_KIND_CONFIDENCE_MIN) {
    return {
      action: "park",
      reason: `conflict kind ${kind} held at confidence ${answers.conflict_kind.confidence} < ${CONFLICT_KIND_CONFIDENCE_MIN}`,
    };
  }
  if (kind !== "textual") {
    return {
      action: "park",
      reason: `${kind} conflict needs a decision about the other lane's intent`,
    };
  }
  if (
    answers.lane_can_resolve_alone.bool < CONFLICT_LANE_CAN_RESOLVE_ALONE_MIN
  ) {
    return {
      action: "park",
      reason: `textual conflict but the lane cannot reapply alone (${answers.lane_can_resolve_alone.bool} < ${CONFLICT_LANE_CAN_RESOLVE_ALONE_MIN})`,
    };
  }
  return {
    action: "executor_rebase",
    reason: "textual conflict the lane can reapply on top of the other side",
  };
}

export const conflict = {
  state: conflictState,
  questions: CONFLICT_QUESTIONS,
  route: routeConflict,
};

// ---------------------------------------------------------------------------
// 5. APPROVAL_CROSSCHECK — did the reviewer approve over its own findings?
// ---------------------------------------------------------------------------

/**
 * UNCALIBRATED pending a real `jev-1.13.0` run. At or above this probability
 * an approval is overridden.
 */
export const APPROVAL_CROSSCHECK_BLOCKING_DEFECT_MIN = 0.7;

export interface ApprovalCrosscheckState {
  reviewer_verdict: { approved: boolean };
  findings: string[];
}

export interface ApprovalCrosscheckAnswers {
  blocking_defect_present: JevNoulAnswer;
}

export type ApprovalCrosscheckDecision =
  | { action: "override_to_not_approved"; reason: string }
  | { action: "accept_verdict"; reason: string };

function approvalCrosscheckState(input: {
  approved: boolean;
  findings: readonly string[];
}): ApprovalCrosscheckState {
  return {
    reviewer_verdict: { approved: input.approved },
    findings: label("F", input.findings),
  };
}

const APPROVAL_CROSSCHECK_QUESTIONS: JevQuestionSet = {
  blocking_defect_present: {
    type: "noul",
    instructions:
      "At least one entry in `findings` describes a defect that would cause wrong behaviour, data loss, or a crash in normal use of the code.",
    criteria: {
      true: "A described defect changes what the program does for a normal input or hides a real failure from its caller.",
      false:
        "The described issues are limited to style, naming, formatting, missing tests, or improvements that do not change behaviour.",
    },
  },
};

/**
 * `reviewerApproved` is passed alongside the answers because the check is
 * one-sided: a NOT-approved verdict is never overridden, so there is nothing
 * to cross-check.
 */
function routeApprovalCrosscheck(
  answers: ApprovalCrosscheckAnswers,
  reviewerApproved: boolean,
): ApprovalCrosscheckDecision {
  if (
    reviewerApproved &&
    answers.blocking_defect_present.bool >=
      APPROVAL_CROSSCHECK_BLOCKING_DEFECT_MIN
  ) {
    return {
      action: "override_to_not_approved",
      reason: "approved verdict contradicts a blocking defect in its findings",
    };
  }
  return {
    action: "accept_verdict",
    reason: reviewerApproved
      ? "no blocking defect among the findings"
      : "verdict is already not approved",
  };
}

export const approvalCrosscheck = {
  state: approvalCrosscheckState,
  questions: APPROVAL_CROSSCHECK_QUESTIONS,
  route: routeApprovalCrosscheck,
};

// ---------------------------------------------------------------------------
// Degraded mode
// ---------------------------------------------------------------------------

export type JevSite =
  | "escalation"
  | "no_progress"
  | "reviewer_failure"
  | "conflict"
  | "approval_crosscheck";

export interface JevDecisionBySite {
  escalation: EscalationDecision;
  no_progress: NoProgressDecision;
  reviewer_failure: ReviewerFailureDecision;
  conflict: ConflictDecision;
  approval_crosscheck: ApprovalCrosscheckDecision;
}

const DEGRADED: {
  [Site in JevSite]: (reason: string) => JevDecisionBySite[Site];
} = {
  escalation: (reason) => ({
    action: "escalate",
    decider: "human_only",
    reason,
  }),
  no_progress: (reason) => ({ action: "continue", reason }),
  reviewer_failure: (reason) => ({ action: "small_model_reviewer", reason }),
  conflict: (reason) => ({ action: "park", reason }),
  approval_crosscheck: (reason) => ({ action: "accept_verdict", reason }),
};

/**
 * The decision to take when jev is unreachable, errors, or answers
 * unparseably. Each site's fallback is the option that loses the least: ask a
 * human, keep looping, review again, park the merge, keep the verdict.
 */
export function degradedResult<Site extends JevSite>(
  site: Site,
  reason = "jev unavailable",
): JevDecisionBySite[Site] {
  return DEGRADED[site](reason);
}
