/*
 * Lane orchestration: N independent work lanes, each in its own managed
 * worktree, each reviewed by a fresh reviewer per round, then merged
 * sequentially — in DECLARED lane order — into one integration branch.
 *
 * args
 * ----
 * args.lanes              (required) non-empty array of lane specs.
 * args.lanes[].label      lane name; used in labels, logs and results.
 *                         Defaults to "lane-<n>".
 * args.lanes[].prompt     (required) the lane's task. A lane without a
 *                         non-empty prompt resolves as "failed".
 * args.lanes[].coder      {provider, model, reasoningLevel} for the lane's
 *                         executor. All three or none — a partial tuple is
 *                         dropped (with a log) and the origin thread's
 *                         selection is inherited.
 * args.lanes[].reviewer   same tuple for the lane's reviewers. `null` disables
 *                         review entirely (lane is tagged unreviewed);
 *                         omitted inherits the origin selection.
 * args.lanes[].maxRounds  review-round cap, clamped to 1..5, default 5.
 * args.baseBranch         (optional) branch every lane worktree and the
 *                         integration worktree are cut from. Omit it and BB
 *                         cuts from the run's origin environment HEAD captured
 *                         at launch; a run refuses to start over a dirty origin
 *                         workspace, so every lane starts at that same committed
 *                         snapshot even if the origin branch advances later.
 * args.runId              run identifier, echoed in the result. Defaults to
 *                         "run".
 * args.integrator         optional {provider, model, reasoningLevel} for the
 *                         per-merge integrator agents; inherits when absent.
 *
 * Branch names are BB's, not the caller's: BB creates every lane worktree and
 * the integration worktree with `git worktree add -B <name it generates>` and
 * hands the name back as `branchName` on the reportIdentity report. Nothing
 * here may invent a branch name or ask an agent to create or check one out.
 *
 * no-changes precedence: reportIdentity also returns `changedFiles`, the
 * number of files the lane's committed work changes against its base. When it
 * is not null it decides — changedFiles === 0 resolves the lane as no-changes
 * and skips both review and merge. The executor's own `changed:false` schema
 * field is consulted only when changedFiles is null.
 *
 * lane exit statuses
 * ------------------
 * succeeded   no blocking reviewer findings remain (or the lane is unreviewed) and,
 *             when it had changes, the merge into the integration branch landed.
 * failed      the lane spec was unusable, or its executor/reviewer call
 *             errored out.
 * blocked     admission was impossible inside the agent-call budget, or the
 *             merge still conflicted after the lane's one rebase attempt.
 *             `conflictedPaths` carries the paths.
 * unresolved  the review round cap was exhausted with blocking findings still
 *             outstanding; `findings` carries them. Never merged.
 * no-changes  the lane's committed work touches no file: BB reported
 *             changedFiles === 0, or — only when BB reported no count — the
 *             executor set changed=false. Never reviewed, never merged.
 *
 * findings, notes and unaddressedRounds
 * -------------------------------------
 * `findings` is NOT a pure blocking list. On a succeeded lane it carries the
 * minor findings the last reviewer left behind; on an unresolved lane it
 * carries the outstanding blocking findings FOLLOWED BY that round's minor
 * ones (blocking.concat(minor)). Read each entry's `severity` — never the
 * array's length — to count blockers.
 * `notes` is append-only and records every decision the script made on a
 * lane's behalf: a reviewer verdict the script gate overrode, a host file
 * count that beat the executor's `changed` flag, a fix round whose executor
 * answered `addressed:false`, and a rebase that answered `resolved:false`
 * before the second merge ran. `reason` is a single line and the merge step
 * rewrites it with "merged into <branch>", so an override recorded only
 * there would be erased; `notes` is never overwritten, which keeps the
 * override recoverable from the result object and not only from the log.
 * `unaddressedRounds` lists the fix rounds the executor said it could not
 * address, and is present only when there was at least one: a lane that ends
 * unresolved because its executor gave up is a different failure from one
 * whose reviewer kept finding new problems, and its `reason` says so.
 *
 * Reserve accounting: a lane's worst case is
 *   1 executor + maxRounds reviewers + maxRounds executor continuations
 *   + 1 rebase + 1 integrator  =  2 * maxRounds + 3   (13 at maxRounds = 5)
 * A new lane only opens when the unreserved remainder of the call budget
 * covers its worst case; otherwise it waits for an in-flight lane to tighten
 * or release its reserve, and every deferral is logged with the numbers. When
 * no lane can tighten any further, the candidate opens on whatever is free
 * above the finished lanes' integration slots — its review rounds then check
 * the budget per call — or, with nothing free, resolves as "blocked" instead
 * of dying mid-call. The single conflict re-merge attempt is likewise guarded
 * at call time rather than reserved up front.
 */
export const meta = {
  name: "lanes",
  description:
    "Run independent lanes in parallel worktrees, ralph-loop each against a fresh reviewer, then merge lanes sequentially into one integration branch",
  phases: [
    { title: "Preflight" },
    { title: "Execute" },
    { title: "Review" },
    { title: "Integrate" },
  ],
};

const MAX_ROUNDS_CEILING = 5;
const DEFAULT_MAX_ROUNDS = 5;
// Smallest useful lane: one executor plus one integrator.
const MIN_LANE_CALLS = 2;

const EXEC_SCHEMA = {
  type: "object",
  required: ["changed", "summary"],
  properties: {
    changed: { type: "boolean" },
    summary: { type: "string" },
  },
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["approved", "findings"],
  properties: {
    approved: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "finding"],
        properties: {
          severity: { enum: ["blocking", "minor"] },
          file: { type: "string" },
          line: { type: "number" },
          finding: { type: "string" },
        },
      },
    },
  },
};

const FIX_SCHEMA = {
  type: "object",
  required: ["addressed"],
  properties: {
    addressed: { type: "boolean" },
    summary: { type: "string" },
  },
};

const MERGE_SCHEMA = {
  type: "object",
  required: ["merged", "conflictedPaths", "conflictHunks"],
  properties: {
    merged: { type: "boolean" },
    conflictedPaths: { type: "array", items: { type: "string" } },
    conflictHunks: { type: "string" },
  },
};

const REBASE_SCHEMA = {
  type: "object",
  required: ["resolved"],
  properties: {
    resolved: { type: "boolean" },
    summary: { type: "string" },
  },
};

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error) {
  if (error && typeof error === "object" && text(error.message) !== "") {
    return text(error.message);
  }
  return String(error);
}

function normalizeSelection(value, where) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") {
    log('lanes: ignoring non-object agent selection on ' + where);
    return {};
  }
  const provider = text(value.provider);
  const model = text(value.model);
  const reasoningLevel = text(value.reasoningLevel);
  if (provider !== "" && model !== "" && reasoningLevel !== "") {
    return { provider: provider, model: model, reasoningLevel: reasoningLevel };
  }
  if (provider !== "" || model !== "" || reasoningLevel !== "") {
    log(
      "lanes: ignoring partial agent selection on " +
        where +
        " — provider, model and reasoningLevel must all be set",
    );
  }
  return {};
}

function normalizeLane(raw, index) {
  const spec = {
    index: index,
    label: "lane-" + (index + 1),
    prompt: "",
    coder: {},
    reviewer: {},
    skipReview: false,
    maxRounds: DEFAULT_MAX_ROUNDS,
    error: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    spec.error = "lane spec is not an object";
    return spec;
  }
  if (text(raw.label) !== "") spec.label = text(raw.label);
  spec.prompt = text(raw.prompt);
  if (spec.prompt === "") spec.error = "lane spec has no non-empty prompt";
  spec.coder = normalizeSelection(raw.coder, "coder of " + spec.label);
  if (raw.reviewer === null) {
    spec.skipReview = true;
  } else {
    spec.reviewer = normalizeSelection(raw.reviewer, "reviewer of " + spec.label);
  }
  const rounds = Number(raw.maxRounds);
  if (Number.isFinite(rounds) && rounds >= 1) {
    spec.maxRounds = Math.min(Math.floor(rounds), MAX_ROUNDS_CEILING);
  }
  return spec;
}

function laneWorstCase(maxRounds) {
  // executor + reviewers + executor continuations + rebase + integrator
  return 1 + maxRounds + maxRounds + 1 + 1;
}

function formatFindings(findings) {
  if (findings.length === 0) return "  (none reported)";
  return findings
    .map(function (finding) {
      const where =
        text(finding.file) === "" ? "(file unspecified)" : text(finding.file);
      const line = Number.isFinite(Number(finding.line))
        ? ":" + Math.floor(Number(finding.line))
        : "";
      return "  - " + where + line + " — " + text(finding.finding);
    })
    .join("\n");
}

function normalizeFindings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    out.push({
      severity: entry.severity === "blocking" ? "blocking" : "minor",
      file: text(entry.file),
      line: Number.isFinite(Number(entry.line))
        ? Math.floor(Number(entry.line))
        : null,
      finding: text(entry.finding),
    });
  }
  return out;
}

function blockingOf(findings) {
  return findings.filter(function (finding) {
    return finding.severity === "blocking";
  });
}

function minorOf(findings) {
  return findings.filter(function (finding) {
    return finding.severity !== "blocking";
  });
}

if (!args || typeof args !== "object" || Array.isArray(args)) {
  throw new Error("lanes: args must be an object");
}
if (!Array.isArray(args.lanes) || args.lanes.length === 0) {
  throw new Error("lanes: args.lanes must be a non-empty array of lane specs");
}
// Optional: an empty baseBranch means "the branch the run's origin
// environment is on". BB resolves it and refuses to start a run over a dirty
// origin workspace, so that branch tip is the orchestrator's own commit.
const baseBranch = text(args.baseBranch);
const runId = text(args.runId) === "" ? "run" : text(args.runId);
// BB names the branches it creates. The integration branch name is unknown
// until the first integrator worktree reports its identity.
let integrationBranchName = null;

function worktreeEnvironment() {
  return baseBranch === ""
    ? { worktree: {} }
    : { worktree: { baseBranch: baseBranch } };
}
const integratorSelection = normalizeSelection(args.integrator, "args.integrator");

const laneSpecs = args.lanes.map(normalizeLane);

phase("Preflight");
const reviewedLabels = laneSpecs
  .filter(function (spec) {
    return !spec.skipReview && spec.error === null;
  })
  .map(function (spec) {
    return spec.label;
  });
const rejected = laneSpecs.filter(function (spec) {
  return spec.error !== null;
});
log(
  "lanes: " +
    laneSpecs.length +
    " lane(s) cut from " +
    (baseBranch === "" ? "the origin environment's branch" : baseBranch) +
    "; BB names the integration branch when the first merge opens its worktree" +
    "; review enabled on " +
    (reviewedLabels.length === 0 ? "none" : reviewedLabels.join(", ")) +
    (rejected.length === 0
      ? ""
      : "; rejected specs: " +
        rejected
          .map(function (spec) {
            return spec.label + " (" + spec.error + ")";
          })
          .join(", ")),
);

const budgetSnapshot = budget();
const callCap = Number.isFinite(Number(budgetSnapshot.maxAgentCalls))
  ? Number(budgetSnapshot.maxAgentCalls)
  : Infinity;
log(
  "lanes: agent-call budget " +
    (callCap === Infinity ? "unbounded" : String(callCap)) +
    ", worst case per lane = 2 * maxRounds + 3 (" +
    laneSpecs
      .map(function (spec) {
        return spec.label + ":" + laneWorstCase(spec.maxRounds);
      })
      .join(" ") +
    ")",
);

// ---------------------------------------------------------------- reserves
// Each lane holds an upper bound on the agent calls it may still make. Lanes
// only open when the unreserved remainder covers their own worst case; a
// reserve that shrinks — or a lane that parks — wakes every lane waiting for
// admission. A lane is ACTIVE while it can still spend calls on its own and
// PARKED once only its rebase/integrator slots remain: waiting is pointless
// when no active lane is left, so the last candidate opens on a degraded
// reserve instead of deadlocking behind parked lanes.
const reserves = new Map();
const activeLanes = new Set();
let waiters = [];

function callsRemaining() {
  if (callCap === Infinity) return Infinity;
  const snapshot = budget();
  const used = Number(snapshot.agentCalls);
  return callCap - (Number.isFinite(used) ? used : 0);
}

function totalReserved() {
  let total = 0;
  for (const held of reserves.values()) total += held;
  return total;
}

function wakeWaiters() {
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

function waitForReserveChange() {
  return new Promise(function (resolve) {
    waiters.push(resolve);
  });
}

function writeReserve(key, value, active) {
  const next = Math.max(0, value);
  const previous = reserves.has(key) ? reserves.get(key) : Infinity;
  const wasActive = activeLanes.has(key);
  reserves.set(key, next);
  if (active) activeLanes.add(key);
  else activeLanes.delete(key);
  if (next < previous || (wasActive && !active)) wakeWaiters();
}

function setReserve(key, value) {
  writeReserve(key, value, true);
}

function parkReserve(key, value) {
  writeReserve(key, value, false);
}

function releaseReserve(key) {
  const held = reserves.delete(key);
  const wasActive = activeLanes.delete(key);
  if (held || wasActive) wakeWaiters();
}

function canSpend(calls) {
  return callsRemaining() >= calls;
}

async function admit(spec) {
  const need = laneWorstCase(spec.maxRounds);
  for (;;) {
    if (callCap === Infinity) {
      setReserve(spec.index, need);
      return { ok: true, reason: "" };
    }
    const remaining = callsRemaining();
    const reserved = totalReserved();
    // Synchronous check plus registration: no other lane can interleave here.
    if (remaining - reserved >= need) {
      setReserve(spec.index, need);
      return { ok: true, reason: "" };
    }
    if (activeLanes.size === 0) {
      // Nothing left that can shrink a reserve — open on what is free beyond
      // the parked lanes' integration slots, or refuse the lane outright.
      const free = remaining - reserved;
      if (free >= MIN_LANE_CALLS) {
        setReserve(spec.index, Math.min(need, free));
        log(
          "lanes: opening " +
            spec.label +
            " on a degraded reserve — remaining=" +
            remaining +
            ", reserved by parked lanes=" +
            reserved +
            ", free=" +
            free +
            ", worst case=" +
            need +
            ", floor=" +
            MIN_LANE_CALLS +
            "; its review rounds stop early if the budget runs low",
        );
        return { ok: true, reason: "" };
      }
      return {
        ok: false,
        reason:
          "agent-call budget exhausted before the lane opened: remaining=" +
          remaining +
          ", reserved by other lanes=" +
          reserved +
          ", minimum=" +
          MIN_LANE_CALLS,
      };
    }
    log(
      "lanes: deferring " +
        spec.label +
        " — remaining=" +
        remaining +
        ", reserved by " +
        activeLanes.size +
        " active lane(s)=" +
        reserved +
        ", free=" +
        (remaining - reserved) +
        ", worst case needed=" +
        need +
        " (includes its own integrator); waiting for an in-flight lane",
    );
    await waitForReserveChange();
  }
}

// ---------------------------------------------------------------- prompts
function executorPrompt(spec) {
  return (
    "Task: " +
    spec.prompt +
    "\n\nYou are lane " +
    spec.label +
    ". Work only inside this worktree, on the branch it is already checked out on — BB created and named that branch for you. Commit your work with a clear message. Do not create, rename or check out branches, and do not merge, rebase, push, or touch other branches. Do not run project-wide builds, linters, or full test suites; verify only the code you changed." +
    "\nSet changed=false only when the task genuinely needs no code change. summary: what you changed, the files touched, and how you verified it. Your structured result IS the return value."
  );
}

function reviewPrompt(spec, round) {
  return (
    "Review the committed work in this worktree. Lane " +
    spec.label +
    ", review round " +
    round +
    " of " +
    spec.maxRounds +
    "." +
    "\nOriginal task: " +
    spec.prompt +
    "\nRead the diff against the branch point and judge correctness, completeness against the task, and regressions. Do not edit any file. Do not run project-wide builds or full test suites." +
    "\nseverity=blocking means the task is not done or the change is wrong; anything optional is minor. Set approved=true when no blocking finding remains. Your structured result IS the return value."
  );
}

function fixPrompt(spec, round, blocking, minor) {
  return (
    "Review round " +
    round +
    " rejected the lane " +
    spec.label +
    " work." +
    "\nOriginal task: " +
    spec.prompt +
    "\nBlocking findings:\n" +
    formatFindings(blocking) +
    (minor.length === 0 ? "" : "\nMinor notes (optional):\n" + formatFindings(minor)) +
    "\nFix every blocking finding in this worktree and commit with a clear message. Do not argue with the findings; if one is wrong, prove it in your reply. Set addressed=true only when all blocking findings are handled. Your structured result IS the return value."
  );
}

// The integration branch is whatever BB named the first integrator worktree's
// branch. Until that identity comes back the only honest way to name it in a
// prompt is "the branch this worktree is already on".
function integrationName() {
  return integrationBranchName === null
    ? "the integration branch"
    : integrationBranchName;
}

function integrationTarget() {
  return integrationBranchName === null
    ? "the branch this worktree is already checked out on — BB created it for this run and it IS the integration branch"
    : "the integration branch " + integrationBranchName;
}

function mergePrompt(state, attempt) {
  return (
    "Integrate lane branches into " +
    integrationTarget() +
    "." +
    "\nStay on the branch this worktree is already on. Do not create, rename, or check out any branch, and do not invent a branch name." +
    "\nMerge branch " +
    state.branch +
    " into it with --no-ff." +
    (attempt > 1
      ? "\nSecond and final attempt: the lane has just rebased onto " +
        integrationName() +
        "."
      : "") +
    "\nDo not rewrite or rebase lane branches and do not resolve conflicts yourself. On conflict: abort the merge, report merged=false, the conflicted paths, and a conflictHunks excerpt of at most 40 lines. On success: merged=true, empty conflictedPaths, empty conflictHunks. Your structured result IS the return value."
  );
}

function rebasePrompt(state, paths, hunks) {
  return (
    "Merging lane " +
    state.lane +
    " into " +
    integrationName() +
    " conflicted. You get one rebase attempt." +
    "\nOriginal task: " +
    state.spec.prompt +
    "\nConflicted paths: " +
    (paths.length === 0 ? "(not reported)" : paths.join(", ")) +
    (text(hunks) === "" ? "" : "\nConflict excerpt:\n" + text(hunks)) +
    "\nRebase your lane branch — the branch this worktree is already on — onto " +
    integrationName() +
    ", resolve the conflicts while keeping your task's behavior, and commit with a clear message. Do not create or check out any other branch. Set resolved=true only if the rebase completed with no conflict left. Your structured result IS the return value."
  );
}

// ---------------------------------------------------------------- lanes
function newState(spec) {
  return {
    lane: spec.label,
    index: spec.index,
    status: "unresolved",
    reason: "",
    branch: null,
    environmentId: null,
    threadId: null,
    rounds: 0,
    findings: [],
    // Append-only record of what the script decided for this lane. The merge
    // step rewrites `reason`, so an override kept only there is lost.
    notes: [],
    // Fix rounds whose executor answered addressed:false.
    unaddressedRounds: [],
    // Review round whose approved:false the script gate overrode; 0 for none.
    gateOverrideRound: 0,
    unreviewed: spec.skipReview,
    conflictedPaths: [],
    spec: spec,
  };
}

function note(state, message) {
  state.notes.push(message);
  log("lanes: " + state.lane + " note — " + message);
}

// A lane whose executor kept answering addressed:false failed differently from
// one whose reviewer kept finding new problems. The reason line must say which.
function unaddressedClause(state) {
  if (state.unaddressedRounds.length === 0) return "";
  return (
    "; the executor reported addressed:false in fix round(s) " +
    state.unaddressedRounds.join(", ") +
    " — it could not address the findings"
  );
}

function isTerminal(state) {
  return (
    state.status === "failed" ||
    state.status === "blocked" ||
    state.status === "no-changes"
  );
}

async function openLane(spec) {
  const state = newState(spec);
  if (spec.error !== null) {
    state.status = "failed";
    state.reason = spec.error;
    return state;
  }
  const admission = await admit(spec);
  if (!admission.ok) {
    state.status = "blocked";
    state.reason = admission.reason;
    log("lanes: " + spec.label + " blocked — " + admission.reason);
    releaseReserve(spec.index);
    return state;
  }
  let identity = null;
  try {
    identity = await agent(
      executorPrompt(spec),
      Object.assign(
        {
          environment: worktreeEnvironment(),
          reportIdentity: true,
          phase: "Execute",
          label: "exec:" + spec.label,
          schema: EXEC_SCHEMA,
        },
        spec.coder,
      ),
    );
  } catch (error) {
    state.status = "failed";
    state.reason = "executor failed: " + errorText(error);
    releaseReserve(spec.index);
    log("lanes: " + spec.label + " failed — " + state.reason);
    return state;
  }
  const report =
    identity && typeof identity === "object" ? identity : { value: identity };
  state.threadId = text(report.threadId) === "" ? null : text(report.threadId);
  state.environmentId =
    text(report.environmentId) === "" ? null : text(report.environmentId);
  state.branch = text(report.branchName) === "" ? null : text(report.branchName);
  const changedFiles =
    report.changedFiles === null || report.changedFiles === undefined
      ? null
      : Number.isFinite(Number(report.changedFiles))
        ? Math.floor(Number(report.changedFiles))
        : null;
  const value = report.value;
  const selfReportedChange = !(
    value &&
    typeof value === "object" &&
    value.changed === false
  );
  // The host counts the lane's committed diff against its base — and it
  // auto-commits anything the worker left behind before this call resolved, so
  // the count is complete. It wins whenever it is known; the executor's own
  // flag is only the fallback for changedFiles === null.
  const changed = changedFiles === null ? selfReportedChange : changedFiles > 0;
  // The host's count is authoritative. When it contradicts the executor's own
  // flag the result has to say the script overrode the worker.
  if (changedFiles !== null && (changedFiles > 0) !== selfReportedChange) {
    note(
      state,
      "the host counted " +
        changedFiles +
        " changed file(s), which overrides the executor's changed=" +
        (selfReportedChange ? "true" : "false"),
    );
  }
  const summary =
    value && typeof value === "object" ? text(value.summary) : text(value);
  // Executor spent: reviewers + continuations + rebase + integrator remain.
  setReserve(spec.index, 2 * spec.maxRounds + 2);
  if (!changed) {
    state.status = "no-changes";
    const signal =
      changedFiles === null
        ? "executor reported no change needed"
        : "the lane's committed work changes no files";
    state.reason = summary === "" ? signal : signal + ": " + summary;
    releaseReserve(spec.index);
    log(
      "lanes: " +
        spec.label +
        " reported no changes (" +
        (changedFiles === null
          ? "no host file count; executor changed=false"
          : "changedFiles=0") +
        "); review and merge skipped",
    );
    return state;
  }
  state.reason = summary;
  if (state.branch === null) {
    log(
      "lanes: " +
        spec.label +
        " executor did not report a branch name; integration will be skipped",
    );
  }
  return state;
}

async function reviewLane(state) {
  if (!state || typeof state !== "object") return state;
  if (isTerminal(state)) {
    releaseReserve(state.index);
    return state;
  }
  const spec = state.spec;
  if (spec.skipReview) {
    state.status = "succeeded";
    state.reason = "unreviewed: no reviewer configured";
    // Only the rebase and integrator slots remain: park, do not hold the lane
    // open against other lanes' admission.
    parkReserve(spec.index, 2);
    return state;
  }
  if (state.environmentId === null) {
    state.status = "unresolved";
    state.reason =
      "executor did not report an environment id; no reviewer could be attached";
    state.findings = [];
    releaseReserve(spec.index);
    log("lanes: " + spec.label + " unresolved — " + state.reason);
    return state;
  }
  for (let round = 1; round <= spec.maxRounds; round += 1) {
    // Remaining worst case for this lane: the rounds left, plus rebase and
    // integrator.
    setReserve(spec.index, 2 * (spec.maxRounds - round + 1) + 2);
    if (!canSpend(1)) {
      state.status = "unresolved";
      state.reason =
        "agent-call budget exhausted before review round " +
        round +
        "; work is committed but unreviewed" +
        unaddressedClause(state);
      releaseReserve(spec.index);
      log("lanes: " + spec.label + " unresolved — " + state.reason);
      return state;
    }
    let review = null;
    try {
      review = await agent(
        reviewPrompt(spec, round),
        Object.assign(
          {
            environment: { environmentId: state.environmentId },
            phase: "Review",
            label: "review:" + spec.label + ":" + round,
            schema: REVIEW_SCHEMA,
          },
          spec.reviewer,
        ),
      );
    } catch (error) {
      state.status = "failed";
      state.rounds = round;
      state.reason =
        "reviewer failed in round " + round + ": " + errorText(error);
      releaseReserve(spec.index);
      log("lanes: " + spec.label + " failed — " + state.reason);
      return state;
    }
    state.rounds = round;
    const findings = normalizeFindings(
      review && typeof review === "object" ? review.findings : null,
    );
    const blocking = blockingOf(findings);
    const minor = minorOf(findings);
    const approved = !!(review && typeof review === "object" && review.approved);
    // The script owns the gate: blocking findings always require another round,
    // even when the reviewer's approval flag contradicts them.
    if (blocking.length === 0) {
      state.status = "succeeded";
      state.findings = minor;
      state.reason = approved
        ? "approved in review round " + round
        : "review round " +
          round +
          " reported no blocking finding; approved by the script gate";
      if (!approved) {
        state.gateOverrideRound = round;
        note(
          state,
          "reviewer returned approved:false but reported no blocking finding" +
            " in review round " +
            round +
            "; approved by the script gate with " +
            minor.length +
            " minor finding(s) carried into findings",
        );
      }
      parkReserve(spec.index, 2);
      if (minor.length > 0) {
        log(
          "lanes: " +
            spec.label +
            " approved with " +
            minor.length +
            " minor note(s) carried into the result",
        );
      }
      return state;
    }
    if (approved) {
      note(
        state,
        "reviewer returned approved:true with " +
          blocking.length +
          " blocking finding(s) in review round " +
          round +
          "; rejected by the script gate",
      );
    }
    if (round >= spec.maxRounds) {
      state.status = "unresolved";
      state.findings = blocking.concat(minor);
      state.reason =
        "review round cap reached (" +
        spec.maxRounds +
        ") with " +
        blocking.length +
        " blocking finding(s) outstanding" +
        unaddressedClause(state);
      releaseReserve(spec.index);
      log(
        "lanes: " +
          spec.label +
          " UNRESOLVED — exhausted " +
          spec.maxRounds +
          " review round(s) with " +
          blocking.length +
          " blocking finding(s) still open; not integrated",
      );
      return state;
    }
    if (state.threadId === null) {
      state.status = "unresolved";
      state.findings = blocking.concat(minor);
      state.reason =
        "review round " +
        round +
        " rejected the work but the executor thread id is unknown, so no fix round could be sent";
      releaseReserve(spec.index);
      log("lanes: " + spec.label + " unresolved — " + state.reason);
      return state;
    }
    if (!canSpend(1)) {
      state.status = "unresolved";
      state.findings = blocking.concat(minor);
      state.reason =
        "agent-call budget exhausted before fix round " +
        round +
        " with " +
        blocking.length +
        " blocking finding(s) outstanding" +
        unaddressedClause(state);
      releaseReserve(spec.index);
      log("lanes: " + spec.label + " unresolved — " + state.reason);
      return state;
    }
    let fix = null;
    try {
      fix = await agent(
        fixPrompt(spec, round, blocking, minor),
        Object.assign(
          {
            continue: state.threadId,
            phase: "Review",
            label: "fix:" + spec.label + ":" + round,
            schema: FIX_SCHEMA,
          },
          spec.coder,
        ),
      );
    } catch (error) {
      state.status = "failed";
      state.findings = blocking.concat(minor);
      state.reason =
        "fix round " +
        round +
        " failed: " +
        errorText(error) +
        unaddressedClause(state);
      releaseReserve(spec.index);
      log("lanes: " + spec.label + " failed — " + state.reason);
      return state;
    }
    // addressed=false is the executor's own admission that it could not clear
    // the findings. The next reviewer still decides, but the admission must
    // reach the result: it is why the lane ends unresolved.
    const fixValue = fix && typeof fix === "object" ? fix : {};
    if (fixValue.addressed === false) {
      state.unaddressedRounds.push(round);
      note(
        state,
        "fix round " +
          round +
          " reported addressed:false" +
          (text(fixValue.summary) === "" ? "" : ": " + text(fixValue.summary)),
      );
    }
    log(
      "lanes: " +
        spec.label +
        " round " +
        round +
        " rejected with " +
        blocking.length +
        " blocking finding(s); executor is fixing in place",
    );
  }
  state.status = "unresolved";
  state.reason = "review loop ended without a verdict";
  releaseReserve(spec.index);
  return state;
}

const settled = await pipeline(
  laneSpecs,
  function (spec) {
    return openLane(spec);
  },
  function (state, spec) {
    return reviewLane(state || newState(spec));
  },
);

// A dropped pipeline item becomes null; a lane must never read as absent.
const laneStates = laneSpecs.map(function (spec, index) {
  const value = Array.isArray(settled) ? settled[index] : null;
  if (value && typeof value === "object" && typeof value.status === "string") {
    return value;
  }
  const fallback = newState(spec);
  fallback.status = "failed";
  fallback.reason =
    spec.error === null
      ? "lane produced no result (its stage threw and the item was dropped)"
      : spec.error;
  log("lanes: " + spec.label + " failed — " + fallback.reason);
  return fallback;
});
for (const spec of laneSpecs) releaseReserve(spec.index);

// ---------------------------------------------------------------- integrate
phase("Integrate");
let integrationEnvironmentId = null;

async function attemptMerge(state, attempt) {
  const options = Object.assign(
    {
      phase: "Integrate",
      label:
        "integrate:" + state.lane + (attempt > 1 ? ":retry" : ""),
      schema: MERGE_SCHEMA,
    },
    integratorSelection,
  );
  if (integrationEnvironmentId === null) {
    options.environment = worktreeEnvironment();
    options.reportIdentity = true;
  } else {
    options.environment = { environmentId: integrationEnvironmentId };
  }
  const raw = await agent(mergePrompt(state, attempt), options);
  let value = raw;
  if (options.reportIdentity === true) {
    const report = raw && typeof raw === "object" ? raw : { value: raw };
    if (text(report.environmentId) !== "") {
      integrationEnvironmentId = text(report.environmentId);
    }
    if (text(report.branchName) !== "") {
      integrationBranchName = text(report.branchName);
      log("lanes: BB named the integration branch " + integrationBranchName);
    }
    value = report.value;
  }
  const merged = !!(value && typeof value === "object" && value.merged);
  const conflictedPaths =
    value && typeof value === "object" && Array.isArray(value.conflictedPaths)
      ? value.conflictedPaths.filter(function (path) {
          return text(path) !== "";
        })
      : [];
  const conflictHunks =
    value && typeof value === "object" ? text(value.conflictHunks) : "";
  return {
    merged: merged,
    conflictedPaths: conflictedPaths,
    conflictHunks: conflictHunks,
  };
}

// This is where `reason` becomes "merged into <branch>", so anything the
// script decided earlier about this lane has to survive in `notes`.
function recordMerge(state, suffix) {
  state.reason = "merged into " + integrationName() + suffix;
  if (state.gateOverrideRound > 0) {
    note(
      state,
      "merged by the script gate over review round " +
        state.gateOverrideRound +
        "'s approved:false verdict; " +
        state.findings.length +
        " minor finding(s) stay in findings",
    );
  }
}

// Strictly sequential, in declared lane order — not completion order.
for (const state of laneStates) {
  if (state.status !== "succeeded") {
    log(
      "lanes: skipping integration of " +
        state.lane +
        " (status " +
        state.status +
        ")",
    );
    continue;
  }
  if (state.branch === null) {
    state.status = "blocked";
    state.reason = "no lane branch to merge: the executor reported no branch name";
    log("lanes: " + state.lane + " blocked — " + state.reason);
    continue;
  }
  if (!canSpend(1)) {
    state.status = "blocked";
    state.reason =
      "agent-call budget exhausted before integrating " + state.branch;
    log("lanes: " + state.lane + " blocked — " + state.reason);
    continue;
  }
  let outcome = null;
  try {
    outcome = await attemptMerge(state, 1);
  } catch (error) {
    state.status = "blocked";
    state.reason = "integrator failed: " + errorText(error);
    log("lanes: " + state.lane + " blocked — " + state.reason);
    continue;
  }
  if (outcome.merged) {
    recordMerge(state, "");
    continue;
  }
  log(
    "lanes: " +
      state.lane +
      " conflicted on " +
      (outcome.conflictedPaths.length === 0
        ? "unreported paths"
        : outcome.conflictedPaths.join(", ")) +
      "; sending one rebase attempt to its executor",
  );
  if (state.threadId === null || integrationBranchName === null || !canSpend(2)) {
    state.status = "blocked";
    state.conflictedPaths = outcome.conflictedPaths;
    state.reason =
      state.threadId === null
        ? "merge conflicted and the executor thread id is unknown, so no rebase could be attempted"
        : integrationBranchName === null
          ? "merge conflicted and BB reported no integration branch name, so the rebase had no target to name"
          : "merge conflicted and the agent-call budget cannot cover a rebase plus a second merge";
    log("lanes: " + state.lane + " blocked — " + state.reason);
    continue;
  }
  let rebase = null;
  try {
    rebase = await agent(
      rebasePrompt(state, outcome.conflictedPaths, outcome.conflictHunks),
      Object.assign(
        {
          continue: state.threadId,
          phase: "Integrate",
          label: "rebase:" + state.lane,
          schema: REBASE_SCHEMA,
        },
        state.spec.coder,
      ),
    );
  } catch (error) {
    state.status = "blocked";
    state.conflictedPaths = outcome.conflictedPaths;
    state.reason = "rebase attempt failed: " + errorText(error);
    log("lanes: " + state.lane + " blocked — " + state.reason);
    continue;
  }
  if (rebase && typeof rebase === "object" && rebase.resolved === false) {
    note(
      state,
      "rebase reported resolved:false; the script sent the second merge anyway and that attempt decides",
    );
  }
  let retry = null;
  try {
    retry = await attemptMerge(state, 2);
  } catch (error) {
    state.status = "blocked";
    state.conflictedPaths = outcome.conflictedPaths;
    state.reason = "second integrator failed: " + errorText(error);
    log("lanes: " + state.lane + " blocked — " + state.reason);
    continue;
  }
  if (retry.merged) {
    recordMerge(state, " after one rebase");
    continue;
  }
  state.status = "blocked";
  state.conflictedPaths =
    retry.conflictedPaths.length > 0 ? retry.conflictedPaths : outcome.conflictedPaths;
  state.reason =
    "still conflicting after one rebase: " +
    (state.conflictedPaths.length === 0
      ? "paths not reported"
      : state.conflictedPaths.join(", "));
  log(
    "lanes: " +
      state.lane +
      " BLOCKED — " +
      state.reason +
      "; integration continues with the remaining lanes",
  );
}

// ---------------------------------------------------------------- result
const lanes = laneStates.map(function (state) {
  const result = {
    lane: state.lane,
    status: state.status,
    reason: state.reason,
    branch: state.branch,
    environmentId: state.environmentId,
    threadId: state.threadId,
    rounds: state.rounds,
    findings: state.findings,
    // Blocking and minor entries share `findings`; `notes` carries the
    // script's own overrides, which the one-line `reason` cannot hold.
    notes: state.notes,
    unreviewed: state.unreviewed,
  };
  if (state.unaddressedRounds.length > 0) {
    result.unaddressedRounds = state.unaddressedRounds;
  }
  if (state.conflictedPaths.length > 0) {
    result.conflictedPaths = state.conflictedPaths;
  }
  return result;
});

function countStatus(status) {
  return lanes.filter(function (result) {
    return result.status === status;
  }).length;
}

const summary = {
  succeeded: countStatus("succeeded"),
  failed: countStatus("failed"),
  blocked: countStatus("blocked"),
  unresolved: countStatus("unresolved"),
  noChanges: countStatus("no-changes"),
};

log(
  "lanes: done — succeeded=" +
    summary.succeeded +
    " failed=" +
    summary.failed +
    " blocked=" +
    summary.blocked +
    " unresolved=" +
    summary.unresolved +
    " no-changes=" +
    summary.noChanges,
);

return {
  runId: runId,
  integrationBranchName: integrationBranchName,
  lanes: lanes,
  summary: summary,
  reportHint:
    summary.succeeded +
    "/" +
    lanes.length +
    " lane(s) merged into " +
    (integrationBranchName === null
      ? "no integration branch (BB never opened an integration worktree — nothing was integrated)"
      : integrationBranchName) +
    "; inspect unresolved lanes' findings and blocked lanes' conflictedPaths before reporting success",
};
