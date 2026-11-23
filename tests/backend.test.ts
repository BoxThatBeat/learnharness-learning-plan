import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext, PluginInstructions, PluginTools, PluginWorkerDefinition } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { Curriculum } from "../src/plan-model.ts";

type Outcome = { status: "succeeded"; result: unknown } | { status: "failed"; error: { code: string; message: string } };

const curriculum: Curriculum = {
  title: "EE plan", summary: "s", sources: [],
  modules: [{ title: "Circuits", topics: [
    { title: "Ohm's law", objectives: ["V=IR"], sessions: 1, lab: false, resources: [] },
    { title: "RC circuits", objectives: ["tau"], sessions: 2, lab: true, resources: [] },
  ] }],
};

function fakeHost(dataDirectory: string) {
  const instructions = new Map<number, PluginInstructions>();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const workers = new Map<string, PluginWorkerDefinition>();
  const started: { id: string; prompt: string; model: unknown; purpose: string }[] = [];
  let tools: PluginTools | undefined;
  let nextInstruction = 0;
  const tasks = new Map<string, { id: string; requestId: string; status: string; turns: number; result?: unknown; error?: unknown; settle: () => void; done: Promise<void> }>();
  const ctx = {
    dataDirectory,
    signal: new AbortController().signal,
    cleanup() {},
    events: { emit() {}, on() { return () => {}; } },
    registerInstructions(value: PluginInstructions) { const id = nextInstruction++; instructions.set(id, value); return () => { instructions.delete(id); }; },
    registerTools(value: PluginTools) { tools = value; return () => { tools = undefined; }; },
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    inference: { async catalog() { return { slots: { strong: { model: { provider: "test", id: "strong" } }, cheap: null }, models: [{ provider: "test", id: "strong", supportedLevels: [] }] }; } },
    workers: {
      register(definition: PluginWorkerDefinition) { workers.set(definition.id, definition); return () => {}; },
      start(id: string, options: { requestId: string; prompt: string; model: unknown; purpose: string }) {
        started.push({ id, prompt: options.prompt, model: options.model, purpose: options.purpose });
        let settle!: () => void;
        const done = new Promise<void>(resolve => { settle = resolve; });
        const task = { id: `task-${tasks.size + 1}`, requestId: options.requestId, status: "running", turns: 0, settle, done };
        tasks.set(task.id, task);
        return { ...task };
      },
      list() { return [...tasks.values()]; },
      get(id: string) { return tasks.get(id)!; },
      subscribe() { return () => {}; },
      async wait(id: string) { await tasks.get(id)!.done; return { id }; },
      cancel(id: string) { const task = tasks.get(id)!; task.status = "cancelled"; task.error = { code: "cancelled", message: "Cancelled." }; task.settle(); },
    },
  };
  return {
    ctx: ctx as unknown as PluginBackendContext,
    call: (name: string, input: unknown = {}) => Promise.resolve(handlers.get(name)!(input)) as Promise<any>,
    instructions: () => [...instructions.values()],
    tools: (chatId = "chat-1") => tools?.create({ chatId, agent: "teacher" }) ?? [],
    workers, started,
    finish(outcome: Outcome) {
      for (const task of tasks.values()) if (task.status === "running") { Object.assign(task, outcome); task.settle(); }
    },
  };
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "learning-plan-"));
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const clock = (iso: string) => () => new Date(iso);

/** Add a course (p-1 unless others exist), generate and accept its plan. Returns the state view. */
async function withPlan(host: ReturnType<typeof fakeHost>, goal = "CS grad → EE, circuits and radio", result: unknown = curriculum) {
  const { created } = await host.call("add-plan");
  await host.call("save-profile", { planId: created, profile: { weekdays: [1, 3, 5], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: 4, goalPrompt: "" } });
  await host.call("generate", { planId: created, goal });
  host.finish({ status: "succeeded", result });
  await flush();
  return host.call("draft-accept", { planId: created });
}

test("generate runs the strong-slot worker with the user's goal, then accept creates a scheduled plan", async () => {
  const dir = temp();
  const host = fakeHost(dir);
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  assert.equal(host.instructions().length, 0);
  assert.equal(host.tools().length, 0);
  const state = await withPlan(host);
  const view = state.plans[0];
  assert.equal(host.started[0]!.id, "plan-generate-v1");
  assert.equal(host.started[0]!.purpose, "user");
  assert.deepEqual(host.started[0]!.model, { provider: "test", id: "strong" });
  assert.match(host.started[0]!.prompt, /CS grad → EE[\s\S]*3 sessions per week \(Monday, Wednesday, Friday\), about 45 minutes[\s\S]*about 4 weeks, i\.e\. roughly 12 sessions/);
  assert.equal(host.workers.get("plan-generate-v1")!.tools!({ taskId: "t", input: {}, signal: new AbortController().signal })[0]!.name, "fetch_url");
  assert.equal(view.plan.title, "EE plan");
  assert.equal(view.draft, null);
  assert.equal(view.archived, false);
  assert.ok(Number.isInteger(view.hue) && view.hue >= 0 && view.hue < 360);
  assert.deepEqual(view.schedule.slots.map((slot: { date: string }) => slot.date), ["2026-11-02", "2026-11-04", "2026-11-06"]);
  assert.equal(view.profile.goalPrompt, "CS grad → EE, circuits and radio");
  const [teacher, practice] = host.instructions();
  assert.deepEqual([teacher!.agents, practice!.agents], [["teacher"], ["practice"]]);
  assert.match(teacher!.text, /"EE plan" \(0 of 2 topics done; today is 2026-11-02\)[\s\S]*2026-11-02: Ohm's law \[t-3\]/);
  assert.deepEqual(fs.readdirSync(dir), ["plan.json"]);
});

test("complete-topic tool uses the session linked by kickoff and reports the next item", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  await host.call("link-session", { topicId: "t-3", sessionId: "chat-9" });
  const complete = host.tools("chat-9").find(tool => tool.name === "learning_plan_complete_topic")!;
  const result = await complete.execute("call", { note: "Solved three divider problems" });
  assert.match((result.content[0] as { text: string }).text, /Marked "Ohm's law" done\. Next in the plan: RC circuits \(2026-11-04\)/);
  const view = (await host.call("get-state")).plans[0];
  assert.equal(view.plan.modules[0].topics[0].completionNote, "Solved three divider problems");
  await assert.rejects(host.tools("other").find(tool => tool.name === "learning_plan_complete_topic")!.execute("call", { note: "x" }), /not linked/);
  const overview = await host.tools().find(tool => tool.name === "learning_plan_overview")!.execute("call", {});
  assert.match((overview.content[0] as { text: string }).text, /\[t-3\] Ohm's law \(1 session, done 2026-11-02\)/);
});

test("start-topic tool links a session started without the button and returns the brief", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  assert.match(host.instructions()[0]!.text, /offers today's planned item \(2026-11-02: Ohm's law \[t-3\]\)[\s\S]*call learning_plan_start_topic/);
  const start = (chatId: string) => host.tools(chatId).find(tool => tool.name === "learning_plan_start_topic")!;

  const today = await start("chat-new").execute("call", {});
  assert.match((today.content[0] as { text: string }).text, /^Linked this session to t-3\.\n\[Learning plan\] Teach me "Ohm's law" \(module: Circuits; about 45 minutes\)\.\nObjectives:\n- V=IR$/);
  let view = (await host.call("get-state")).plans[0];
  assert.deepEqual(view.plan.modules[0].topics[0].sessionIds, ["chat-new"]);

  const second = await start("chat-rc").execute("call", { topicId: "t-4" });
  assert.match((second.content[0] as { text: string }).text, /session 1 of 2/);
  const again = await start("chat-rc").execute("call", { topicId: "t-4" });
  assert.match((again.content[0] as { text: string }).text, /session 1 of 2/, "re-starting in the same session keeps its part");
  view = (await host.call("get-state")).plans[0];
  assert.deepEqual(view.plan.modules[0].topics[1].sessionIds, ["chat-rc"]);

  const complete = host.tools("chat-new").find(tool => tool.name === "learning_plan_complete_topic")!;
  await complete.execute("call", { note: "ok" });
  await assert.rejects(start("x").execute("call", { topicId: "t-100" }), /Unknown topic t-100/);
});

test("revise keeps completed topics; failed runs are reported; one run at a time", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  await host.call("set-topic-status", { topicId: "t-3", done: true });
  await host.call("revise", { planId: "p-1", request: "more RF" });
  await assert.rejects(host.call("revise", { planId: "p-1", request: "again" }), /already in progress/);
  assert.equal(host.started[1]!.id, "plan-revise-v1");
  assert.match(host.started[1]!.prompt, /\[done\] Ohm's law[\s\S]*\[todo\] RC circuits[\s\S]*more RF/);
  host.finish({ status: "succeeded", result: { ...curriculum, modules: [{ title: "RF", topics: [{ title: "Antennas", objectives: ["x"], sessions: 1, lab: false, resources: [] }] }] } });
  await flush();
  const accepted = (await host.call("draft-accept", { planId: "p-1" })).plans[0];
  assert.deepEqual(accepted.plan.modules.flatMap((module: { topics: { title: string; status: string }[] }) => module.topics.map(topic => `${topic.title}:${topic.status}`)), ["Ohm's law:done", "Antennas:todo"]);

  await host.call("revise", { planId: "p-1", request: "x" });
  host.finish({ status: "failed", error: { code: "no_result", message: "No result." } });
  await flush();
  const failed = (await host.call("get-state")).plans[0];
  assert.equal(failed.draft.status, "failed");
  assert.equal(failed.draft.error, "No result.");
});

test("data persists across restarts and newer formats are never overwritten", async () => {
  const dir = temp();
  const host = fakeHost(dir);
  const dispose = activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  const hue = (await withPlan(host)).plans[0].hue;
  dispose();
  const again = fakeHost(dir);
  activate(again.ctx, { now: clock("2026-11-09T12:00:00") });
  const view = (await again.call("get-state")).plans[0];
  assert.equal(view.plan.title, "EE plan");
  assert.equal(view.hue, hue, "the colour never changes");
  assert.deepEqual(view.schedule.slots.map((slot: { state: string }) => slot.state), ["overdue", "overdue", "overdue"]);

  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify({ version: 7 }));
  const newer = fakeHost(dir);
  activate(newer.ctx);
  assert.match((await newer.call("get-state")).loadError, /newer than this plugin understands/);
  await assert.rejects(newer.call("add-plan"), /Fix or move the file/);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ version: 7 }));
});

const second: Curriculum = {
  title: "Math plan", summary: "s", sources: [],
  modules: [{ title: "Analysis", topics: [{ title: "Limits", objectives: ["epsilon-delta"], sessions: 1, lab: false, resources: [] }] }],
};

test("several plans: independent settings and colours, shared agent context, tools route by topic or plan", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  const first = (await withPlan(host)).plans[0];
  const both = await withPlan(host, "Math goal", second);
  const [a, b] = both.plans;
  assert.deepEqual([a.id, b.id], ["p-1", "p-5"]);
  assert.notEqual(a.hue, b.hue);
  assert.equal(a.hue, first.hue);
  assert.equal(a.plan.title, "EE plan");
  assert.equal(b.plan.title, "Math plan");

  // Settings are per plan.
  const changed = await host.call("save-profile", { planId: "p-5", profile: { ...b.profile, weekdays: [2], minutesPerSession: 20 } });
  assert.deepEqual(changed.plans.map((plan: { profile: { weekdays: number[] } }) => plan.profile.weekdays), [[1, 3, 5], [2]]);
  await host.call("set-model-override", { planId: "p-5", model: { provider: "p", id: "m" } });
  await host.call("rename-plan", { planId: "p-5", name: "  Maths  " });
  const renamed = await host.call("get-state");
  assert.deepEqual(renamed.plans.map((plan: { profile: { modelOverride: unknown }; name: string }) => [plan.profile.modelOverride, plan.name]), [[null, ""], [{ provider: "p", id: "m" }, "Maths"]]);
  assert.equal(renamed.plans[0].profile.goalPrompt, "CS grad → EE, circuits and radio");

  // The teacher sees both plans; the same text goes to the practice agent.
  const [teacher] = host.instructions();
  assert.match(teacher!.text, /2 learning plans in parallel[\s\S]*"EE plan" \[p-1\][\s\S]*"Maths" \[p-5\]/);

  // Overview covers every plan or one.
  const overview = host.tools().find(tool => tool.name === "learning_plan_overview")!;
  const all = (await overview.execute("c", {})).content[0] as { text: string };
  assert.match(all.text, /\[p-1\] EE plan[\s\S]*\[t-3\] Ohm's law[\s\S]*\[p-5\] Maths[\s\S]*\[t-7\] Limits/);
  const one = (await overview.execute("c", { planId: "p-5" })).content[0] as { text: string };
  assert.doesNotMatch(one.text, /Ohm's law/);

  // Start: a topic id picks its own plan; without one the earliest-due plan wins; planId overrides.
  const start = (chat: string) => host.tools(chat).find(tool => tool.name === "learning_plan_start_topic")!;
  const byTopic = (await start("c-math").execute("c", { topicId: "t-7" })).content[0] as { text: string };
  assert.match(byTopic.text, /Linked this session to t-7\.\n\[Learning plan\] Teach me "Limits" \(module: Analysis; about 20 minutes\)/);
  const byPlan = (await start("c-ee").execute("c", { planId: "p-1" })).content[0] as { text: string };
  assert.match(byPlan.text, /Linked this session to t-3\./);
  await assert.rejects(start("x").execute("c", { planId: "p-99" }), /Unknown plan p-99/);

  // Completing resolves the topic's plan, and the session's own link when no id is given.
  const complete = host.tools("c-math").find(tool => tool.name === "learning_plan_complete_topic")!;
  assert.match(((await complete.execute("c", { note: "ok" })).content[0] as { text: string }).text, /Marked "Limits" done\. The plan is complete\./);
  const state = await host.call("get-state");
  assert.equal(state.plans[1].plan.modules[0].topics[0].status, "done");
  assert.equal(state.plans[0].plan.modules[0].topics[0].status, "todo");
});

test("archiving hides a plan from agents and keeps its state; unarchiving restores it; removing deletes it", async () => {
  const dir = temp();
  const host = fakeHost(dir);
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  await withPlan(host, "Math goal", second);
  await host.call("set-topic-status", { topicId: "t-3", done: true });

  const archived = await host.call("set-plan-archived", { planId: "p-1", archived: true });
  assert.equal(archived.plans[0].archived, true);
  assert.equal(archived.plans[0].plan.modules[0].topics[0].status, "done", "progress is kept");
  assert.match(host.instructions()[0]!.text, /^The learner follows a learning plan: "Math plan"/);
  const overview = host.tools().find(tool => tool.name === "learning_plan_overview")!;
  assert.doesNotMatch(((await overview.execute("c", {})).content[0] as { text: string }).text, /Ohm's law/);
  await assert.rejects(host.call("generate", { planId: "p-1", goal: "again" }), /archived/);
  const start = host.tools("x").find(tool => tool.name === "learning_plan_start_topic")!;
  await assert.rejects(start.execute("c", { topicId: "t-4" }), /Unknown topic t-4/);

  // Archive state and progress survive a restart.
  const again = fakeHost(dir);
  activate(again.ctx, { now: clock("2026-11-02T12:00:00") });
  const reloaded = await again.call("get-state");
  assert.deepEqual(reloaded.plans.map((plan: { archived: boolean }) => plan.archived), [true, false]);
  assert.equal(reloaded.plans[0].plan.modules[0].topics[0].status, "done");

  const restored = await again.call("set-plan-archived", { planId: "p-1", archived: false });
  assert.equal(restored.plans[0].archived, false);
  assert.match(again.instructions()[0]!.text, /2 learning plans in parallel/);
  assert.equal(restored.plans[0].plan.modules[0].topics[0].status, "done");

  const removed = await again.call("remove-plan", { planId: "p-1" });
  assert.deepEqual(removed.plans.map((plan: { id: string }) => plan.id), ["p-5"]);
  await assert.rejects(again.call("save-profile", { planId: "p-1", profile: {} }), /no longer exists/);
  const added = await again.call("add-plan");
  assert.notEqual(added.created, "p-1", "IDs are never reused");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")).version, 2);
});

test("plans plan and fail independently, and a format-1 file is migrated to one course", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  const { created: a } = await host.call("add-plan");
  const { created: b } = await host.call("add-plan");
  await host.call("generate", { planId: a, goal: "A" });
  await host.call("generate", { planId: b, goal: "B" });
  assert.deepEqual(host.started.map(run => run.id), ["plan-generate-v1", "plan-generate-v1"]);
  await assert.rejects(host.call("generate", { planId: a, goal: "A again" }), /already in progress for this plan/);
  host.finish({ status: "failed", error: { code: "x", message: "Nope." } });
  await flush();
  const view = await host.call("get-state");
  assert.deepEqual(view.plans.map((plan: { draft: { status: string } }) => plan.draft.status), ["failed", "failed"]);
  await host.call("draft-discard", { planId: a });
  assert.equal((await host.call("get-state")).plans[0].draft, null);
  assert.equal((await host.call("get-state")).plans[1].draft.status, "failed");

  const dir = temp();
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
    version: 1, nextId: 4,
    profile: { weekdays: [1], minutesPerSession: 30, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: null, modelOverride: null, goalPrompt: "old" },
    plan: { id: "u", title: "Old plan", summary: "", createdAt: "now", sources: [], modules: [{ id: "m-1", title: "M", topics: [{ id: "t-2", title: "T", objectives: [], sessions: 1, resources: [], status: "todo", completedAt: null, completionNote: "", sessionIds: [] }] }] },
    draft: null,
  }));
  const old = fakeHost(dir);
  activate(old.ctx, { now: clock("2026-11-02T12:00:00") });
  const migrated = await old.call("get-state");
  assert.deepEqual(migrated.plans.map((plan: { id: string; plan: { title: string } }) => [plan.id, plan.plan.title]), [["p-4", "Old plan"]]);
  await old.call("rename-plan", { planId: "p-4", name: "Renamed" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")).version, 2);
});

test("the planning workers reject lessons spanning several sessions and overloaded sessions, with correction feedback", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  const topic = (extra: object) => ({ title: "T", objectives: ["a"], sessions: 1, lab: false, resources: [], ...extra });
  const wrap = (...topics: object[]) => ({ ...curriculum, modules: [{ title: "M", topics }] });
  for (const id of ["plan-generate-v1", "plan-revise-v1"]) {
    const validate = host.workers.get(id)!.validateResult!;
    const context = { taskId: "t", input: {}, signal: new AbortController().signal };
    await validate(wrap(topic({}), topic({ title: "Lab", lab: true, sessions: 3 })), context);
    await assert.rejects(async () => validate(wrap(topic({ title: "Long lesson", sessions: 2 })), context), /Fix these.*"Long lesson" has 2 sessions but is not a lab/s);
    await assert.rejects(async () => validate(wrap(topic({ title: "Packed", objectives: ["1", "2", "3", "4", "5"] })), context), /"Packed" lists 5 objectives/);
  }
});
