import { describe, expect, it } from "vitest";
import {
  approvalCrosscheck,
  conflict,
  degradedResult,
  escalation,
  noProgress,
  reviewerFailure,
  type ConflictKind,
  type EscalationDecider,
  type JevChoiceAnswer,
  type ReviewerFailureKind,
} from "./jev-questions.js";

function choice<Label extends string>(
  label: Label,
  confidence: number,
): JevChoiceAnswer<Label> {
  return { choice: label, probabilities: { [label]: confidence }, confidence };
}

describe("escalation routing", () => {
  it("refuses to escalate a question the worktree already answers", () => {
    const decision = escalation.route({
      needs_outside_input: { bool: 0.42 },
      decider: choice<EscalationDecider>("human_only", 0.95),
    });

    expect(decision.action).toBe("refuse");
    expect(decision).toMatchObject({ reason: expect.stringContaining("0.42") });
  });

  it("refuses when the executor is named as the decider", () => {
    const decision = escalation.route({
      needs_outside_input: { bool: 0.99 },
      decider: choice<EscalationDecider>("self_resolvable", 0.9),
    });

    expect(decision.action).toBe("refuse");
  });

  it("sends a low-confidence decider to a human", () => {
    const decision = escalation.route({
      needs_outside_input: { bool: 0.9 },
      decider: choice<EscalationDecider>("orchestrator", 0.4),
    });

    expect(decision).toMatchObject({
      action: "escalate",
      decider: "human_only",
    });
  });

  it("escalates to the orchestrator when it is confidently the narrowest party", () => {
    const decision = escalation.route({
      needs_outside_input: { bool: 0.8 },
      decider: choice<EscalationDecider>("orchestrator", 0.85),
    });

    expect(decision).toMatchObject({
      action: "escalate",
      decider: "orchestrator",
    });
  });
});

describe("no-progress routing", () => {
  it("stops the loop when every current finding repeats a previous one", () => {
    const decision = noProgress.route({
      repeat_0: { bool: 0.91 },
      repeat_1: { bool: 0.74 },
      untouched_code: { bool: 0.2 },
    });

    expect(decision.action).toBe("stop_loop");
  });

  it("continues when one finding repeats and another is new", () => {
    const decision = noProgress.route({
      repeat_0: { bool: 0.95 },
      repeat_1: { bool: 0.1 },
      untouched_code: { bool: 0.15 },
    });

    expect(decision.action).toBe("continue");
  });

  it("stops the loop when the round left the named code untouched", () => {
    const decision = noProgress.route({
      repeat_0: { bool: 0.05 },
      untouched_code: { bool: 0.88 },
    });

    expect(decision.action).toBe("stop_loop");
  });

  it("continues on a round with no findings and a real diff", () => {
    const decision = noProgress.route({ untouched_code: { bool: 0.1 } });

    expect(decision.action).toBe("continue");
  });
});

describe("reviewer-failure routing", () => {
  it("reformats output that already names a located defect", () => {
    const decision = reviewerFailure.route({
      failure_kind: choice<ReviewerFailureKind>("prose_instead_of_json", 0.9),
      salvageable: { bool: 0.82 },
    });

    expect(decision.action).toBe("reformat");
  });

  it("drops the review when there was nothing to inspect", () => {
    const decision = reviewerFailure.route({
      failure_kind: choice<ReviewerFailureKind>("nothing_to_review", 0.8),
      salvageable: { bool: 0.1 },
    });

    expect(decision.action).toBe("drop_review");
  });

  it("re-reviews instead of dropping when the failure kind is uncertain", () => {
    const decision = reviewerFailure.route({
      failure_kind: choice<ReviewerFailureKind>("nothing_to_review", 0.35),
      salvageable: { bool: 0.1 },
    });

    expect(decision.action).toBe("small_model_reviewer");
  });

  it("re-reviews a refusal with nothing salvageable", () => {
    const decision = reviewerFailure.route({
      failure_kind: choice<ReviewerFailureKind>("refused", 0.9),
      salvageable: { bool: 0.05 },
    });

    expect(decision.action).toBe("small_model_reviewer");
  });
});

describe("conflict routing", () => {
  it("hands a textual conflict back to the executor", () => {
    const decision = conflict.route({
      conflict_kind: choice<ConflictKind>("textual", 0.9),
      lane_can_resolve_alone: { bool: 0.77 },
    });

    expect(decision.action).toBe("executor_rebase");
  });

  it("parks a semantic conflict even when the lane claims it can rebase alone", () => {
    const decision = conflict.route({
      conflict_kind: choice<ConflictKind>("semantic", 0.83),
      lane_can_resolve_alone: { bool: 0.97 },
    });

    expect(decision.action).toBe("park");
  });

  it("parks a structural conflict even when the lane claims it can rebase alone", () => {
    const decision = conflict.route({
      conflict_kind: choice<ConflictKind>("structural", 0.7),
      lane_can_resolve_alone: { bool: 0.99 },
    });

    expect(decision.action).toBe("park");
  });

  it("parks a textual conflict the lane cannot reapply alone", () => {
    const decision = conflict.route({
      conflict_kind: choice<ConflictKind>("textual", 0.9),
      lane_can_resolve_alone: { bool: 0.4 },
    });

    expect(decision.action).toBe("park");
  });

  it("parks when the conflict kind itself is uncertain", () => {
    const decision = conflict.route({
      conflict_kind: choice<ConflictKind>("textual", 0.45),
      lane_can_resolve_alone: { bool: 0.95 },
    });

    expect(decision.action).toBe("park");
  });
});

describe("approval cross-check routing", () => {
  it("overrides an approval that contradicts a blocking finding", () => {
    const decision = approvalCrosscheck.route(
      { blocking_defect_present: { bool: 0.85 } },
      true,
    );

    expect(decision.action).toBe("override_to_not_approved");
  });

  it("accepts an approval whose findings are cosmetic", () => {
    const decision = approvalCrosscheck.route(
      { blocking_defect_present: { bool: 0.2 } },
      true,
    );

    expect(decision.action).toBe("accept_verdict");
  });

  it("never touches a verdict that is already not approved", () => {
    const decision = approvalCrosscheck.route(
      { blocking_defect_present: { bool: 0.99 } },
      false,
    );

    expect(decision.action).toBe("accept_verdict");
  });
});

describe("degraded results", () => {
  it.each([
    ["escalation", "escalate"],
    ["no_progress", "continue"],
    ["reviewer_failure", "small_model_reviewer"],
    ["conflict", "park"],
    ["approval_crosscheck", "accept_verdict"],
  ] as const)("falls back to %s -> %s", (site, action) => {
    expect(degradedResult(site, "jev timed out")).toMatchObject({
      action,
      reason: "jev timed out",
    });
  });
});
