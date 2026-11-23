import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { PluginBackendContext, PluginTaskSnapshot } from "learnharness-plugin-api";
import {
  buildInstructions, COMPLETE_TOOL_NAME, curriculumSchema, GENERATE_WORKER_ID, generateInstructions, generatePrompt,
  OVERVIEW_TOOL_NAME, overviewText, pickCurrent, REVISE_WORKER_ID, reviseInstructions, revisePrompt, START_TOOL_NAME, type ActivePlan,
} from "./contract.ts";
import { createFetchTool } from "./fetch-tool.ts";
import {
  acceptGenerated, acceptRevision, activeEntries, applyManualEdit, emptyState, entryName, entryOfTopic, findEntry, findTopic, LIMITS,
  linkSession, localDate, newEntry, parseState, planningProblems, readCurriculum, readName, readProfile, setTopicStatus, topicForSession, updateEntry,
  type Draft, type DraftKind, type ModelChoice, type PlanEntry, type PlanState,
} from "./plan-model.ts";
import { brief, buildSchedule, slotForTopic, type Slot } from "./schedule.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid operation input.");
  return input as Record<string, unknown>;
}

export type BackendOptions = { now?: () => Date; random?: () => number; fetchDeps?: Parameters<typeof createFetchTool>[0] };

export function activate(ctx: PluginBackendContext, options: BackendOptions = {}): () => void {
  const now = options.now ?? (() => new Date());
  const today = () => localDate(now());
  const file = path.join(ctx.dataDirectory, "plan.json");
  let state: PlanState;
  let loadError: string | null = null;
  try {
    state = parseState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    state = emptyState();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") loadError = `Could not read ${file}: ${(error as Error).message}`;
  }

  const cleanups: (() => void)[] = [];
  let disposed = false;
  const alive = () => { if (disposed || ctx.signal.aborted) throw new Error("Learning plan plugin is not active."); };
  const scheduleOf = (entry: PlanEntry) => buildSchedule(entry.plan, entry.profile, today());
  /** Unarchived courses that have a curriculum: what the calendar, kickoff and agents see. */
  const activePlans = (): ActivePlan[] => activeEntries(state).flatMap(entry => entry.plan ? [{ entry: entry as ActivePlan["entry"], schedule: scheduleOf(entry) }] : []);

  // ---- Instructions: re-registered on change and when the date rolls over ----
  let instructionHandles: (() => void)[] = [];
  let instructionKey = "";
  function refreshInstructions() {
    if (disposed) return;
    const plans = !loadError ? activePlans() : [];
    const teacher = plans.length ? buildInstructions(plans, today(), "teacher") : "";
    const practice = plans.length ? buildInstructions(plans, today(), "practice") : "";
    const key = `${teacher}\u0000${practice}`;
    if (key === instructionKey) return;
    for (const unregister of instructionHandles) unregister();
    instructionHandles = [];
    instructionKey = key;
    if (!teacher) return;
    instructionHandles.push(ctx.registerInstructions({ agents: ["teacher"], text: teacher }));
    instructionHandles.push(ctx.registerInstructions({ agents: ["practice"], text: practice }));
  }
  const timer = setInterval(refreshInstructions, 15 * 60_000);
  timer.unref?.();

  // ---- Persistence ----
  let queue: Promise<unknown> = Promise.resolve();
  function change(mutate: (current: PlanState) => PlanState, topic = "plan-changed"): Promise<PlanState> {
    const run = queue.then(async () => {
      alive();
      if (loadError) throw new Error(`${loadError} Fix or move the file, then restart LearnHarness.`);
      const next = mutate(state);
      if (next === state) return state;
      await fs.promises.mkdir(ctx.dataDirectory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
        await fs.promises.rename(temporary, file);
      } catch (error) {
        await fs.promises.rm(temporary, { force: true });
        throw error;
      }
      state = next;
      if (!disposed) {
        refreshInstructions();
        ctx.events.emit(topic);
      }
      return state;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  // ---- Agent tools ----
  cleanups.push(ctx.registerTools({
    agents: ["teacher", "practice"],
    create: context => (loadError || !activePlans().length) ? [] : [
      {
        name: COMPLETE_TOOL_NAME,
        label: "Complete plan topic",
        description: "Mark a learning-plan topic as done once the learner has demonstrably met its objectives. topicId is optional in a session that was kicked off from the plan (the linked topic is used).",
        parameters: {
          type: "object",
          properties: {
            topicId: { type: "string", pattern: "^t-\\d+$", description: "Plan topic ID such as t-12 (see learning_plan_overview)." },
            note: { type: "string", maxLength: LIMITS.note, description: "One line on how the learner showed mastery." },
          },
          required: ["note"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
          if (signal?.aborted || ctx.signal.aborted) throw new Error("Cancelled.");
          const input = params as { topicId?: string; note: string };
          const linked = input.topicId ? null : topicForSession(state, context.chatId);
          const owner = linked ? linked.entry : input.topicId ? entryOfTopic(state, input.topicId) : null;
          const topic = linked ? linked.topic : owner ? findTopic(owner.plan, input.topicId!)?.topic : undefined;
          if (!owner || !topic) throw new Error(input.topicId ? `Unknown topic ${input.topicId}.` : "This session is not linked to a plan topic; pass topicId.");
          await change(current => setTopicStatus(current, topic.id, true, today(), input.note));
          const after = findEntry(state, owner.id);
          const next = after ? scheduleOf(after).current : null;
          const upcoming = next?.kind === "topic" ? findTopic(after?.plan ?? null, next.topicId)?.topic.title : next ? "a review session" : null;
          return {
            content: [{ type: "text" as const, text: `Marked "${topic.title}" done.${upcoming ? ` Next in the plan: ${upcoming} (${next!.date}).` : " The plan is complete."}` }],
            details: { topicId: topic.id, title: topic.title },
          };
        },
      },
      {
        name: START_TOOL_NAME,
        label: "Start plan topic",
        description: "Start a learning-plan item in this session when the learner chooses one: links the session to the topic in their calendar and returns the brief (topic, objectives, session part, length) to follow. Omit topicId for today's scheduled item (the most pressing one across plans, or a given plan's with planId).",
        parameters: {
          type: "object",
          properties: {
            topicId: { type: "string", pattern: "^t-\\d+$", description: "Plan topic ID such as t-12; omit for today's scheduled item." },
            planId: { type: "string", pattern: "^p-\\d+$", description: "Plan ID such as p-1; only used when topicId is omitted, to pick that plan's scheduled item." },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
          if (signal?.aborted || ctx.signal.aborted) throw new Error("Cancelled.");
          const sessionKind = context.agent === "practice" ? "practice" : "teaching";
          const input = params as { topicId?: string; planId?: string };
          const plans = activePlans();
          let owner: ActivePlan | undefined;
          let current: Slot | null = null;
          if (input.topicId) {
            const entry = entryOfTopic(state, input.topicId);
            owner = plans.find(active => active.entry.id === entry?.id);
            if (!owner) throw new Error(`Unknown topic ${input.topicId}. Use ${OVERVIEW_TOOL_NAME} for topic IDs.`);
          } else if (input.planId) {
            owner = plans.find(active => active.entry.id === input.planId);
            if (!owner) throw new Error(`Unknown plan ${input.planId}. Use ${OVERVIEW_TOOL_NAME} for plan IDs.`);
            current = owner.schedule.current;
          } else {
            const pick = pickCurrent(plans);
            owner = pick?.active;
            current = pick?.slot ?? null;
          }
          const topicId = input.topicId ?? (current?.kind === "topic" ? current.topicId : null);
          if (!owner || !topicId) {
            if (!owner || !current) throw new Error("Nothing is scheduled; every topic is done. Pass a topicId to revisit one.");
            // A review slot isn't one topic, so there is nothing to link.
            return { content: [{ type: "text" as const, text: brief(owner.entry.plan, current, owner.entry.profile, sessionKind) }], details: { topicId: null } };
          }
          const { plan, profile } = owner.entry;
          const found = findTopic(plan, topicId);
          if (!found) throw new Error(`Unknown topic ${topicId}. Use ${OVERVIEW_TOOL_NAME} for topic IDs.`);
          // Re-starting in an already linked session keeps its part number.
          const linked = found.topic.sessionIds.indexOf(context.chatId);
          const slot = slotForTopic(plan, topicId, today())!;
          const part = linked >= 0 ? { ...slot, part: linked + 1 } : slot;
          await change(latest => linkSession(latest, topicId, context.chatId));
          const done = found.topic.status === "done" ? " (already marked done; this is a revisit)" : "";
          return {
            content: [{ type: "text" as const, text: `Linked this session to ${topicId}${done}.\n${brief(plan, part, profile, sessionKind)}` }],
            details: { topicId, title: found.topic.title },
          };
        },
      },
      {
        name: OVERVIEW_TOOL_NAME,
        label: "Learning plan overview",
        description: "Read the learner's full learning plans: modules, topic IDs, objectives, status and planned dates. Covers every active plan, or one with planId. Read-only.",
        parameters: {
          type: "object",
          properties: { planId: { type: "string", pattern: "^p-\\d+$", description: "Plan ID such as p-1; omit for all plans." } },
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
          if (signal?.aborted || ctx.signal.aborted) throw new Error("Cancelled.");
          const { planId } = params as { planId?: string };
          const plans = activePlans().filter(active => !planId || active.entry.id === planId);
          if (!plans.length) return { content: [{ type: "text" as const, text: planId ? `Unknown plan ${planId}.` : "No learning plan exists." }], details: {} };
          const many = activePlans().length > 1;
          const text = plans.map(({ entry, schedule }) => `${many ? `[${entry.id}] ` : ""}${overviewText(entry.plan, schedule, entryName(entry))}`).join("\n\n=====\n\n");
          return { content: [{ type: "text" as const, text }], details: { planIds: plans.map(active => active.entry.id) } };
        },
      },
    ],
  }));

  // ---- Planning workers ----
  const workerTools = () => [createFetchTool(options.fetchDeps)];
  cleanups.push(ctx.workers.register({ id: GENERATE_WORKER_ID, instructions: generateInstructions, resultSchema: curriculumSchema, tools: workerTools, validateResult: result => { const problems = planningProblems(readCurriculum(result)); if (problems.length) throw new Error(`Fix these and submit again:\n${problems.join("\n")}`); } }));
  cleanups.push(ctx.workers.register({ id: REVISE_WORKER_ID, instructions: reviseInstructions, resultSchema: curriculumSchema, tools: workerTools, validateResult: result => { const problems = planningProblems(readCurriculum(result)); if (problems.length) throw new Error(`Fix these and submit again:\n${problems.join("\n")}`); } }));

  const observers = new Map<string, () => void>();
  /** Update the draft whose request is `requestId`, wherever its course now is. A removed course is ignored. */
  function patchDraft(requestId: string, update: (draft: Draft) => Draft): Promise<PlanState> {
    return change(current => {
      const entry = current.plans.find(candidate => candidate.draft?.requestId === requestId);
      if (!entry?.draft) return current;
      const next = update(entry.draft);
      return next === entry.draft ? current : updateEntry(current, entry.id, found => ({ ...found, draft: next }));
    });
  }
  function settle(requestId: string, task: Pick<PluginTaskSnapshot, "status" | "result" | "error">) {
    return patchDraft(requestId, draft => {
      if (draft.status !== "running") return draft;
      if (task.status === "succeeded") {
        try {
          return { status: "ready", kind: draft.kind, requestId, curriculum: readCurriculum(task.result) };
        } catch (error) {
          return { status: "failed", kind: draft.kind, requestId, error: (error as Error).message };
        }
      }
      return { status: "failed", kind: draft.kind, requestId, error: task.error?.message ?? `Planning ${task.status}.` };
    });
  }
  function watch(requestId: string, taskId: string) {
    if (observers.has(taskId)) return;
    let last = "";
    const unsubscribe = ctx.workers.subscribe(taskId, task => {
      const current = `${task.status}:${task.turns}:${task.activity ?? ""}`;
      if (current !== last && !disposed) { last = current; ctx.events.emit("draft-progress"); }
    });
    observers.set(taskId, unsubscribe);
    ctx.workers.wait(taskId, ctx.signal).then(() => settle(requestId, ctx.workers.get(taskId))).catch(() => {
      // Activation ended; the next activation reconciles the saved draft.
    }).finally(() => { observers.get(taskId)?.(); observers.delete(taskId); });
  }
  function reconcile() {
    for (const { draft } of state.plans) {
      if (!draft || draft.status !== "running") continue;
      const task = ctx.workers.list().find(candidate => candidate.requestId === draft.requestId);
      if (!task) {
        void patchDraft(draft.requestId, current => current.status === "running"
          ? { status: "failed", kind: current.kind, requestId: current.requestId, error: "Planning was interrupted before it finished. Try again." } : current).catch(() => undefined);
      } else if (TERMINAL.has(task.status)) void settle(draft.requestId, task).catch(() => undefined);
      else {
        if (!draft.taskId) void patchDraft(draft.requestId, current => current.status === "running" ? { ...current, taskId: task.id } : current).catch(() => undefined);
        watch(draft.requestId, task.id);
      }
    }
  }
  if (!loadError) reconcile();

  async function resolveModel(override: ModelChoice | null) {
    const catalog = await ctx.inference.catalog();
    alive();
    const pin = override ? { model: override, thinkingLevel: undefined } : catalog.slots?.strong;
    if (!pin?.model) throw new Error("Configure the strong model slot (Settings → Agent → Models) or choose a planning model.");
    const entry = catalog.models.find(model => model.provider === pin.model.provider && model.id === pin.model.id);
    if (!entry) throw new Error("The selected planning model is unavailable. Choose a configured model.");
    const thinkingLevel = pin.thinkingLevel && entry.supportedLevels.includes(pin.thinkingLevel) ? pin.thinkingLevel : undefined;
    return { ...pin.model, ...(thinkingLevel ? { thinkingLevel } : {}) };
  }

  async function startDraft(entryId: string, kind: DraftKind, prompt: (entry: PlanEntry) => string) {
    const entry = findEntry(state, entryId);
    if (!entry) throw new Error("That plan no longer exists.");
    if (entry.archived) throw new Error("This plan is archived. Unarchive it first.");
    if (entry.draft?.status === "running") throw new Error("A planning run is already in progress for this plan.");
    const model = await resolveModel(entry.profile.modelOverride);
    const requestId = randomUUID();
    await change(current => updateEntry(current, entryId, found => ({ ...found, draft: { status: "running", kind, requestId, taskId: null, startedAt: now().toISOString() } })));
    let task: PluginTaskSnapshot;
    try {
      task = ctx.workers.start(kind === "generate" ? GENERATE_WORKER_ID : REVISE_WORKER_ID, {
        requestId,
        input: { kind },
        prompt: prompt(findEntry(state, entryId)!),
        model,
        purpose: "user",
        maxTurns: 25,
        options: { maxTokens: 16_000 },
        timeoutMs: 600_000,
      });
    } catch (error) {
      await patchDraft(requestId, () => ({ status: "failed", kind, requestId, error: (error as Error).message }));
      throw error;
    }
    await patchDraft(requestId, draft => draft.status === "running" ? { ...draft, taskId: task.id } : draft);
    if (TERMINAL.has(task.status)) await settle(requestId, task);
    else watch(requestId, task.id);
  }

  // ---- Frontend operations ----
  function view(created?: string) {
    return {
      loadError,
      today: today(),
      plans: state.plans.map(entry => {
        const draft = entry.draft;
        let progress: { status: string; turns: number; activity?: string } | undefined;
        if (draft?.status === "running" && draft.taskId) {
          try {
            const task = ctx.workers.get(draft.taskId);
            progress = { status: task.status, turns: task.turns, ...(task.activity ? { activity: task.activity } : {}) };
          } catch { /* Reconciliation reports missing tasks. */ }
        }
        return { id: entry.id, name: entry.name, hue: entry.hue, archived: entry.archived, profile: entry.profile, plan: entry.plan, draft, progress, schedule: scheduleOf(entry) };
      }),
      ...(created ? { created } : {}),
    };
  }
  function handle(name: string, handler: (input: Record<string, unknown>) => unknown) {
    cleanups.push(ctx.handle(name, input => { alive(); return handler(record(input ?? {})); }));
  }
  const entryFor = (input: Record<string, unknown>): PlanEntry => {
    const entry = typeof input.planId === "string" ? findEntry(state, input.planId) : null;
    if (!entry) throw new Error("That plan no longer exists.");
    return entry;
  };
  handle("get-state", () => view());
  handle("add-plan", async () => {
    let created = "";
    await change(current => {
      const made = newEntry(current, today(), options.random);
      created = made.entry.id;
      return made.state;
    });
    return view(created);
  });
  handle("remove-plan", async input => {
    const entry = entryFor(input);
    if (entry.draft?.status === "running" && entry.draft.taskId) {
      try { ctx.workers.cancel(entry.draft.taskId); } catch { /* Already finished. */ }
    }
    await change(current => ({ ...current, plans: current.plans.filter(candidate => candidate.id !== entry.id) }));
    return view();
  });
  handle("set-plan-archived", async input => {
    const entry = entryFor(input);
    if (typeof input.archived !== "boolean") throw new Error("archived is required.");
    const archived = input.archived;
    await change(current => updateEntry(current, entry.id, found => found.archived === archived ? found : { ...found, archived }));
    return view();
  });
  handle("rename-plan", async input => {
    const entry = entryFor(input);
    const name = readName(input.name);
    await change(current => updateEntry(current, entry.id, found => found.name === name ? found : { ...found, name }));
    return view();
  });
  handle("save-profile", async input => {
    const entry = entryFor(input);
    const profile = readProfile({ ...input.profile as object, modelOverride: entry.profile.modelOverride });
    await change(current => updateEntry(current, entry.id, found => ({ ...found, profile: { ...profile, modelOverride: found.profile.modelOverride } })));
    return view();
  });
  handle("set-model-override", async input => {
    const entry = entryFor(input);
    const model = input.model === null || input.model === undefined ? null : record(input.model);
    if (model && (typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id)) throw new Error("Invalid model.");
    await change(current => updateEntry(current, entry.id, found => ({ ...found, profile: { ...found.profile, modelOverride: model ? { provider: model.provider as string, id: model.id as string } : null } })));
    return view();
  });
  handle("generate", async input => {
    const entry = entryFor(input);
    if (typeof input.goal !== "string" || !/\S/.test(input.goal)) throw new Error("Describe your background and goal first.");
    if (input.goal.length > LIMITS.goalPrompt) throw new Error(`The goal is longer than ${LIMITS.goalPrompt} characters.`);
    if (!entry.profile.weekdays.length) throw new Error("Choose at least one study day first.");
    const goal = input.goal.trim();
    await change(current => updateEntry(current, entry.id, found => ({ ...found, profile: { ...found.profile, goalPrompt: goal } })));
    await startDraft(entry.id, "generate", found => generatePrompt(goal, found.profile));
    return view();
  });
  handle("revise", async input => {
    const entry = entryFor(input);
    if (!entry.plan) throw new Error("Generate a plan first.");
    if (typeof input.request !== "string" || !/\S/.test(input.request)) throw new Error("Describe how the plan should change.");
    if (input.request.length > LIMITS.revisionPrompt) throw new Error(`The request is longer than ${LIMITS.revisionPrompt} characters.`);
    const request = input.request.trim();
    await startDraft(entry.id, "revise", found => revisePrompt(found.plan!, request, found.profile));
    return view();
  });
  handle("draft-accept", async input => {
    const entry = entryFor(input);
    const draft = entry.draft;
    if (draft?.status !== "ready") throw new Error("There is no plan draft to accept.");
    await change(current => {
      const latest = findEntry(current, entry.id);
      if (latest?.draft?.requestId !== draft.requestId || latest.draft.status !== "ready") throw new Error("The draft changed. Review it again.");
      const accepted = draft.kind === "generate"
        ? acceptGenerated(current, entry.id, latest.draft.curriculum, now().toISOString(), randomUUID())
        : acceptRevision(current, entry.id, latest.draft.curriculum);
      // A fresh plan starts today unless the learner chose a later start.
      return updateEntry(accepted, entry.id, found => ({
        ...found,
        draft: null,
        profile: draft.kind === "generate" && found.profile.startDate < today() ? { ...found.profile, startDate: today() } : found.profile,
      }));
    });
    return view();
  });
  handle("draft-discard", async input => {
    const entry = entryFor(input);
    const draft = entry.draft;
    if (draft?.status === "running" && draft.taskId) {
      try { ctx.workers.cancel(draft.taskId); } catch { /* Already finished. */ }
    }
    await change(current => updateEntry(current, entry.id, found => ({ ...found, draft: null })));
    return view();
  });
  handle("save-plan", async input => { const entry = entryFor(input); await change(current => applyManualEdit(current, entry.id, input.modules)); return view(); });
  handle("set-topic-status", async input => {
    if (typeof input.topicId !== "string" || typeof input.done !== "boolean") throw new Error("topicId and done are required.");
    await change(current => setTopicStatus(current, input.topicId as string, input.done as boolean, today(), typeof input.note === "string" ? input.note : ""));
    return view();
  });
  handle("link-session", async input => {
    if (typeof input.topicId !== "string" || typeof input.sessionId !== "string") throw new Error("topicId and sessionId are required.");
    await change(current => linkSession(current, input.topicId as string, input.sessionId as string));
    return view();
  });

  refreshInstructions();

  return () => {
    disposed = true;
    clearInterval(timer);
    for (const unsubscribe of observers.values()) unsubscribe();
    observers.clear();
    for (const unregister of instructionHandles) unregister();
    instructionHandles = [];
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch { /* Continue releasing other registrations. */ }
    }
  };
}
