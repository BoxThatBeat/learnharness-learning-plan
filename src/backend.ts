import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { PluginBackendContext, PluginTaskSnapshot } from "learnharness-plugin-api";
import {
  buildInstructions, COMPLETE_TOOL_NAME, curriculumSchema, GENERATE_WORKER_ID, generateInstructions, generatePrompt,
  OVERVIEW_TOOL_NAME, overviewText, REVISE_WORKER_ID, reviseInstructions, revisePrompt, START_TOOL_NAME,
} from "./contract.ts";
import { createFetchTool } from "./fetch-tool.ts";
import {
  acceptGenerated, acceptRevision, applyManualEdit, emptyState, findTopic, LIMITS, linkSession, localDate, parseState,
  readCurriculum, readProfile, setTopicStatus, topicForSession, type DraftKind, type ModelChoice, type PlanState,
} from "./plan-model.ts";
import { brief, buildSchedule, slotForTopic } from "./schedule.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid operation input.");
  return input as Record<string, unknown>;
}

export type BackendOptions = { now?: () => Date; fetchDeps?: Parameters<typeof createFetchTool>[0] };

export function activate(ctx: PluginBackendContext, options: BackendOptions = {}): () => void {
  const now = options.now ?? (() => new Date());
  const today = () => localDate(now());
  const file = path.join(ctx.dataDirectory, "plan.json");
  let state: PlanState;
  let loadError: string | null = null;
  try {
    state = parseState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    state = emptyState(today());
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") loadError = `Could not read ${file}: ${(error as Error).message}`;
  }

  const cleanups: (() => void)[] = [];
  let disposed = false;
  const alive = () => { if (disposed || ctx.signal.aborted) throw new Error("Learning plan plugin is not active."); };
  const schedule = () => buildSchedule(state.plan, state.profile, today());

  // ---- Instructions: re-registered on change and when the date rolls over ----
  let instructionHandles: (() => void)[] = [];
  let instructionKey = "";
  function refreshInstructions() {
    if (disposed) return;
    const plan = !loadError ? state.plan : null;
    const current = plan ? schedule() : null;
    const teacher = plan && current ? buildInstructions(plan, state.profile, current, today(), "teacher") : "";
    const practice = plan && current ? buildInstructions(plan, state.profile, current, today(), "practice") : "";
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
    create: context => (loadError || !state.plan) ? [] : [
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
          const topic = input.topicId ? findTopic(state.plan, input.topicId)?.topic : topicForSession(state.plan, context.chatId);
          if (!topic) throw new Error(input.topicId ? `Unknown topic ${input.topicId}.` : "This session is not linked to a plan topic; pass topicId.");
          await change(current => setTopicStatus(current, topic.id, true, today(), input.note));
          const next = schedule().current;
          const upcoming = next?.kind === "topic" ? findTopic(state.plan, next.topicId)?.topic.title : next ? "a review session" : null;
          return {
            content: [{ type: "text" as const, text: `Marked "${topic.title}" done.${upcoming ? ` Next in the plan: ${upcoming} (${next!.date}).` : " The plan is complete."}` }],
            details: { topicId: topic.id, title: topic.title },
          };
        },
      },
      {
        name: START_TOOL_NAME,
        label: "Start plan topic",
        description: "Start a learning-plan item in this session when the learner chooses one: links the session to the topic in their calendar and returns the brief (topic, objectives, session part, length) to follow. Omit topicId for today's scheduled item.",
        parameters: {
          type: "object",
          properties: {
            topicId: { type: "string", pattern: "^t-\\d+$", description: "Plan topic ID such as t-12; omit for today's scheduled item." },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
          if (signal?.aborted || ctx.signal.aborted) throw new Error("Cancelled.");
          const plan = state.plan;
          if (!plan) throw new Error("No learning plan exists.");
          const sessionKind = context.agent === "practice" ? "practice" : "teaching";
          const input = params as { topicId?: string };
          const current = schedule().current;
          const topicId = input.topicId ?? (current?.kind === "topic" ? current.topicId : null);
          if (!topicId) {
            if (!current) throw new Error("Nothing is scheduled; every topic is done. Pass a topicId to revisit one.");
            // A review slot isn't one topic, so there is nothing to link.
            return { content: [{ type: "text" as const, text: brief(plan, current, state.profile, sessionKind) }], details: { topicId: null } };
          }
          const found = findTopic(plan, topicId);
          if (!found) throw new Error(`Unknown topic ${topicId}. Use ${OVERVIEW_TOOL_NAME} for topic IDs.`);
          // Re-starting in an already linked session keeps its part number.
          const linked = found.topic.sessionIds.indexOf(context.chatId);
          const slot = slotForTopic(plan, topicId, today())!;
          const part = linked >= 0 ? { ...slot, part: linked + 1 } : slot;
          await change(current => linkSession(current, topicId, context.chatId));
          const done = found.topic.status === "done" ? " (already marked done; this is a revisit)" : "";
          return {
            content: [{ type: "text" as const, text: `Linked this session to ${topicId}${done}.\n${brief(plan, part, state.profile, sessionKind)}` }],
            details: { topicId, title: found.topic.title },
          };
        },
      },
      {
        name: OVERVIEW_TOOL_NAME,
        label: "Learning plan overview",
        description: "Read the learner's full learning plan: modules, topic IDs, objectives, status and planned dates. Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_toolCallId: string, _input: unknown, signal?: AbortSignal) => {
          if (signal?.aborted || ctx.signal.aborted) throw new Error("Cancelled.");
          if (!state.plan) return { content: [{ type: "text" as const, text: "No learning plan exists." }], details: {} };
          return { content: [{ type: "text" as const, text: overviewText(state.plan, schedule()) }], details: { planId: state.plan.id } };
        },
      },
    ],
  }));

  // ---- Planning workers ----
  const workerTools = () => [createFetchTool(options.fetchDeps)];
  cleanups.push(ctx.workers.register({ id: GENERATE_WORKER_ID, instructions: generateInstructions, resultSchema: curriculumSchema, tools: workerTools, validateResult: result => { readCurriculum(result); } }));
  cleanups.push(ctx.workers.register({ id: REVISE_WORKER_ID, instructions: reviseInstructions, resultSchema: curriculumSchema, tools: workerTools, validateResult: result => { readCurriculum(result); } }));

  const observers = new Map<string, () => void>();
  function settle(requestId: string, task: Pick<PluginTaskSnapshot, "status" | "result" | "error">) {
    return change(current => {
      const draft = current.draft;
      if (!draft || draft.status !== "running" || draft.requestId !== requestId) return current;
      if (task.status === "succeeded") {
        try {
          return { ...current, draft: { status: "ready", kind: draft.kind, requestId, curriculum: readCurriculum(task.result) } };
        } catch (error) {
          return { ...current, draft: { status: "failed", kind: draft.kind, requestId, error: (error as Error).message } };
        }
      }
      return { ...current, draft: { status: "failed", kind: draft.kind, requestId, error: task.error?.message ?? `Planning ${task.status}.` } };
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
    const draft = state.draft;
    if (!draft || draft.status !== "running") return;
    const task = ctx.workers.list().find(candidate => candidate.requestId === draft.requestId);
    if (!task) {
      void change(current => current.draft?.requestId === draft.requestId
        ? { ...current, draft: { status: "failed", kind: draft.kind, requestId: draft.requestId, error: "Planning was interrupted before it finished. Try again." } }
        : current).catch(() => undefined);
    } else if (TERMINAL.has(task.status)) void settle(draft.requestId, task).catch(() => undefined);
    else {
      if (!draft.taskId) void change(current => current.draft?.requestId === draft.requestId ? { ...current, draft: { ...draft, taskId: task.id } } : current).catch(() => undefined);
      watch(draft.requestId, task.id);
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

  async function startDraft(kind: DraftKind, prompt: string) {
    if (state.draft?.status === "running") throw new Error("A planning run is already in progress.");
    const model = await resolveModel(state.profile.modelOverride);
    const requestId = randomUUID();
    await change(current => ({ ...current, draft: { status: "running", kind, requestId, taskId: null, startedAt: now().toISOString() } }));
    let task: PluginTaskSnapshot;
    try {
      task = ctx.workers.start(kind === "generate" ? GENERATE_WORKER_ID : REVISE_WORKER_ID, {
        requestId,
        input: { kind },
        prompt,
        model,
        purpose: "user",
        maxTurns: 25,
        options: { maxTokens: 16_000 },
        timeoutMs: 600_000,
      });
    } catch (error) {
      await change(current => ({ ...current, draft: { status: "failed", kind, requestId, error: (error as Error).message } }));
      throw error;
    }
    await change(current => current.draft?.requestId === requestId && current.draft.status === "running"
      ? { ...current, draft: { ...current.draft, taskId: task.id } } : current);
    if (TERMINAL.has(task.status)) await settle(requestId, task);
    else watch(requestId, task.id);
  }

  // ---- Frontend operations ----
  function view() {
    const draft = state.draft;
    let progress: { status: string; turns: number; activity?: string } | undefined;
    if (draft?.status === "running" && draft.taskId) {
      try {
        const task = ctx.workers.get(draft.taskId);
        progress = { status: task.status, turns: task.turns, ...(task.activity ? { activity: task.activity } : {}) };
      } catch { /* Reconciliation reports missing tasks. */ }
    }
    return { loadError, today: today(), profile: state.profile, plan: state.plan, draft, progress, schedule: schedule() };
  }
  function handle(name: string, handler: (input: Record<string, unknown>) => unknown) {
    cleanups.push(ctx.handle(name, input => { alive(); return handler(record(input ?? {})); }));
  }
  handle("get-state", () => view());
  handle("save-profile", async input => {
    const profile = readProfile({ ...input.profile as object, modelOverride: state.profile.modelOverride });
    await change(current => ({ ...current, profile: { ...profile, modelOverride: current.profile.modelOverride } }));
    return view();
  });
  handle("set-model-override", async input => {
    const model = input.model === null || input.model === undefined ? null : record(input.model);
    if (model && (typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id)) throw new Error("Invalid model.");
    await change(current => ({ ...current, profile: { ...current.profile, modelOverride: model ? { provider: model.provider as string, id: model.id as string } : null } }));
    return view();
  });
  handle("generate", async input => {
    if (typeof input.goal !== "string" || !/\S/.test(input.goal)) throw new Error("Describe your background and goal first.");
    if (input.goal.length > LIMITS.goalPrompt) throw new Error(`The goal is longer than ${LIMITS.goalPrompt} characters.`);
    if (!state.profile.weekdays.length) throw new Error("Choose at least one study day first.");
    const goal = input.goal.trim();
    await change(current => ({ ...current, profile: { ...current.profile, goalPrompt: goal } }));
    await startDraft("generate", generatePrompt(goal, state.profile));
    return view();
  });
  handle("revise", async input => {
    if (!state.plan) throw new Error("Generate a plan first.");
    if (typeof input.request !== "string" || !/\S/.test(input.request)) throw new Error("Describe how the plan should change.");
    if (input.request.length > LIMITS.revisionPrompt) throw new Error(`The request is longer than ${LIMITS.revisionPrompt} characters.`);
    await startDraft("revise", revisePrompt(state.plan, input.request.trim(), state.profile));
    return view();
  });
  handle("draft-accept", async () => {
    const draft = state.draft;
    if (draft?.status !== "ready") throw new Error("There is no plan draft to accept.");
    await change(current => {
      if (current.draft?.requestId !== draft.requestId || current.draft.status !== "ready") throw new Error("The draft changed. Review it again.");
      const accepted = draft.kind === "generate"
        ? acceptGenerated(current, current.draft.curriculum, now().toISOString(), randomUUID())
        : acceptRevision(current, current.draft.curriculum);
      // A fresh plan starts today unless the learner chose a later start.
      const profile = draft.kind === "generate" && current.profile.startDate < today() ? { ...current.profile, startDate: today() } : current.profile;
      return { ...accepted, profile, draft: null };
    });
    return view();
  });
  handle("draft-discard", async () => {
    const draft = state.draft;
    if (draft?.status === "running" && draft.taskId) {
      try { ctx.workers.cancel(draft.taskId); } catch { /* Already finished. */ }
    }
    await change(current => ({ ...current, draft: null }));
    return view();
  });
  handle("save-plan", async input => { await change(current => applyManualEdit(current, input.modules)); return view(); });
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
