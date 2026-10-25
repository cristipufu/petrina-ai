# Agents and conversations

Owns role contracts, tool configuration, context, messages, permissions and screen access. Back to [design overview](../design.md).

## Roles

Roles are records the engine saves and keeps across restarts (`packages/core/src/roles.ts`). The engine and the demo squad share the rules, and the engine enforces them, not the Library's form.

### Maintenance roles

Workflow and Maintenance are permanent role categories. Existing workflow roles retain their identities and edits. Maintenance roles never enter Planner descriptions, example plans or ordinary role pickers; engine plan validation excludes them in standalone, design-author, design-reviewer and review positions with an explanation. Routine commands reject every workflow role, internal roles included. Editing cannot change category or result kind.

Maintenance starters live in one core catalog, separate from ordinary prompt definitions. Dead-code cleanup, stale-feature cleanup, flaky-test repair and agent-instruction improvement use the existing build result and repair contract. CI optimization and Bug finder use the notes result. Reports only is read-only; Small changes with review can edit. The result determines permission, with no separate maintenance permission control and no inserted Builder. Instruction improvements require a controlled comparison of one changed instruction on the same task, snapshot, model and effort; unavailable evidence and measurements stay explicit.

Each queued occurrence freezes the complete role wording and profile. Turns and all repair paths use that snapshot after Library edits, removal and restart. Maintenance results explicitly say whether the bounded investigation completed. Incomplete results and tool errors cannot finish as successful empty investigations; read-only writes are undone and require attention.

Before maintenance instructions are sent, the connector must confirm the exact requested model and effort. Unavailable or unconfirmed settings wait for coordinator recovery without another profile. Usage limits also retain the saved profile. Every reply is checked before further questions, screen requests, corrections or queued instructions can advance the conversation. A reported mismatch holds progression in a durable Inbox decision. Keep accepts the saved reply with its actual settings recorded; completed results proceed without another agent turn or delivery approval. An intermediate reply is retained through restart and processed before any further instructions, which again request the original profile. Kept questions go to the Inbox before waiting instructions are sent; those instructions cannot discard the question. A replacement conversation receives the question with its answer and the saved request. Stop saves the decision and ordinary cancellation together, so an interrupted save cannot restart stopped work. The existing journey and usage records retain requested and confirmed actual settings.

### Built-in roles

Built-in roles keep their name, icon and kind of result, because Petrina depends on them. The coordinator can change their purpose, how they work and what they hand back, and their permission unless that would break how the squad works: the Planner is always read-only, reviewers never change the work they judge, and the Builder always makes changes. Only the fields the coordinator changed are saved, so the others keep following Petrina's defaults; **Reset to default** drops them. The Release Manager is shown but can't be changed: it writes release notes while Petrina handles delivery itself.

### Added workflow roles

(at most 20 added roles across both categories) hand back notes or pass-or-fail findings, chosen once. A notes role works in a `do` step, and what it hands back reaches every later agent on the task. A findings role joins the review next to the code reviewers: it sees the design, the acceptance checklist, the builder's report and earlier findings, confirms or disputes them (every dispute gives its reason, as for the code reviewers), and its blocking findings go back to the builder under its name. A removed role leaves the Library and the planner's list, and stays known to the tasks that use it.

### Refused, whoever sends it

The engine refuses an unknown role, any change to the Release Manager, a locked permission, a changed kind of result, a changed name, icon or colour on a built-in role, a duplicate name (ignoring capitals, counting built-in names), a missing name or purpose, text over the limit (name 40, purpose 200, instructions 4,000, hands-back 300 characters) and a 21st added role.

### What an agent is told

Planned participants receive the current step's saved title as an explicit assignment alongside their role and task context. The full request, approved brief and role duties remain authoritative, including when the title is generic. Selection explanations and the rest of the plan stay out of this assignment; an unrecorded title stays unknown. Fresh Journey inputs include the assignment actually sent. Continued context packets retain it, send changed assignments, and omit unchanged background; short interruption and capacity continuations restate the current assignment without repeating the request. Side errands retain their own jobs.

The agent receives its role's wording, inside Petrina's fixed rules for its kind of result (never its name, so an added role gets the rules of the built-in role it works like), then its purpose, one sentence on what it may change in this step and what it hands back, with the task, the coordinator's notes and the result format as before. Role contracts render saved wording into explicit templates; they never search or splice rendered English to retain runtime rules. The planner's fixed rules (the roles and profiles it may use with what each one does, the stage kinds and the rules) come after its wording and can't be replaced by it. Review independence and incremental scope belong to contract capabilities, so added findings roles inherit the same policy as the code-review contract. The Release Manager keeps its fixed delivery contract.

### Every step that may change the product comes before the final review

(the plan's last review chain). The engine moves one the planner put after it, and the plan's reason says so; a step that still ends up after it, because its role was switched to changing the product after planning, runs read-only and the timeline says why. Read-only steps may still run after the final review. No planned role changes the product after the final review. Petrina adds delivery last, after the final review and the delivery check, as before, and handles publishing itself; only the read-only Release Manager works there, and only for releases.

### Misplaced roles are corrected, never stuck

Findings in a `do` step join the final review, notes or checks in the review get a step of their own before it (also when the plan names a role for every reviewer), any other role there that doesn't review is replaced by a code reviewer or left out, an added role in the design pair gives way to the built-in one, internal roles, including the Release Manager, are left out wherever the planner put them, a role removed while the planner planned is left out, and the final review always keeps a code reviewer. The plan's reason says what Petrina changed.

### Work is never lost between roles

A role that may change the product has its work committed at the end of its step, labelled with its name, so a later read-only role never wipes it. Read-only roles, added ones included, have their changes and commits undone when their step ends. In a shared task, commits and tracked edits any role leaves in the other products are undone too, with a warning naming each product. An acceptance run that Petrina had to undo cannot verify the product ([acceptance evidence](workflow.md#acceptance-evidence)).

- Changes reach the next agent that starts and the next plan. An agent already working finishes with the version of its role it started with, its wording, name and permission included, even when Petrina restarts in between and its conversation starts again. Reviewers and voters working side by side each keep their own saved version; a replacement on another tool keeps it until that part of the review finishes.

## Context and conversations

### Notes reports

A notes result's summary and notes are the report later agents receive; the conversation behind it is never forwarded. Every notes role, built-in, edited, added or maintenance, gets one shared rule from the notes contract in fresh and continued prompts, kept once beside its own wording: put the actual findings or proposals there with their distinguishing facts, exact sources (links, repository locations, recorded checks) when relevant and available, and versions or platforms they depend on, and say what was inspected, run, uncertain or left unchecked, with suggested approaches kept apart from observations and constraints. It asks for no extra research, headings or length; the example reply asks for each finding with its evidence and limits when relevant. The Researcher and UX designer defaults show the rule, so a reset restores it; coordinator wording stays as written. Later agents receive every saved report exactly as handed back, after a short reminder to verify what they rely on and that proposals, including proposed screens and words, guide the work but add no requirements beyond the request, an approved brief and the coordinator's notes and decisions.

### Source locations from planning

Selected products provide the Planner with a bounded navigation packet from their exact local default-branch tree: top-level paths, workspace scripts and clearly partial AGENTS.md/README excerpts. Packets are shared by tree version, contain no prior agent's conclusions, and do not replace reading the actual selected source or its complete instructions.

The planner may hand on up to eight source locations it already inspected, each tied to a product and exact commit. They contain paths only, without architecture recommendations or inferred requirements. Instructions name the exact registered product ids to use. The engine checks each location on its own and keeps only those naming one of the plan's resolved registered products by that exact id; it never derives an id from a repository address or product name. Malformed or unrelated locations are left out with a short note in the task's history and never cost the planner's result. The engine verifies that a current product of the task has that revision and location in its prepared copy before showing them to the Architect, or the first Builder when design is skipped. They are an explicitly incomplete navigation aid, never requirements; independent reviewers receive none. Changed sources and old records fall back to ordinary discovery. No extra research turn is added.

### Source locations in a design

The Architect can retain the same bounded kind of source locations in its brief across revisions and a coordinator's design call. A revision starts with the current objections and revisits relevant current code. The first Builder can use the approved author's locations; independent design and code reviewers receive neither those locations nor the author's conversation or private rationale. The same exact-id and per-location checks apply against the task's current products. Omitted references keep only the earlier locations that still qualify, an explicit list replaces them with its valid entries, an empty or wholly rejected list clears them, and changed revisions are filtered before use. Fresh sessions and full independent discovery remain available.

### Complete briefs and design blockers

Every role that reads the brief receives all its behavior and affected-area rules as well as its summary, user changes, acceptance and risks. Design blockers identify the governing requirement, the unresolved gap or contradiction, and the consequence of building it as written. A rule already present in another section is not missing. Later design reviews first check prior answers and revised rules, retaining independent judgment and investigating beyond them when evidence warrants it. These are shared instructions, not a semantic filter or an additional review gate.

### Final design-review notes

When a design settles, the non-blocking points its final review raised stay noted and reach every role whose result is a build, including building roles the coordinator added and roles saved with a task, in one section right after the brief. The engine reads only existing records: the journey's latest design step must be a review that settled the design, and only the points that review raised and that are still noted count. An Architect step after it (changes asked at the design check, or following the coordinator's call) leaves none, so after a revision only a later review's own points are passed on. Answered, rejected, coordinator-decided and blocking points never appear; records that cannot show the current review give none. The section names its step, round and design-review role and labels the points as advice: not requirements, acceptance items or blockers, to be checked against current code, overruled by the approved brief, the coordinator's notes and any design call, adding no scope and needing no answer. Multi-product tasks warn that a point may concern another product. Design participants, code and security reviewers' blind inputs, Verifiers, the Tester and notes roles receive no such section. Acceptance, findings, checks and gates are unchanged.

### Coordinator notes in continued conversations

Confirmed Builder, design and findings-review continuations share the same note comparison, by result contract and separately for each participant. A note is recognised only by its recorded id and exact text and original step; similar or identical wording under another id never establishes that it was supplied. When notes change and some earlier text can be left out, the opening sends new or changed background notes in full, with their original step, and a numbered oldest-to-newest list of every current note. The list names each id and step and says whether its text follows, waits in the coordinator messages section, or remains unchanged in the complete saved context. The latest coordinator decision still wins. Withdrawn notes are explicitly named as no longer applying; notes hidden while being delivered live to that participant are neither listed nor treated as withdrawn. With no note changes and valid recorded identities, the notes section stays omitted. When individual-note matching is unavailable, including snapshots without note fingerprints, an intact exact whole-section comparison still omits unchanged background. This records only a whole-section omission, never individual-note recognition or delivery. Notes already carried as earlier-attempt guidance are referenced without repeating their bodies, including guidance newer than the saved note comparison. An empty notes part adds no saved heading and does not by itself add a context reference.

Earlier-attempt guidance carries a note only when its recorded id and exact text match. A changed saved note fingerprint takes precedence over that shortcut, including a change to the original step alone. The revision is supplied as current guidance; an old version or identical words under another id cannot stand in for it.

The immutable complete current context packet always keeps every current note in full and in order with its original step, including queued notes whose text is supplied separately in the prompt. It remains authoritative after harness compaction and replaces earlier packets. Each saved conversation snapshot keeps one note fingerprint alongside its existing section and finding fingerprints; these records have the same lifecycle and add no storage location or cleanup process. Each Journey input records the exact supplied notes section and its size, and identifies unchanged notes left out by id and fingerprint. Leaving out background creates no message receipt, recipient mark or conversation entry.

Full necessary notes are sent for fresh conversations, replacement roles or profiles, unsupported or failed reopen, missing or altered packets, snapshots without note fingerprints when no exact whole-section fallback applies, an error while saving or comparing, and a change where every displayed note is new anyway. Notes with missing or duplicate ids also travel in full when their whole section changed or its saved comparison is unavailable or untrustworthy. Recipient scope, queued and live message delivery, confirmations, parallel broadcasts and earlier-attempt guidance retain their own rules. Screen, permission, question, takeover and deliberate-rethink paths keep their existing fresh-versus-warm choices; design objections and coordinator calls always remain explicit.

### Continued design conversations

Each design stage retains separate author and reviewer conversations, scoped to its product, role, planned and actual profiles, request and approved sources. The first pass starts fresh; later passes reopen that participant's own conversation through the existing resume/load path. The author receives objections and changed constraints; the reviewer receives the changed brief and objection answers. Unchanged research and request background are not repeated.

Each participant has a complete current context packet to read after compaction, and each Journey node records the actual fresh or continued input. Packets and saved messages are named only once completely written, so participants saving identical content at the same moment each keep their own reference. A failed write, or a different file under the name, leaves no reference; that file is kept, never replaced. On storage without hard links, each save keeps its own complete copy under a private name instead. A restart retains both references and the current turn. Incompatible scopes start fresh with a reason. In later rounds, an eligible usage stand-in is preferred for its own conversation even after the planned profile recovers, under the shared selection rule below. Conversations are never copied between participants.

### Continued reviewer conversations

The first code or security review starts fresh. Each reviewer seat saves its own completed conversation within that stage. Fix rounds recreate its detached copies at the same paths and reopen that conversation with current findings, Builder answers, check evidence and prepared comparisons. Unchanged request and brief sections are replaced by an immutable complete context packet, available after compaction. Within an intact native conversation, finding records already supplied are reduced to a current status index; new or changed records retain all recorded fields. Fresh reviewers receive independent context with the bounded historical view below; Verifiers receive complete context. Journey inputs record exactly what was sent.

Fresh findings reviewers may receive shorter entries for older fixed findings only when the finding's saved role has the findings result contract and the frozen records show a dated Builder claim stood through a later completed review examination. Every affected product must have a dated fix claim; the latest counts. The examination must have started after it, recorded that claim among those checked, and saved a settled fixed finding without a subsequent reopening. A fixed label, an unfinished examination, an unknown or missing origin role, or legacy records without checked-claim evidence never qualify. Acceptance-testing failures stay complete. Pre-existing, dismissed, unverified and open findings stay complete, including current answers, reproductions, votes and decisions. A reopened finding stays complete until its newer claim stands through another completed round. Added roles follow their result contract.

A shortened finding keeps its id, severity, status, full problem, location, products, follow-up links, reopening history marker and the round and journey step through which the claim stood. This does not establish a verified fix on current code. Follow-up cards with more than 600 problem characters retain their id, title, products, first 600 characters and remaining count; short cards stay complete. All shown ids and same-bug judgments keep their existing semantics. Each shortened entry points by id into one complete frozen indexed file, prepared from the same baseline before any reviewer reports. Its identity is shared across simultaneous reviewers, fresh replacements and restarts. Missing or changed files are explicitly unavailable, never replaced from live findings or cards. Failure to freeze the copy keeps the complete sections.

Reviewers read a relevant full entry to check a returning bug, reuse a reproduction or earlier proof, decide whether a report is the same problem, or match it to a card. They read a potentially matching card before choosing “none”. This guidance appears once beside the first shortened section actually supplied. They need not read the entire history unconditionally. Current proof can reopen any finding by its original id. Fresh replacements retain guidance about prior attempts and unheard messages. Warm continuations retain the existing full packet, status deltas and delivery receipts: unchanged cards are omitted, and changed cards are resent in full. Prepared comparisons, conflict and base-update instructions, checks, review guides and full-change scope remain unchanged. Rounds saved without this view keep their original form.

A conflict-free update of the execution base is not a conversation scope change. Each seat remembers every product's last reviewed base and continues only when each base is unchanged or contains that saved base. When a base advances, that seat receives the old and new bases, incoming commit count, exact current commit and files changed by both main and the task. It reads their current versions, the complete comparison against the new base and the new base's review guide as well as the incremental comparison. The incremental comparison carries the previous task change onto the new base, so it does not show incoming main changes; reviewers inspect their relevant interactions beyond the listed files too. Current comparisons, changed instructions and check evidence are refreshed every round. A companion-only update preserves every compatible seat.

A changed role, assignment, planned or actual profile, request, product membership, working-copy identity or approved source starts a complete fresh review. Conflict ports discard saved reviewer conversations. Each discarded seat keeps that reason, naming the conflicting product in a shared task, until its next start records it, including after a pause, slot wait or restart; a seat with no discarded conversation records none. Port-only rounds, incompatible base history, missing saved bases, an unavailable native session or an unavailable immutable context packet also require a fresh start. One completed reference per stage seat survives stage completion and engine restart for later repair or coordinator returns, including within the same numbered round. Pause/cancellation and final context cleanup clear them; retention never grants a review round or changes a finding's outcome. Verifiers always start fresh.

Design participants and findings reviewers, including added roles and parallel seats, prefer their own valid saved stand-in across rounds. This preference requires an unchanged planned profile and scope, an assignment not chosen by the coordinator, matching effort, a non-standby profile, available account usage and model capacity, a ready tool (after [one bounded recheck](#checking-the-tools) of an uncertain answer) and a free slot. The usual choice must still select it when treated as planned, using the current author's, Builder's and peer reviewers' actual tools and models for independence. Reviewers near a usage limit keep today's policy. Admission and the turn share this decision; parallel seats choose in order against actual peers already selected and planned peers not yet started.

Journey inputs and the timeline name a kept stand-in and its planned profile, including when that profile is available again. Fresh starts retain the reason: assignment edits, scope changes, availability, usage headroom, effort, standby status or independence. A design author near a usage limit can switch for more headroom under the usual selection rules; reviewers retain their near-limit policy. Missing context, incompatible starting-branch history or failed native reopening discovered before instructions invalidate that saved reference and repeat the usual selection with full context; they do not start fresh on the old stand-in merely because its record existed. That failure reason survives a slot wait or restart. Native context is never transferred between tools or seats. Same-step screen continuation, restarts and capacity retries keep their existing rules.

### Side errands

Check finder and Guide keeper errands save the main step's conversation, attempts, to-do item and clock durably before using their own conversation. An interrupted errand can reopen without losing the main session; finishing or falling back restores its bookkeeping. Explicit task pause still clears the main native conversation, and cancellation drops the errand.

### Continued Builder context

Fix rounds and branch updates return to the Builder's own supported conversation. After three review rounds, one deliberate fresh rethink replaces the assigned Builder's conversation, with its reason recorded. Later repairs reuse that replacement, including repeated check repairs in the same review round. A new stage or assignment can require a new rethink; the instruction to reconsider remains on late fixes. An unavailable native session receives its previous report in a new conversation. Required final acceptance tests still run; completed Tester conversations are not retained across steps because final testing can change their edit permissions.

After a supported return to the same Builder conversation, unchanged background sections can be replaced by a reference to an immutable complete context packet. The engine sends changed instructions, every current finding and complete failure-log references, and records exactly that input on the journey. The packet remains readable when a harness compacts its conversation; missing or altered packets, changed roles or sources, and fresh conversations receive full context.

Reusable background includes earlier handoffs, final design-review notes, accepted guide points, open follow-up cards and the prior PR description. Confirmed native continuations retain their static verification and role rules, refreshing role details when context scope changes and receiving a short update for the new browser capture folder. Fresh sessions receive the complete rules.

Implementation and acceptance reports retain their node, product, confirmed settings and recorded code trees. Downstream agents receive a compact index into an immutable file of those existing reports; the full history is not copied into each prompt. A final acceptance pass names its reason and the products changed since the previous tested trees. Earlier passes are navigation evidence, never automatic proof for new code; missing historical versions stay unknown. These files share task-context cleanup.

Independent guide, check-evidence and source-location reads run together. Coordinator notes are gathered only after those reads finish, so messages received during preparation reach the opening prompt.

This applies to check fixes and review fixes without removing quality gates. Packets are private runtime files and disappear with finished or cancelled tasks, independently of worktree cleanup.

## Tools: ACP first

Every connector removes inherited agent-session markers before opening its own session. Managed executable overrides are restored before another provider or working copy prepares its launch; Codex's wrapper retains the real executable across nested launches and refuses a target pointing back to itself. A failed process-list lookup reports incomplete cleanup while preserving the original startup failure.

Managed Grok sessions disable its persistent workspace memory through the native process setting. The current request, repository contracts and the participant's own resumed conversation remain available, as do all skills. Petrina does not modify personal memory files or settings; Grok reviewers do not inherit notes from other tasks.

The Planner supplies a short public explanation for each role/profile seat. Plans retain the requested assignment and any readiness adjustment, even when review groups are joined. Coordinator edits replace the affected seat's explanation. At agent admission the engine records its selection reason separately, alongside requested and selected profiles and native settings confirmed at startup. Journey inputs retain that evidence per reviewer seat; missing historical explanations remain unknown rather than being reconstructed from current usage.

Petrina talks to agents through the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Claude Code and Codex have maintained ACP adapters. Grok and Antigravity expose native ACP servers:

| Tool | ACP adapter |
|---|---|
| Claude Code | `agentclientprotocol/claude-agent-acp` (Claude Agent SDK) |
| Codex | `agentclientprotocol/codex-acp` (Codex App Server) |
| Grok | `grok --permission-mode auto agent stdio` (no Node adapter; model `grok-4.7`, effort `reasoning_effort`) |
| Antigravity | Google's pinned native ACP distribution (see below) |

ACP gives Petrina what it needs without per-tool code:

| Need | ACP |
|---|---|
| Start a session in a working copy | `session/new` with `cwd` and the MCP servers to attach |
| Send a message | Adapter-owned live input when supported; `session/prompt` for explicit waiting and safe idle fallback |
| Interrupt | `session/cancel` |
| Live activity for the status line | `session/update` notifications (messages, tool calls, plans) |
| Permission prompts | `session/request_permission`, sent only when the tool's own safety check flags something; the coordinator answers |
| Pick up after a restart | `session/resume`, or `session/load` (which replays the conversation) when that is all the agent offers |

Adapters are registered in `packages/agent-runtime/src/tools.ts` against `tool-adapter.ts`. Optional hooks own environment preparation, session metadata, settings verification, native usage updates, turn reports, tool metadata, limit errors, account commands and terminal arguments. The ACP runner owns the shared handshake, cancellation and process cleanup. Account readers are registered through the adapter and held by tool ID in the usage coordinator; snapshots, refreshes and shutdown enumerate that registry. Live-session account reporting avoids a duplicate probe at turn start. Adding runtime behavior no longer requires branches in the runner or kernel; supported profile, model, setup and UI catalog data still need explicit entries. Account-reader protocols and refresh timing belong to [runtime usage limits](engine-runtime.md#account-readers).

On macOS and Linux, stopping a working agent pauses its process group and every known program before each process-list read. Only lists showing those owners paused or gone confirm ownership; newly found descendants are paused immediately. Petrina sends TERM, resumes them for the existing grace period, then pauses and collects again before forcing survivors to stop. Every pause ends in a resume or stop, including failed reads. After the forced stop, a program still present counts as ended only when a complete process list read in that final second names it, or names members of its group and every one, defunct: it has exited and only awaits collection, which a busy runtime can delay or never report, and it can no longer change the working copy. A list silent about something still present, with no row for it or no listed member of its group, proves nothing and leaves the stop unconfirmed, like a list that cannot be read. Unlike the browser's folder cleanup below, which keeps such a process unconfirmed until it is released, the agent stop protects the working copy. Cleanup stays within the existing quit budget and warns when it cannot confirm. Each unconfirmed stop writes one private line, beginning `Agent cleanup incomplete:`, with the stage, elapsed time, which process lists could be read and what stayed present with its state, in the same bounded form and to the same places as the browser's note; login probes and Windows keep their existing stop paths.

Ownership still depends on parent links: a detached program can become untraceable if its parent exits during the resumed grace period or before cleanup starts. A newly discovered detached program can also fork before its pause arrives; catching every such fork would require extra reads beyond the current budget. A crash between pause and resume can leave programs paused. Process numbers can still be reused between a list and a signal, and on macOS a pause can wait for an in-progress system call to finish. Product checks and the browser helper have separate cleanup routines.

Things to verify per tool before relying on them: model and effort selection through ACP, use of the user's existing login, and `session/resume` or `session/load` support.

### Google Antigravity

Antigravity uses Google's native ACP distribution, pinned at 1.4.1 with its sibling harness. `petrina antigravity install` installs it explicitly; ordinary tool checks never download software. `petrina antigravity login` opens Google's personal-account sign-in. The connector keeps its own login, separately from the terminal CLI. Ready requires opening a session, without an AI prompt or browser sign-in during ordinary checks.

Profiles offer Gemini 4 Argon and Gemini 3.8 Flash at medium or high thinking. The session must confirm both `model` and `thinking_level` before receiving work. New and resumed sessions use the server's native `yolo` mode, as requested by the coordinator, so tool calls proceed without per-command approval. This approves all tools; it is not the terminal CLI's selective Auto classifier, which the ACP server does not expose. Petrina's workflow gates and read-only cleanup still apply. Native session resume preserves each participant's conversation. Terminal takeover stays unavailable because the CLI cannot open ACP session identifiers.

The built-in `/usage` command is local, not an AI turn. It supplies quota groups and UTC reset times; Argon's separate quota applies to Argon, and Gemini's shared quota covers Flash (and Argon when no separate Argon bucket is reported). Limits for unavailable third-party models do not block these profiles. Idle and Analytics reads share a throttled reader; live sessions report their own before/after readings without starting another probe. Failed reads retain the last report and its age.

Token accounting and quota scope are defined in [state and usage](state-and-usage.md#antigravity). Account-command output never enters task messages or agent history in the app. Reads are bounded and stop their harness, including on shutdown.

### Background browsers

Every eligible conversation opening (all roles except the Release Manager; new, resume, load or replacement) attaches an engine-owned Playwright MCP browser through ACP. Bundled Chromium runs headlessly with isolated storage in a short temporary folder outside the working copy. Connector controls exclude personal-browser and desktop integrations; personal settings are untouched. A restarted agent is told its pages and browser logins are gone.

On macOS the short parent folder lives under the user's home, away from crowded system temporary folders. A helper that never initialized the browser acknowledges that fact when it closes cleanly, avoiding process scans. Used, crashed or unacknowledged helpers still require process cleanup; an unreadable process list never counts as proof that cleanup finished. Recovery resolves the same canonical parent as startup.

On macOS and Linux, that cleanup is complete only when the latest readable scan for processes naming the session folder, taken in the same attempt, shows nothing left and every process the attempt found is gone. The helper's own process list from the start of shutdown only adds processes to stop, including when it answers after the helper closed. A finished process the system has not yet released still counts as not stopped. The engine, not the helper, removes the session folder and its recovery registration, and only once completion is confirmed. A later stop or startup recovery finds ownership afresh through the session folder and never signals process numbers from an earlier attempt. Windows keeps its earlier rules and wording.

On macOS and Linux, each attempt that cannot confirm completion writes one private line of at most 4 KiB: the shutdown stage, elapsed time, how the helper ended, which process lists could be read, whether a scan confirmed the folder clear, and up to 16 processes with their ownership source and state (running, finished, absent or unknown), plus total and omitted counts. It holds no command text, paths, page addresses or browser contents. Agent runs append it to the task's log in Petrina's logs folder. Startup recovery writes it to engine.log, which every engine start begins afresh, so a startup note lasts only until the next start, including a successful retry. Without a log, such as in a test, it goes to standard error, so a failing Tests check keeps it in its saved log. The task shows only the shared warning that Petrina could not confirm every child process stopped. A failed startup recovery says plainly what it could not confirm: programs still running, finished but not yet released, an unreadable state, an unreadable list of running programs, or programs still listed at the last check.

Browser output, including agent-named captures, stays in that folder. Reports may choose pictures with captions; the engine accepts only a real image file in that folder, refusing shortcuts and shared names instead of following them, decodes and validates each choice, and saves it separately for the unfinished task before closing the browser and cleaning the working copy.

Pictures survive agent handoffs and restarts, but their bytes are removed when the task is done or cancelled, even if its working copy must stay; a startup sweep removes any finished or orphaned capture folders without reading archived conversations. Task state carries only picture references on the originating report. The authenticated image endpoint loads them separately. Closing, failure, pause, cancellation and shutdown remove temporary output and profiles once cleanup is confirmed; restart also removes registered interrupted folders.

Browser regression and native-tool validation guidance is in [testing](../testing.md#browser-and-native-tool-checks).

### Checking the tools

The engine checks Claude Code, Codex, Grok, Antigravity, the GitHub CLI, Git and Node.js when it starts, on entering Tools in Agents or first run, with Check again, and before a step or a delivery needs them. Window focus and visibility changes never launch tool checks. Agent checks allow up to 30 seconds to open their native session; GitHub CLI, Git and Node.js checks allow 8 seconds. Each returns as soon as it answers and runs outside any product's folder; a slow one never holds the others. Failed checks retain their cause before a bounded tail of the connector's diagnostic output.

Programs are looked up the way Agents finds the agent tools, on the PATH as it is now, so an app opened from the Dock finds what Terminal finds. A tool that doesn't answer in time is Couldn't check at once and is stopped, forced after 2 seconds if it ignores being asked; the next check of that tool waits until it is gone, so Check again never piles up copies.

A login check opens a conversation the way an agent's starts (same command, same environment, in an empty folder of Petrina's own) and closes it before any message, so it costs nothing. Readiness probes skip model, thinking and permission-mode configuration; those are checked when a real agent starts. Ready takes the tool's own word, given the way that tool gives it (`login` on its adapter).

Claude Code and Codex open a conversation while logged out (Claude Code asks for a login only at the first message), so for them Ready is the login their connector reports over ACP (`_auth/status_update`), where "none" means Not logged in. Grok sends no such report: it signs in as the conversation opens and refuses with ACP's "log in first" error when it can't, so for Grok a conversation that opens is Ready.

ACP's "log in first" error means Not logged in for every tool, and a tool that says nothing within the time limit, or anything unclear, means Couldn't check. A program that isn't on the PATH is Not installed at once, with no Checking in between. For Git, Node.js and the GitHub CLI, Not installed requires evidence that the program is missing. A check that cannot prepare its temporary folder or start its program is Couldn't check; Details gives the plain-language cause followed by the original system message. The shared runner distinguishes a missing executable, temporary-folder setup, an unavailable working folder, permission refusal and other launch failures. A program that starts and answers with an error, including exit 127, is Couldn't check with its output. On a Mac, Git is checked without running Apple's stand-in that opens the developer-tools installer: absent developer tools or a tools folder without Git means Not installed, while a lookup that cannot be prepared, started or answered in time means Couldn't check. An empty successful lookup is also uncertain.

The agent tools are Claude Code, Codex, Grok and Antigravity when installed. The squad uses the ones that are Ready, or if none is, those Petrina couldn't check, never one that is Not installed or Not logged in; a usage stand-in comes from the same tools. The planner is only offered profiles on those tools, and every step of its plan, the Release Manager, the Check finder, the Guide keeper and the review's voters move to the same kind of profile on a usable tool. Ready tools retain their planned work when usage and slots permit it.

A returning Builder, or a saved design or findings-review participant, that only an uncertain answer keeps off its saved tool gets one bounded recheck before it starts fresh. Uncertain means Couldn't check at least five minutes ago or at an unrecorded time, or no answer yet; a recent Couldn't check, Not logged in and Not installed follow the usual selection without a probe, and no probe overcomes another selection restriction. Its first wait is recorded with that saved conversation: it spends the return's automatic recheck, stays with the conversation through slot waits, restarts and further interruptions after it reopens, and is replaced only when a completed turn saves the next continuation. Waiting seats and tasks share one check per tool and join an ordinary check already running. The wait ends when the check answers or after one agent check plus the previous copy's stop (33 seconds by default); returning Builders and saved stand-ins still let a running ordinary check finish. Selection then runs again on current usage, places, effort and independence. Ready only permits the reopen attempt, which can still fail into the usual fresh start. Journey inputs and workflow events record the earlier answer, whether the check was started or joined, its outcome and the actual start.

A step whose tool is not ready, won't start (or doesn't open a conversation within two minutes) or asks for a login becomes a Stuck item naming the tool, with its fix; Retry checks the tool again before trying. A pull request or release checks the GitHub CLI's login before the delivery gets ready, so nothing goes out halfway; commit to main needs no GitHub.

## Results and questions

Codex conversations request the installed connector's typed session-failure extension. Native reconnect warnings remain status updates while the harness retries; only a terminal error attached to the completed prompt enters failure recovery. Exhausted transport failures retain their diagnostic and streamed work without format-correction prompts or a quota/capacity record. Account limits, sign-in, model capacity and cancellation retain their own paths; context/session exhaustion does not establish an account quota limit. Other providers opt into extensions and failure readers through their adapters.

An agent hands back its result as one fenced `petrina` block of JSON at the end of its last message, in the shape its role contract shows it. A stage finishes only when that block parses and passes the role's schema; otherwise the agent is told exactly what is wrong, twice at most. An agent that cannot go on without a decision ends with a `needsInput` block instead: the question goes to the inbox, and the answer comes back to the same conversation.

Every fresh or continued agent is told to investigate uncertain facts through current code, reproduction and web research using applicable official documentation or primary sources. Evidence, hypotheses and unavailable checks stay distinct; only unresolved material product decisions go to the coordinator.

The status line comes from the agent's own plan and tool activity over ACP. The engine attaches its background browser through ACP; it does not attach the coordinator CLI/MCP tools to product agents.

## Permissions

Petrina configures each tool's native permission mode instead of building a checker:

| Tool | Mode | Who decides |
|---|---|---|
| Claude Code | Auto | Claude Code's classifier allows or blocks each action; commands run inside Claude Code's own sandbox |
| Codex | Auto review | Codex's reviewer approves, inside Codex's own workspace sandbox |
| Antigravity | `yolo` | The native server approves all tools for unattended work, as requested by the coordinator. It has no selective CLI Auto classifier. Petrina's workflow gates still apply. |
| Grok | Auto | Grok's own checker. The process starts with `--permission-mode auto`, and the session asks for auto mode (`autoMode` on `session/new`, `session/resume` and `session/load`). A saved always-approve setting would otherwise win. Never an always-approve or yolo flag |

- Petrina reads no commands. When a tool's checker flags something and asks, the question goes to the inbox unchanged, with the exact command or paths, and the coordinator allows or denies it once.
- Petrina never picks a tool's "always" option: those write settings into the working copy or switch modes.
- Nothing is remembered: every request is allowed or denied once, in the inbox or the session, with the same wording and buttons in both. There are no remembered rules per product or permission controls in product settings.
- If a tool's automatic mode is not available for a model, the session log says so and that tool asks before acting.
- Approval gates and round limits are enforced by the engine, never by prompting a model to stop.

### Claude Code's sandbox

Every Claude Code conversation, new, resumed or loaded after a restart, and every Claude Code agent working beside others in a copy of its own (reviewers, voters), opens with Claude Code's own sandbox switched on, the same for every role, through the connector's own session option (`_meta.claudeCode.options.sandbox`, `packages/agent-runtime/src/sandbox.ts`). Petrina builds no sandbox, wrappers or command rules of its own, and Codex gets nothing new.

#### Required, and every command still reviewed

The sandbox must start (`failIfUnavailable`), and its own auto-approval of sandboxed commands is off, so Auto mode reviews every command exactly as before. The sandbox only limits what an approved command can change. Claude Code's own rerun outside the sandbox stays on: Auto mode can approve running a command outside it.

#### Where commands may write

Besides the working copy (Claude Code's default): the temporary folders (the system's and the user's own); the sign-in caches (aws's SSO, CLI and login caches, never its settings or credentials files; the az folder; Git Credential Manager's folders, the Azure DevOps sign-in helper); and the download caches of npm, bun, pnpm, yarn, pip, uv, cargo and go, never where they keep installed programs.

Two additions come from Claude Code itself: in a linked working copy it lets commands write the main repository's shared git history (not its hooks or git settings), and it adds whatever the coordinator's own or the product's Claude Code settings allow.

#### Network

Every website is allowed, without questions. On a Mac, local ports (test servers) and the system's certificate check (gh and other Go tools) are allowed too. SSH and headless browsers cannot run inside the sandbox on a Mac, so Claude Code reruns them outside it, only when Auto mode approves.

#### Process checks on a Mac

Claude Code's sandbox allows process information and signals only within the same sandbox. Reading the process list (`ps`) can still fail, which prevents some engine tests from passing inside it. The connector's session settings have no allowance for this; agents rely on Petrina's own checks for the full suite, and the Session hover and AGENTS.md say so.

#### When it cannot start

(Windows, or a system missing what it needs), Claude Code refuses to open the conversation and says why: the connector reports "Sandbox required but unavailable: …" for a new conversation and a reopened one alike. Petrina then opens the same conversation again without it (a reopened one is reopened, not started fresh), and the session says once "Running without Claude Code's sandbox: " with the reason in plain words.

Petrina remembers this until it restarts: later Claude Code agents do not try again, but each still says it once. A conversation picked up again (after a restart, or the builder's own for a fix round or an update) does not say it a second time. Broken sandbox settings (a product's own Claude Code settings, say) are not this: Claude Code keeps the conversation sandboxed and refuses its commands with its own message, the agent reports it, and other agents keep the sandbox.

### The Session tab

The Session tab shows Sandboxed or Not sandboxed next to the agent's status, with what the sandbox covers on hover, or why it is off. Codex agents show Sandboxed, by Codex's own sandbox. Grok keeps its own auto mode and gets no sandbox settings or sandbox label from this change. While the coordinator drives in their terminal it shows nothing: that runs with their own setup, outside Petrina's settings.

## Messages to a running agent

Public ACP message chunks also stream into the saved task conversation while the agent works. Harness message ids preserve distinct progress updates and final replies; tools without ids use activity boundaries. Chunks update one bubble through the bounded notification window in [window snapshots](state-and-usage.md#window-snapshots), with immediate flushes at boundaries and handoff. Structured result fences never stream into the UI; private thought chunks remain separate from public messages.

Ordinary and parallel turns use the same path, and loading a saved conversation does not replay its history into the UI again. Review findings, design objections and the architect’s answers are copied onto the journey step at handoff, so later rounds cannot overwrite that step’s result.

- Send now tries the adapter’s supported live input on each active participant. Claude Code and Codex must advertise `_session/steering`; Claude opts into the host-owned `promptRequired` idle fallback, which uses one ordinary tracked prompt on the same step. Grok uses `_x.ai/interject` only after a no-model method-recognition probe. Its queued acknowledgement confirms acceptance, not consumption. Antigravity’s official connector has no confirmed live-input surface: its messages visibly wait, without changing personal settings.
- Each message targets every unfinished participant, including parallel members waiting for startup, a slot or the screen. Persisted receipts retain the participant’s identity, tool and native session across restart and failover. Input is delivered in order. Rejected, failed and null acknowledgements remain waiting; explicit Wait also uses an ordinary tracked prompt after the current turn ends. Only confirmed current-turn completion marks live steering heard. A queued Grok acknowledgement, a separate Codex turn, a lost reply or a crash after possible acceptance stays unconfirmed. Before continuing the step, an engine-owned question offers Continue without sending again or Send again, with the message and duplicate-delivery warning. The decision belongs to that recipient, survives restart independently of the agent’s own question, and never automatically sends a second copy. Continuing retains the unconfirmed input and the decision without claiming the agent heard it. An explicit resend uses an ordinary tracked prompt before the earlier result can finish the step. A message does not consume review rounds or Builder returns.
- A message can be removed only before any tool may have accepted it. Ordinary prompt input also remains saved until the tracked prompt answers. Waiting, accepted and heard states appear in the conversation; live attempts and their receipts appear in the step’s exact input updates. Board activity records only a short message event.
- Waiting instructions join the actual prompt after context preparation, including when an earlier conversation continues. Background notes and earlier-attempt summaries do not acknowledge them; only the instructions included in that participant's prompt receive its delivery receipt. Complete context packets retain the notes so later returns can omit unchanged background. After the step has started more than once, the notes leave out its earlier guidance only when the opening carries it in its own earlier-attempt section or continues a conversation that already heard it. A fresh parallel participant has neither, so it keeps guidance it already heard, or chose not to receive again, as background.
- Each note names the stage and role it was recorded in: a live note the step at work, a checkpoint answer the stage it decides. A review decision is asked after the flow has moved past its review, so the check records that review stage. Its answer, a message sent while it waits, and the same check raised again when no Builder can take the findings all name that review, never the next stage or the Builder it returns to. Every check records the stage it decides. An older delivery check that recorded none names its pending review decision's review, or the delivery check it stands at; elsewhere its stage is unknown, so notes given while it waits, its answer and that check raised again say their original step was not recorded, like notes saved without an origin or whose decided stage has left the plan.
- Stop and send explicitly sends `session/cancel` to each working participant, then sends waiting instructions in order. Unsupported live delivery never cancels a turn.
- Every delivered message and reply is written to the session transcript the Session tab shows.

## The screen

Agents work in the background: the coordinator is using the same computer. Some checks need the running app on screen (clicking through it, menus, the Dock, real window behaviour), so the screen is something an agent asks for and the engine hands out. The rules live in `@petrina/core` (`screen.ts`), shared by the engine and the simulator.

### Asking

Every agent except the Release Manager is told to do everything else in the background first, then end its turn with `{"needsScreen": {"reason": "…"}}` instead of its result. Only the agent that has the screen is told it may use it. Internal roles and reviewers working side by side ask the same way. A parallel reviewer keeps its own copy and conversation while it waits; its request appears at once, and it can continue on the screen while its peers keep working. Completed reviews stay saved.

Terminal take-over opens that same separate copy; hand back keeps the coordinator’s changes there and in the task for later checks and reviews. Pausing, cancelling or failing a waiting group removes its separate copies and their git records. Only the Release Manager never pauses for the screen: it lists such a check in its result, and a request gets its result handed back as unusable (the usual repair).

A builder going back to its own conversation in a fix round is told it does not have the screen now, even if it had it there.

### The switch

"Agents may use the screen" is Off (the default, after upgrading too), For an hour or On, saved with the pool (`pool.screen`). For an hour keeps its end time and is Off after it, without anyone touching it. A task's own "Allow the screen for this task" (`screenAllowed`) and Allow now on one request also let a request go ahead.

### Allowed and free

The agent has the screen at once, in the same live conversation, and keeps its slot. The request is handled before any message waiting in line, so a message never discards it: messages that arrived as it asked come with the screen line, now or when it continues.

### Otherwise

The step’s conversation closes but is kept, its slot frees at once, and the task waits in the board's Waiting group: for the coordinator's OK, with a quiet inbox item (kind `screen`), or for its turn. Messages sent meanwhile wait in line. The request is saved on the task (`task.screen`) with the agent's reason, kept short and shown as plain text.

### Continuing

Once allowed, with the screen free and a slot free, the step reopens the same conversation the way it does after a restart (resume, or load when that is all the tool offers). The agent hears one line: it may now use the screen for its reason, run the app on screen, take real screenshots and click through; it is the only agent on the screen; and it must close every window and app it opened and stop what it started. Then the messages it has not heard.

A waiting request keeps the conversation and profile that asked, including a usage stand-in, while that profile is available. If an agent runs out of usage during a screen check, it returns the screen to the queue; a stand-in waits for screen permission and its turn like anyone else. The timeline says "Picked up where it left off, now using the screen".

If the conversation cannot be reopened, a fresh one starts with the usual opening instructions, where the agent was (worded as asking for the screen, not as a restart) and the same screen instructions, and the timeline says it started the step again, and why.

### One at a time

The screen goes to one agent, first asked, first served. It is held from the moment it is given until that agent's step ends: it hands back its result, fails, or is paused or cancelled. Waiting requests hold no slot. When the screen frees, the earliest allowed request continues next, ahead of queued tasks, as long as a slot is free. Until then it waits for a slot like any other task and says so; a paused pool holds it like any other agent.

A task's runtime prerequisite wait keeps its screen request, approval, original place and conversation, but leaves it out of the screen line until release. An unanswered permission request stays in the Inbox with the same reference and can be approved while held; approval does not admit a new screen turn. An agent already using the screen, or a coordinator driving its terminal, keeps it until that session settles, including when a parallel peer fails and the group is closing. Between sessions, including after a restart, a held task returns its grant to the saved request so other tasks can use the screen.

### Switching off

(or a task's allowance going off, or For an hour running out) never stops or messages the agent on the screen. It keeps the screen until its step ends; nobody new gets it. Requests that only the switch allowed go back to waiting for an OK; Allow now stays for its request.

### Pause, cancel, restart

Pausing or cancelling drops the request and its inbox item; resuming starts the step fresh. After a restart a waiting task still waits with the same reason and item, and allowing it still reopens the saved conversation. The agent on the screen keeps it and picks up as after any restart; a fresh conversation for it gets the screen instructions again.

- Petrina adds no window blocking or sandbox: the engine enforces the waiting and the one-at-a-time rule, and the agents' instructions follow the switch. Petrina does not close windows itself.

## Take over in the terminal

The coordinator can drive a step's agent by hand, in their own terminal:

### Take over

Allowed while an agent other than the Release Manager works or waits on the coordinator, on Claude Code, Codex or Grok, in a conversation that already has its instructions (`takeOverBlock` in `@petrina/core`). Petrina checks it can open a terminal and that every value fits in a launcher, then stops the agent and waits for its process to exit. Open questions and permission requests go. An editing role's uncommitted work becomes one commit marked as its unfinished work; a read-only role's is undone.

Petrina notes the commit the task is on, keeps the step's conversation note, and the step keeps its seat in the pool (it counts toward its tool's cap) with "You're driving" in the inbox. Pause, Cancel and the inbox actions wait for the hand back; a restart keeps all of it.

### The launcher

(`packages/engine/src/terminal.ts`). One small script in `takeover/<task>/` in Petrina's folder (`0700`): `open.command` on macOS, `open.sh` on Linux, `open.ps1` on Windows.

It starts the tool Petrina found on PATH in the working copy: `claude --resume <id> --model <model> --effort <effort> --permission-mode manual` (`default` when the installed copy's help does not list `manual`, as before Claude Code renamed it), or `codex resume <id> --model <model> -c model_reasoning_effort=<effort> --sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=user --no-daemon`, or `grok --resume <id> --model <model> --effort <effort>` (Grok's usual prompts; never always-approve).

The adapters' conversation ids are the ids the apps reopen (the Claude Agent SDK's session id, Codex's thread id, Grok's session id). Every value is checked against a strict pattern first (absolute paths without quotes, `$`, `;`, `&`, `|`, `%` or line breaks; a UUID; a model name; an effort; the permission mode), and nothing typed by a person or an agent goes in. The Windows launcher starts with a UTF-8 byte order mark, so Windows PowerShell reads accented folder names as written.

Each copy of the launcher keeps a record (`run.<pid>`: its process id and start time) while it runs. Only one copy opens the tool: on macOS and Linux it takes a `lock` that appears holding its record in one step (a hard link), and one left by a copy that is gone is taken over the same way, in a file named after that copy (`lock.after.<its record>`), so however many copies find it at once only one takes it.

No copy removes a lock, not even its own when it ends (the next copy takes over after it), so none is ever taken twice: a copy that was slow to check on one that has since closed finds the lock after it already taken; on Windows it holds the `lock` file open for itself, which the system lets go of when it ends. Every other copy, even one started at the same moment, says the tool is already open and stops. The copy that opened the tool writes `state=ended` when it exits, or when its window is closed.

The terminal gets the coordinator's environment minus Petrina's own variables.

### Terminals

On macOS: Terminal by default, iTerm2, Ghostty, WezTerm, Alacritty or kitty when installed (`open -a`). Windows: Windows Terminal, else a PowerShell window. Linux: `xdg-terminal-exec`, `x-terminal-emulator`, the desktop's own (GNOME, KDE, Xfce, MATE, LXDE), then common ones; none without a display. The coordinator's choice is kept in the state. Copying the command runs the same launcher.

### Hand back

Refused while any copy's record shows it running (pid alive with the same start time, so a reused number does not count); "anyway" only when Petrina cannot tell (no copy reported starting since the terminal was last opened, or a record can't be checked). Take over, Reopen terminal and Hand back run one at a time per task, and Reopen terminal clears the last session's end first, so an earlier "it has closed" never lets a hand back through while the terminal opens again.

Refused when the working copy is off the task's branch or a merge, rebase, cherry-pick or revert is half done. What is left uncommitted becomes one commit marked as the coordinator's. The note (the agent's saved work, commits, up to 10 files, the coordinator's note) goes into the session, the timeline and the task's notes, and onto the conversation note, whose commit moves to the new head so a read-only role's clean-up keeps the hand changes. The launcher folder goes.

The same driver starts at once: the step's conversation reopens and hears the note, or a fresh one gets its usual instructions plus the note.

### Review after hand changes

If files changed, the tamper check runs on the whole branch at once and the task is marked as having hand changes; the delivery check and the delivery step never start while that mark is set, and it clears only when a review chain starts from its first reviewer. A chain still ahead covers the changes. Otherwise the chain being driven, or the last one behind, runs again from its first reviewer once the driven step finishes, without using up a round.

Independent repository inspections run together; their findings are applied in product order. Take-over reuses the saved commit, and hand-back reads commit identity and cleanliness together, while committing and moving working copies remain ordered.

## Agents pick up where they left off

The moment an agent's conversation opens, the engine saves a note of it on the task: the step (stage, design round, reviewer position), the role, the tool and model, the conversation's id, and the working copy's commit when the step first started. The note goes when the step finishes or fails, or the coordinator pauses, cancels or asks for changes; stopping Petrina keeps it.

After a restart, a step whose note matches its step, role, tool and model reopens that conversation in the same working copy, with resume, or load when that is all the tool offers (what load replays is not shown again). Model, effort and the automatic safety mode are confirmed again, changing only options that differ, mode last, and the agent's environment and Claude Code's sandbox settings are the same as for a new conversation.

The agent gets one line (Petrina restarted, the stage, the last thing it was doing, check the working copy and continue), then only what it has not heard: the answer to its open question and messages still in line. The timeline says "Picked up where it left off".

When the conversation cannot be reopened (the tool cannot, it is gone, an error, or no answer within a minute), a fresh one starts with the usual opening instructions plus where it was: the stage and role, its last 10 activities in the step, and up to 30 files added, changed or removed since the step started. The timeline says "Started this step again" with the reason.

A question open at the restart stays in the inbox without holding a slot, and its answer goes to the conversation that asked it, once; an open permission request is dropped with a note, and the agent asks again if it still needs to. A read-only role's clean-up goes back to the commit from when the step first started. The Release Manager never reopens a conversation, and pausing, resuming and "Try again" start the step fresh.

A graceful engine stop or restart admits no new work and waits for admitted agents and checks to drain; it has no automatic four-minute cutoff. A second stop signal interrupts immediately. Closing the desktop app interrupts its owned engine with a bounded shutdown. Completed reviewer results and supported conversations follow the separate recovery rules above; fresh Verifiers remain independent. See [lifecycle and ownership](../coordination.md#lifecycle-and-ownership) for coordinator controls.

## Learnings in AGENTS.md

The builder, reviewers and testers can pass on, with their results, what they learned about working in the repository (how to build or test it, a trap, an unwritten convention): one line each, at most three, verified and useful to unrelated future tasks. Task history, delivery summaries, old feature briefs, acceptance checklists, one-off investigations and temporary conditions are excluded by their shared learning instructions. Current product behavior belongs in its existing design or UX contract; bugs belong in findings or follow-up tasks. This is guidance with coordinator approval, not a semantic content filter. Petrina keeps them on the task, without repeated text or lines AGENTS.md already has, and at the delivery check offers them in one inbox item, without holding anything up.

Lessons are grouped by repository before reading its instructions once. With a working copy, its committed AGENTS.md is authoritative, including an empty or deleted file; before the copy exists, the saved base supplies it. Shared lessons never trigger an unrelated repository read.

Matching ignores whitespace, bullets and sentence-ending punctuation, while preserving case, paths, flags and all words; changed wording stays for the coordinator to judge. Accepted ones join the "Learnings" section of AGENTS.md with the next delivery, in its one commit (`packages/engine/src/learnings.ts`). At startup and once a minute, accepted lessons already present in the product's default branch leave the pending queue. Each leaves a receipt: its exact text, the task it came from, the task whose branch wrote it and the default-branch commit where it was found. A product keeps the last 100, read only when an update conflicts in AGENTS.md alone: when main and a task both only added accepted lessons, the update keeps both ([rule](repositories.md#one-commit-per-task-on-top-of-the-latest-approved-source)). Receipts start empty: a main line taken in before them, or older than the last 100, has none and goes to the Builder in such a conflict.

Accepted AGENTS.md rules need no separate prompt copy: Claude Code and Codex both load AGENTS.md by themselves, so a session Petrina starts and one the coordinator starts in the repository know the same things.

## Profile catalog

The initial profile catalog is seeded once. Coordinator edits and deletions are durable; changing launch settings creates a new identity and retains the old definition for history. Unfinished task plans, live conversations, helper seats and routines prevent mutation until reassigned. Frozen maintenance settings remain unchanged. Internal role defaults resolve to an active profile when their original default was removed.

The profile editor discovers native ACP model options and the selected model's effort options in a disposable session, without a prompt or browser. Reads are joined and serialized per tool, cached for five minutes, bounded to thirty seconds and stopped during shutdown. Discovery does not hold the coordinator mutation queue. The engine validates saves against those reported choices; demonstrations use scripted capabilities through the same catalog transitions.
