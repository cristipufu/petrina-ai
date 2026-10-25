import { promptContext, promptTask } from "../../fixtures/prompt-context.js";
import { addRole, draftOf, editRole, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS } from "@petrina/core";
import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, DEMO_PRODUCTS, FINDING_CONFIRMATION_RULE, FINDING_REQUIREMENT_RULE, FINDING_REVIEW_RULES, MAINTENANCE_ROLES, NOTES_HANDOFF_RULE, REPAIR_RULE, VERIFIER_RULES } from "@petrina/core";
import { ASK_FOR_SCREEN, BACKGROUND, buildPrompt, continuePrompt, FOCUSED_VERIFICATION, formatFindings, formatWhereYouWere, handBackNote, handBackPrompt, INVESTIGATION_RULE, LOGINS, mayAskScreen, parseResult, PREPARED_REVIEW, restartPrompt, screenPrompt, screenRules } from "../../../src/prompts.js";
import { NotesResult } from "../../../src/roles.js";
import { inputManifest, numberInputManifest } from "../../../src/input-manifest.js";
import { findingReviewCases } from "../../finding-review-cases.js";

const task = promptTask();
const context = promptContext;
const promptFor = (role: (typeof BUILT_IN_ROLES)[number], screen?: "ask" | { reason: string }) => buildPrompt(context(role, screen));

describe("prompts", () => {
  it("manifests the actual standard, automatic and supplied pieces of fresh and continued messages", () => {
    const ctx = { ...context(BUILT_IN_ROLES.find(role => role.result === "notes")!), task: { ...task, repositories: [{ productId: "api", delivery: "local" as const, completedStages: [], baseSha: "api-base" }] }, sections: [{ title: "Research brief", body: "Find the actual host deadline" }] };
    for (const continued of [false, true]) {
      let manifest: ReturnType<typeof inputManifest> = [];
      const recordJob = (job: string, supplied: readonly { title: string; body: string }[]) => {
        manifest = inputManifest(job, supplied, [], true);
        for (const section of supplied) expect(sent.includes(section.body)).toBe(true);
      };
      // Inspect the captured pieces after construction: they are the same values used to assemble the message.
      let captured: Parameters<typeof recordJob> | undefined;
      const capture = (...args: Parameters<typeof recordJob>) => { captured = args; };
      const sent = continued ? continuePrompt(ctx, { recordJob: capture }) : buildPrompt(ctx, capture);
      recordJob(...captured!);
      expect(manifest.map(entry => entry.name)).toEqual(expect.arrayContaining(["Role instructions", "Research brief", "Complete approved product map and responsibility", "Investigation rules", "Progress reporting", "Result instructions"]));
      if (continued) expect(manifest.map(entry => entry.name)).not.toContain("Task request");
      else expect(manifest.map(entry => entry.name)).toEqual(expect.arrayContaining(["Background and screen rules", "Logins and publishing rules", "Verification rules", "Task request"]));
      expect(manifest.find(entry => entry.name === "Research brief")!.size).toBe(ctx.sections[0]!.body.length);
    }
    const duplicates = inputManifest("job", [{ title: "Background", body: "changed" }], [{ title: "Background", digest: "one" }, { title: "Background", digest: "two" }]);
    expect(duplicates.filter(entry => entry.name === "Background").map(entry => entry.occurrence)).toEqual([1, 2, 3]);
    expect(duplicates.filter(entry => entry.kind === "omitted").map(entry => entry.size)).toEqual([0, 0]);
    const automatic = numberInputManifest([...inputManifest("job", [{ title: "Browser instructions", body: "Supplied context" }]), ...inputManifest("", [{ title: "Browser instructions", body: "Automatic browser rules" }], [], true)]);
    expect(automatic.filter(entry => entry.name === "Browser instructions").map(entry => entry.occurrence)).toEqual([1, 2]);
  });

  it("describes hand-back time from the supplied duration, independently of process startup", () => {
    for (const [took, duration] of [[0, "less than a minute"], [29_999, "less than a minute"], [30_000, "1 minute"], [90_000, "2 minutes"], [90 * 60_000, "2 hours"]] as const) {
      const note = handBackNote({ role: "Builder", tool: "Codex", took, commits: 0, files: [], leftovers: false, note: "" });
      expect(note.split("\n")[0]).toBe(`Handed back after driving the Builder by hand in the terminal (Codex) for ${duration}.`);
    }
  });

  it("requires evidence and web research across roles and continuation paths without duplicating the rule", () => {
    const custom = { ...BUILT_IN_ROLES.find(role => role.id === "code-reviewer")!, id: "custom-review", name: "An added reviewer" };
    for (const role of [...BUILT_IN_ROLES, custom]) for (const prompt of [buildPrompt(context(role)), continuePrompt(context(role))]) {
      expect(prompt.split(INVESTIGATION_RULE)).toHaveLength(2);
      expect(prompt).toContain("search the web");
      expect(prompt).toContain("Check that sources apply to the installed version");
      expect(prompt).toContain("Never present an assumption as a fact");
    }
    for (const prompt of [restartPrompt({ stage: "Review", role: "Reviewer", done: [] }, { messages: [] }), screenPrompt("Check the app", []), handBackPrompt("Updated the page", [])]) {
      expect(prompt.split(INVESTIGATION_RULE)).toHaveLength(2);
    }
  });
  it("instructs fresh and continued roles to propose durable working rules rather than task history or old specifications", () => {
    const custom = { ...BUILT_IN_ROLES.find(role => role.id === "code-reviewer")!, id: "custom-lessons", name: "An added reviewer" };
    const roles = [...BUILT_IN_ROLES.filter(role => ["builder", "tester", "code-reviewer", "security-reviewer"].includes(role.id)), custom];
    for (const role of roles) for (const prompt of [buildPrompt(context(role)), continuePrompt(context(role))]) {
      expect(prompt).toContain("verified, durable rules for working in this repository");
      expect(prompt).toContain("Never propose task history, delivery summaries, historical comparisons, older feature briefs");
      expect(prompt).toContain("The coordinator approves every line before it joins AGENTS.md");
    }
  });
  it("gives built-in and Library-added roles the shared testing rule once, on any product, without repeating it on continuations", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find(entry => entry.id === "copywriter")!.draft);
    const roles = libraryRoles(added.changes);
    const loadRule = "Deliberately loading the shared computer to provoke failure";
    for (const role of roles) for (const product of DEMO_PRODUCTS.slice(0, 2)) {
      const ctx = { ...context(role), roles, product };
      const fresh = buildPrompt(ctx);
      expect(fresh.split(FOCUSED_VERIFICATION)).toHaveLength(2);
      expect(fresh.split(loadRule)).toHaveLength(2);
      for (const continued of [continuePrompt(ctx), continuePrompt(ctx, { refreshRole: true })]) {
        expect(continued).not.toContain(FOCUSED_VERIFICATION);
        expect(continued).not.toContain(loadRule);
      }
    }
    for (const continued of [restartPrompt({ stage: "Build", role: "Builder", done: [] }, { messages: [] }), screenPrompt("Check the app", []), handBackPrompt("Checked the app", [])]) {
      expect(continued).not.toContain(loadRule);
    }
  });
  it("separates ordinary checks from intentional shared-host load and keeps diagnostics bounded and evidential", () => {
    for (const meaning of [
      "Ordinary focused tests and diagnostics, Petrina's own required checks and the normal parallel full run need no extra permission",
      "CPU busy loops, memory or disk fillers, process floods, many concurrent test copies",
      "controlled release signals, fault injection",
      "hard CPU, memory and process limits",
      "preserve real native deadline and process-cleanup coverage",
      "If only real load on this computer can prove it",
      "existing needsInput Inbox question and wait for an agreed window",
      "resource, load and process limits, duration, cleanup, effects on other work and what safer approaches cannot prove",
      "Do not poll other tasks' processes to claim capacity",
      "a quiet process list or low load is never permission",
      "Every diagnostic helper needs its own deadline, a fixed process cap, ownership by your command",
      "cleanup if the command or your turn is interrupted",
      "parent-liveness watcher or interrupt cleanup as well as its deadline",
      "Also apply the command tool's execution deadline; its timeout alone may leave children running",
      "Confirm all helpers stopped after success, failure, timeout or interruption",
      "report unconfirmed cleanup and stop only processes you started",
      "Diagnostic runs, passing repeats and host-load readings are evidence only",
      "neither turn a failed required check into a pass nor by themselves prove a failure's cause",
      "Never enlarge production deadlines",
      "Never kill another task's processes, retry an unchanged hang, skip failing tests, lower test parallelism or shorten a legitimate full-suite budget",
    ]) expect(FOCUSED_VERIFICATION).toContain(meaning);
  });
  it("refreshes role purpose and handoff details when the continued context scope changed", () => {
    const role = { ...BUILT_IN_ROLES.find((entry) => entry.id === "builder")!, purpose: "A changed purpose", handsBack: "A changed handoff" };
    const ctx = context(role);
    expect(continuePrompt(ctx)).not.toContain("A changed purpose");
    const changed = continuePrompt(ctx, { refreshRole: true });
    expect(changed).toContain("A changed purpose"); expect(changed).toContain("A changed handoff");
    expect(changed).not.toContain(FOCUSED_VERIFICATION);
  });
  it("explains fresh browser storage after restart and failed reopening, including a screen continuation", () => {
    const where = { stage: "Build", role: "Builder", done: ["Checked the page"] };
    const reopened = restartPrompt(where, { messages: [] });
    const fresh = formatWhereYouWere(where, "the tool could not reopen it");
    const screen = formatWhereYouWere(where, "the tool could not reopen it", "screen");
    for (const text of [reopened, fresh, screen]) {
      expect(text).toContain("Earlier pages and browser logins are gone");
      expect(text).toContain("starts with empty storage");
    }
    expect(screen).toStartWith("You asked for the screen");
    expect(screen).not.toContain("Petrina restarted");
  });
  it("hands a reviewer's reproduction to builders and voters, while keeping settled history concise", () => {
    const finding = { id: "finding-1", text: "The greeting disappears", where: "greeting.txt:1", evidence: "Open the welcome page with an empty name; the heading disappears.", severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: [], status: "open" as const };
    expect(formatFindings([finding])).toContain(finding.evidence);
    expect(formatFindings([{ ...finding, status: "fixed" }])).not.toContain(finding.evidence);
    expect(formatFindings([{ ...finding, evidence: "x".repeat(10_000) }]).length).toBeLessThan(1600);
  });
  it("tells every role to put its recommended answer first when it asks the coordinator", () => {
    for (const role of BUILT_IN_ROLES) {
      const prompt = promptFor(role);
      expect(prompt).toContain("put the answer you recommend first");
      expect(prompt).toContain('"options": ["The answer you recommend", "Another option"]');
      // Every agent reads with the coordinator's logins and publishes nothing, in the background.
      expect(prompt).toContain(LOGINS);
      expect(prompt).toContain(BACKGROUND);
      expect(prompt).toContain('Word each item as what you are doing for the product, the way you would tell the coordinator ("Working out what changes for users"), never with file, function or command names.');
    }
  });
  it("keeps code review bounded for open-ended behavior without weakening regression checks", () => {
    const role = BUILT_IN_ROLES.find((entry) => entry.id === "code-reviewer")!;
    const prompt = promptFor(role);
    expect(prompt).toContain("one finding per root cause");
    expect(prompt).toContain("do not enumerate paraphrases, synonyms, or permutations");
    expect(prompt).toContain("representative syntax classes");
    expect(prompt).toContain("look for bugs, missing tests, weakened tests");
  });

  it("defines confirmations as current bugs in code and security review prompts", () => {
    const meaning = '"Confirms" means "still broken now"';
    for (const id of ["code-reviewer", "security-reviewer"]) {
      const role = BUILT_IN_ROLES.find((entry) => entry.id === id)!;
      const prompt = promptFor(role);
      expect(prompt).toContain(meaning);
      expect(prompt).toContain("only if that specific");
      expect(prompt).toContain("current code");
      expect(prompt).toContain("omit if fixed");
    }
  });

  it("keeps current-code confirmations alongside affected products in shared review prompts", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
    const roles = libraryRoles(added.changes);
    const products = DEMO_PRODUCTS.slice(0, 2);
    const shared = { ...task, repositories: products.map((product, index) => ({ productId: product.id, delivery: "pull-request" as const, completedStages: [], baseSha: `base-${index}`, reviewedSha: `review-${index}` })) };
    for (const id of ["code-reviewer", "security-reviewer", added.roleId]) {
      const role = roles.find((entry) => entry.id === id)!;
      const prompt = buildPrompt({ ...context(role), task: shared, roles });
      expect(prompt).toContain('"productIds": ["<every affected product id>"]');
      expect(prompt).toContain('"Confirms" means "still broken now"');
      expect(prompt).toContain("only if that specific problem is still present in the current code; omit if fixed");
      expect(prompt).toContain('"confirms": [{"id":');
      expect(prompt).toContain('"evidence": "The exact current failing case');
      expect(prompt).not.toContain("<id of an earlier finding you agree with>");
      expect(prompt).toContain("Review all repositories in the complete approved product map together.");
      for (let index = 0; index < products.length; index += 1) {
        if (id !== "security-reviewer") {
          expect(prompt).toContain(`git diff review-${index}..HEAD`);
          expect(prompt).not.toContain(`git diff base-${index}...HEAD`);
        } else {
          expect(prompt).toContain(`git diff base-${index}...HEAD`);
          expect(prompt).not.toContain(`git diff review-${index}..HEAD`);
        }
        expect(prompt).toContain(`git show base-${index}:REVIEW.md`);
      }
    }
  });

  it("keeps security reviews on full saved-base diffs after a code review baseline advances", () => {
    const security = BUILT_IN_ROLES.find((entry) => entry.id === "security-reviewer")!;
    const products = DEMO_PRODUCTS.slice(0, 2);
    const shared = {
      ...task,
      repositories: products.map((product, index) => ({
        productId: product.id,
        delivery: "pull-request" as const,
        completedStages: [],
        baseSha: `base-${index}`,
        reviewedSha: `reviewed-${index}`,
      })),
    };
    const sharedPrompt = buildPrompt({ ...context(security), task: shared, base: "lead-base" });
    for (let index = 0; index < products.length; index += 1) {
      expect(sharedPrompt).toContain(`git diff base-${index}...HEAD`);
      expect(sharedPrompt).not.toContain(`git diff reviewed-${index}..HEAD`);
      expect(sharedPrompt).toContain(`git show base-${index}:REVIEW.md`);
    }

    const singlePrompt = buildPrompt({
      ...context(security),
      task: { ...task, baseSha: "single-base", reviewedSha: "single-reviewed" },
      base: "single-base",
    });
    expect(singlePrompt).toContain("git diff single-base...HEAD");
    expect(singlePrompt).not.toContain("git diff single-reviewed..HEAD");

    const changes = editRole(NO_ROLE_CHANGES, "security-reviewer", {
      ...draftOf(security),
      instructions: "Check the access boundary for each product.",
    });
    const roles = libraryRoles(changes);
    const custom = roles.find((entry) => entry.id === "security-reviewer")!;
    const customPrompt = buildPrompt({ ...context(custom), task: shared, role: custom, roles, base: "lead-base" });
    expect(customPrompt).toContain("Check the access boundary for each product.");
    expect(customPrompt).toContain("git diff base-0...HEAD");
    expect(customPrompt).not.toContain("git diff reviewed-0..HEAD");
  });

  it("gives every findings role one canonical evidence rule, including saved wording overrides", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
    let changes = added.changes;
    for (const id of ["code-reviewer", "security-reviewer"]) changes = editRole(changes, id, { ...draftOf(BUILT_IN_ROLES.find((role) => role.id === id)!), instructions: "Review the current welcome page." });
    const roles = libraryRoles(changes);
    for (const role of roles.filter((entry) => entry.result === "findings")) {
      const prompt = buildPrompt({ ...context(role), roles });
      expect(prompt).toContain(role.instructions);
      expect(prompt.split(FINDING_CONFIRMATION_RULE)).toHaveLength(2);
      expect(prompt).toContain('"confirms": [{"id":');
      expect(prompt).toContain('"evidence": "The exact current failing case');
    }
  });

  it("asks for one cause with its affected paths in every findings role, including partial saved rules", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
    for (const wording of [undefined, "Review the current welcome page.", `Review our checkout.\n${FINDING_CONFIRMATION_RULE}`, `Review our checkout.\n${FINDING_REVIEW_RULES.join("\n")}`]) {
      let changes = added.changes;
      if (wording) for (const id of ["code-reviewer", "security-reviewer", added.roleId]) {
        const role = libraryRoles(changes).find((entry) => entry.id === id)!;
        changes = editRole(changes, id, { ...draftOf(role), instructions: wording });
      }
      const roles = libraryRoles(changes);
      for (const role of roles.filter((entry) => entry.result === "findings")) for (const prompt of [buildPrompt, continuePrompt]) {
        const text = prompt({ ...context(role), roles });
        expect(text).toContain(role.instructions);
        for (const rule of FINDING_REVIEW_RULES) expect(text.split(rule)).toHaveLength(2);
        expect(text).toContain("all observed affected paths together");
        expect(text).toContain("use that finding's id and include the variant in fresh confirmation evidence");
        expect(text).toContain("reserve new findings for distinct root causes");
        expect(text).toContain("representative syntax classes");
        expect(text).toContain("pre-existing");
        expect(text).toContain("do not run the full test suite or build again");
      }
    }
  });

  it("grounds findings and votes in task obligations, independently of age, role wording and prepared comparisons", () => {
    const builtIn = (id: string) => BUILT_IN_ROLES.find(role => role.id === id)!;
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find(entry => entry.id === "security")!.draft);
    const savedWording = 'Review this product. A problem the change did not cause is "pre-existing" and never blocks.';
    let changes = added.changes;
    for (const id of ["code-reviewer", "security-reviewer", "verifier", added.roleId]) {
      const role = libraryRoles(changes).find(entry => entry.id === id)!;
      changes = editRole(changes, id, { ...draftOf(role), instructions: savedWording });
    }
    const roles = libraryRoles(changes);
    // Votes cannot be added through the Library today; an unknown id still follows its result contract.
    const addedVoter = { ...builtIn("verifier"), id: "added-independent-check", name: "Independent check", added: true, instructions: `Check the supplied claims.\n${FINDING_REQUIREMENT_RULE}` };
    const reviewers = [builtIn("code-reviewer"), builtIn("security-reviewer"), builtIn("verifier"), ...roles.filter(role => role.result === "findings" || role.result === "votes"), addedVoter];
    for (const sample of findingReviewCases) for (const role of reviewers) for (const prepared of [false, true]) {
      const sections = [
        { title: "Design brief", body: sample.acceptance },
        { title: "The coordinator's notes", body: sample.decision },
        { title: "Finding to check", body: `${sample.claim}\n${sample.evidence}` },
        ...(prepared ? [{ title: PREPARED_REVIEW, body: "Complete comparison: /prepared/full.diff" }] : []),
      ];
      const current = { ...task, title: sample.name, description: sample.request };
      const ctx = { ...context(role), task: current, roles, base: "saved-starting-version", sections };
      for (const prompt of [buildPrompt(ctx), continuePrompt(ctx)]) {
        expect(prompt).toContain(role.instructions);
        expect(prompt.split(FINDING_REQUIREMENT_RULE)).toHaveLength(2);
        expect(prompt).toContain('explicitly requested repair or concrete acceptance outcome unmet is "important" for reviewers and "real" for Verifiers');
        expect(prompt).toContain('A confirmed older bug unrelated to the task is "pre-existing", a follow-up that never blocks.');
        expect(prompt).toContain("Missing or unavailable proof is not a reproduced code defect");
        expect(prompt).toContain("investigate an unclear requirement rather than invent an obligation");
        expect(prompt).toContain("These classification rules govern even when saved role wording says otherwise");
        for (const section of sections) expect(prompt).toContain(section.body);
        if (role.result === "votes") {
          for (const rule of VERIFIER_RULES) expect(prompt.split(rule)).toHaveLength(2);
          expect(prompt).toContain("The starting version is saved-starting-version.");
          expect(prompt).toContain(prepared ? "use the prepared complete comparison" : "git diff saved-starting-version...HEAD");
          expect(prompt).toContain('"verdicts": [');
        } else {
          expect(prompt).toContain("A confirmed regression caused by the change is Important");
          for (const rule of FINDING_REVIEW_RULES) expect(prompt.split(rule)).toHaveLength(2);
          expect(prompt).toContain('"findings": [');
        }
      }
      expect(buildPrompt(ctx)).toContain(sample.request);
      // Rendering never rewrites saved coordinator wording, including conflicting older instructions.
      if (role.edited) expect(role.instructions).toBe(savedWording);
    }
  });

  it("gives default and edited Builders whole-cause repair guidance on their first return and later repairs", () => {
    const builder = BUILT_IN_ROLES.find((role) => role.id === "builder")!;
    for (const instructions of [builder.instructions, "Keep the checkout simple.", `Keep the checkout simple.\n${REPAIR_RULE}`]) {
      const changes = editRole(NO_ROLE_CHANGES, builder.id, { ...draftOf(builder), instructions });
      const roles = libraryRoles(changes);
      const role = roles.find((entry) => entry.id === builder.id)!;
      for (const round of [1, 5]) for (const prompt of [buildPrompt, continuePrompt]) {
        const review = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"] };
        const repairing = { ...task, fixing: true, plan: { stages: [review], rationale: "Review the repair.", plannerProfileId: "sol-high" }, stageIndex: 0, rounds: { [review.id]: round } };
        const text = prompt({ ...context(role), task: repairing, roles });
        expect(text).toContain(instructions);
        expect(text.split(REPAIR_RULE)).toHaveLength(2);
        expect(text).toContain("from the first return, identify the underlying rule");
        expect(text).toContain("normal, failure and recovery paths");
        expect(text).toContain("failing variants and nearby passing controls");
        expect(text).toContain("distinguish cases inspected from cases executed");
        expect(text).toContain("fast focused static or type check for the changed code and typed tests");
        expect(text).toContain("Do not assume a passing runtime test proves a separate static or type check will pass.");
        expect(text).toContain("no focused command was available");
        expect(text).toContain("Petrina runs them on the finished work before review");
        expect(text).toContain('Answer every finding by id in "answers"');
        expect(text).toContain("Do not commit, push or open pull requests");
      }
    }
  });

  it("tells every notes role, whatever its name, permission or wording, that only its saved report reaches later agents", () => {
    const builtIn = (id: string) => BUILT_IN_ROLES.find((role) => role.id === id)!;
    const copy = ROLE_STARTS.find((start) => start.id === "copywriter")!.draft;
    const added = addRole(NO_ROLE_CHANGES, copy);
    const editing = addRole(added.changes, { ...copy, name: "Product copywriter", canEdit: true });
    let changes = editRole(editing.changes, "researcher", { ...draftOf(builtIn("researcher")), instructions: "Look only at the checkout page." });
    changes = editRole(changes, "ux-designer", { ...draftOf(builtIn("ux-designer")), canEdit: true });
    const roles = libraryRoles(changes);
    const saved = (id: string) => roles.find((role) => role.id === id)!;
    // A queued routine keeps the wording it was saved with; a coordinator may also keep the rule inside their own wording.
    const routine = { ...MAINTENANCE_ROLES.find((role) => role.id === "maintenance-bug-finder")!, instructions: "Check the saved checkout routine only." };
    const kept = { ...saved("researcher"), instructions: `Look only at the checkout page.\n${NOTES_HANDOFF_RULE}` };
    const cases = [
      [builtIn("researcher"), "Look at the repository to understand the current state. Do not change any files."],
      [saved("researcher"), "Look only at the checkout page."],
      [kept, "Look only at the checkout page."],
      [builtIn("ux-designer"), "Do not change any files: describe the design in your notes."],
      [saved("ux-designer"), "Describe the design in your notes."],
      [saved(added.roleId), copy.instructions],
      [saved(editing.roleId), copy.instructions],
      [routine, routine.instructions],
    ] as const;
    for (const [role, own] of cases) for (const prompt of [buildPrompt, continuePrompt]) {
      const text = prompt({ ...context(role), roles });
      expect(text).toContain(own);
      expect(text.split(NOTES_HANDOFF_RULE)).toHaveLength(2);
      expect(text).toContain('"notes": [');
    }
    expect(buildPrompt({ ...context(routine), roles })).toContain('Set "complete" to true only after completing the bounded investigation.');
    for (const role of BUILT_IN_ROLES.filter((entry) => entry.result !== "notes")) expect(promptFor(role)).not.toContain(NOTES_HANDOFF_RULE);
  });

  it("checks nearby cases for regressions on every product without needing a local review guide", () => {
    const roles = libraryRoles({ edits: { "code-reviewer": { purpose: "Review the changed checkout." } }, added: [] });
    const role = roles.find((entry) => entry.id === "code-reviewer")!;
    const rule = "A confirmed regression caused by the change is Important, even when the intended case now works.";
    expect(role.instructions).toContain(rule);
    for (const product of [DEMO_PRODUCTS[0]!, { ...DEMO_PRODUCTS[0]!, id: "another-product", name: "Another product" }]) {
      const text = buildPrompt({ ...context(role), product, roles, sections: [] });
      expect(text).toContain("check nearby cases affected by the same code or rule");
      expect(text).toContain("Compare with the starting version.");
      expect(text.split(rule)).toHaveLength(2);
      expect(text).toContain("do not run the full test suite or build again");
    }
    // A deliberate instructions override stays the coordinator's own wording.
    const custom = libraryRoles({ edits: { "code-reviewer": { instructions: "Review checkout compatibility." } }, added: [] }).find((entry) => entry.id === "code-reviewer")!;
    expect(custom.instructions).toBe("Review checkout compatibility.");
  });

  it("tells every role except the Release Manager how to ask, without granting the screen", () => {
    for (const role of BUILT_IN_ROLES) {
      expect(mayAskScreen(role)).toBe(role.id !== "release-manager");
      const prompt = promptFor(role);
      expect(prompt).toContain(BACKGROUND);
      if (role.id === "release-manager") {
        expect(prompt).toContain("list it in your result as a check that needs the screen");
        expect(prompt).not.toContain("needsScreen");
      } else {
        expect(prompt).toContain(ASK_FOR_SCREEN);
        expect(prompt).toContain('{"needsScreen": {"reason": "What you need to check on screen, in plain language"}}');
        expect(prompt).not.toContain("You may now use the screen");
        expect(promptFor(role, { reason: "Check the menu bar" })).toContain(screenRules("Check the menu bar"));
      }
    }
  });

  it("tells an agent back in its own conversation that it does not have the screen now", () => {
    const builder = BUILT_IN_ROLES.find((role) => role.id === "builder")!;
    const back = continuePrompt(context(builder, "ask"));
    expect(back).toContain("You do not have the screen now, even if you had it earlier in this conversation.");
    expect(back).toContain('{"needsScreen"');
    expect(back).not.toContain("You may now use the screen");
    expect(continuePrompt(context(builder))).toContain("You do not have the screen now");
  });

  it("reads a screen request as its own kind of result, with the reason", () => {
    expect(parseResult('Done in the background.\n\n```petrina\n{"needsScreen": {"reason": "Click through the menu bar"}}\n```', NotesResult)).toEqual({ ok: "screen", reason: "Click through the menu bar" });
    expect(parseResult('```petrina\n{"needsScreen": {"reason": ""}}\n```', NotesResult).ok).toBe(false);
  });
});
