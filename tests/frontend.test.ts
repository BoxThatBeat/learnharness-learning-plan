/** DOM smoke/integration test: the real frontend against the real backend through a fake
 * host. Host widgets are minimal stand-ins (plain buttons/dialog containers), so this checks
 * plugin logic and wiring, not host rendering. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { PluginAction, PluginBackendContext, PluginFrontendContext, PluginSubmissionInterceptor, PluginView } from "learnharness-plugin-api";
import { activate as activateBackend } from "../src/backend.ts";
import { activate as activateFrontend } from "../src/main.ts";

const window = new Window();
Object.assign(globalThis, { document: window.document, HTMLElement: window.HTMLElement });
const doc = window.document as unknown as Document;
const flush = () => new Promise(resolve => setTimeout(resolve, 25));

const curriculum = {
  title: "EE plan", summary: "Circuits first.", sources: [],
  modules: [{ title: "Circuits", topics: [
    { title: "Ohm's law", objectives: ["Apply V=IR"], sessions: 1, resources: [{ title: "Notes", url: "https://example.edu/ohm" }] },
    { title: "RC circuits", objectives: ["tau"], sessions: 2, lab: true, resources: [] },
  ] }],
};

function backend() {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const tasks: { status: string; result?: unknown; settle: () => void; done: Promise<void>; requestId: string; id: string; turns: number }[] = [];
  const ctx = {
    dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "learning-plan-ui-")),
    signal: new AbortController().signal,
    events: { emit() {}, on() { return () => {}; } },
    registerInstructions() { return () => {}; },
    registerTools() { return () => {}; },
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => {}; },
    inference: { async catalog() { return { slots: { strong: { model: { provider: "p", id: "m" } } }, models: [{ provider: "p", id: "m", supportedLevels: [] }] }; } },
    workers: {
      register() { return () => {}; },
      start(_id: string, options: { requestId: string }) {
        let settle!: () => void;
        const done = new Promise<void>(resolve => { settle = resolve; });
        const task = { id: `task-${tasks.length}`, requestId: options.requestId, status: "running", turns: 0, settle, done };
        tasks.push(task);
        return { ...task };
      },
      list: () => tasks,
      get: (id: string) => tasks.find(task => task.id === id)!,
      subscribe() { return () => {}; },
      async wait(id: string) { await tasks.find(task => task.id === id)!.done; return { id }; },
      cancel() {},
    },
  };
  activateBackend(ctx as unknown as PluginBackendContext, { now: () => new Date("2026-11-02T12:00:00"), random: () => 0.5 });
  return {
    call: (name: string, input: unknown = {}) => Promise.resolve().then(() => handlers.get(name)!(input)),
    finish() { for (const task of tasks) if (task.status === "running") { task.status = "succeeded"; task.result = curriculum; task.settle(); } },
  };
}

function frontendHost(call: (name: string, input?: unknown) => Promise<unknown>) {
  const views = new Map<string, PluginView>();
  const actions = new Map<string, PluginAction>();
  const placements: unknown[] = [];
  const interceptors: PluginSubmissionInterceptor[] = [];
  const calls: string[] = [];
  let settings: ((container: HTMLElement, signal: AbortSignal) => unknown) | undefined;
  const button = (container: HTMLElement, props: Record<string, unknown>, options: { signal: AbortSignal }) => {
    const node = doc.createElement("button");
    let current = { ...props };
    const paint = () => { node.textContent = String(current.label); node.disabled = Boolean(current.disabled); };
    node.addEventListener("click", () => { if (!current.disabled) void (current.onClick as () => unknown)(); });
    paint();
    container.append(node);
    options.signal.addEventListener("abort", () => node.remove());
    return { update(next: Record<string, unknown>) { current = { ...current, ...next }; paint(); }, dispose() { node.remove(); } };
  };
  const ctx = {
    signal: new AbortController().signal,
    call: async (name: string, input?: unknown) => { calls.push(name); return call(name, input); },
    registerView(view: PluginView) { views.set(view.id, view); return () => {}; },
    registerAction(action: PluginAction) { actions.set(action.id, action); return () => {}; },
    placeAction(placement: unknown) { placements.push(placement); return () => {}; },
    registerSettings(mount: typeof settings) { settings = mount; return () => {}; },
    registerSubmissionInterceptor(definition: PluginSubmissionInterceptor) { interceptors.push(definition); return () => {}; },
    refreshSubmissions() {},
    onNotification() { return () => {}; },
    onResync() { return () => {}; },
    app: { openView() {}, openSettings() {}, openSession() {}, openHome() {}, pathname: () => "/" },
    ui: {
      mountButton: button,
      mountModelPicker(container: HTMLElement) { const node = doc.createElement("span"); container.append(node); return { update() {}, dispose() { node.remove(); } }; },
      openDialog(props: { content: (container: HTMLElement, signal: AbortSignal) => unknown }) {
        const controller = new AbortController();
        const box = doc.createElement("div");
        box.className = "test-dialog";
        doc.body.append(box);
        const cleanup = props.content(box, controller.signal);
        return { update() {}, dispose() { controller.abort(); if (typeof cleanup === "function") (cleanup as () => void)(); box.remove(); } };
      },
    },
  };
  activateFrontend(ctx as unknown as PluginFrontendContext);
  return { views, actions, placements, interceptors, calls, settings: () => settings! };
}

const clickButton = (root: ParentNode, label: string) => {
  const target = [...root.querySelectorAll("button")].find(node => node.textContent === label);
  assert.ok(target, `button "${label}" exists`);
  (target as HTMLButtonElement).click();
};

test("sidebar tab, calendar, curriculum editing and the kickoff interceptor work end to end", async () => {
  const server = backend();
  const { created } = await server.call("add-plan") as { created: string };
  await server.call("save-profile", { planId: created, profile: { weekdays: [1, 3, 5], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: null, goalPrompt: "" } });
  const host = frontendHost(server.call);
  assert.deepEqual(host.placements.map(placement => (placement as { location: string }).location).sort(), ["sidebar", "top-bar"]);

  // Settings: generate a plan through the UI and accept the draft.
  const settingsRoot = doc.createElement("div");
  doc.body.append(settingsRoot);
  const settingsSignal = new AbortController();
  host.settings()(settingsRoot, settingsSignal.signal);
  await flush();
  const boxes = [...settingsRoot.querySelectorAll(".lp-day-toggle input")] as HTMLInputElement[];
  assert.deepEqual(boxes.map(box => box.checked), [true, false, true, false, true, false, false]);
  (settingsRoot.querySelector("textarea") as HTMLTextAreaElement).value = "CS grad → EE";
  settingsRoot.querySelector("textarea")!.dispatchEvent(new window.Event("input") as unknown as Event);
  clickButton(settingsRoot, "Generate plan");
  await flush();
  assert.match(settingsRoot.textContent ?? "", /Generating your plan/);
  server.finish();
  await flush();
  await (host.settings() && server.call("get-state"));
  // No live notifications in this fake: re-mount settings to read the ready draft.
  settingsSignal.abort();
  settingsRoot.replaceChildren();
  host.settings()(settingsRoot, new AbortController().signal);
  await flush();
  assert.match(settingsRoot.textContent ?? "", /Draft ready: "EE plan" — 1 modules, 2 topics, 3 sessions/);
  clickButton(settingsRoot, "Accept plan");
  await flush();
  assert.match(settingsRoot.textContent ?? "", /Regenerate plan/);

  // Calendar view.
  const viewRoot = doc.createElement("div");
  doc.body.append(viewRoot);
  host.views.get("calendar")!.mount(viewRoot, new AbortController().signal);
  await flush();
  assert.equal(viewRoot.querySelector(".lp-title")!.textContent, "Learning plan");
  assert.match(viewRoot.querySelector(".lp-plan-row")!.textContent!, /EE plan[\s\S]*0 of 2 topics done/);
  assert.match(viewRoot.querySelector(".lp-howto")!.textContent!, /new Teaching or Practice session and type “start today's topic”/);
  const chips = [...viewRoot.querySelectorAll(".lp-grid .lp-chip")].map(node => `${node.textContent}|${node.className}`);
  assert.deepEqual(chips, ["Ohm's law|lp-chip lp-chip--today lp-bar", "RC circuits (1–2/2)|lp-chip lp-chip--upcoming lp-bar"]);
  const color = (viewRoot.querySelector(".lp-chip--today") as HTMLElement).style.getPropertyValue("--lp-plan");
  assert.match(color, /^hsl\(\d+ 65% 52%\)$/, "chips carry their course colour");
  (viewRoot.querySelector(".lp-chip--today") as HTMLButtonElement).click();
  const detail = doc.querySelector(".test-dialog")!;
  assert.match(detail.textContent!, /Ohm's law[\s\S]*Apply V=IR[\s\S]*Notes/);
  assert.match(detail.textContent!, /type “start t-3”/);
  assert.equal((detail.querySelector("a") as HTMLAnchorElement).rel, "noopener noreferrer");
  assert.deepEqual([...detail.querySelectorAll("button")].map(node => node.textContent).slice(-2), ["Copy prompt", "Mark done"]);
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  clickButton(detail as HTMLElement, "Copy prompt");
  await flush();
  assert.match(copied, /^\[Learning plan\] Teach me "Ohm's law" \(module: .*; about 45 minutes\)\.\nObjectives:\n- Apply V=IR/);
  assert.match(detail.textContent!, /Prompt copied\./);
  detail.remove();

  // Curriculum editing keeps focus while typing and saves.
  clickButton(viewRoot, "Curriculum");
  assert.deepEqual([...viewRoot.querySelectorAll(".lp-tabs--plans .lp-tab")].map(node => node.textContent), ["EE plan"]);
  const title = viewRoot.querySelector(".lp-topic input") as HTMLInputElement;
  title.focus();
  title.value = "Ohm's and Kirchhoff's laws";
  title.dispatchEvent(new window.Event("input") as unknown as Event);
  assert.equal(title.isConnected, true, "typing does not re-render the editor");
  clickButton(viewRoot, "Save changes");
  await flush();
  const saved = (await server.call("get-state") as { plans: { plan: { modules: { topics: { title: string }[] }[] } }[] }).plans[0]!;
  assert.equal(saved.plan.modules[0]!.topics[0]!.title, "Ohm's and Kirchhoff's laws");

  // Kickoff from a teaching session's top bar.
  const interceptor = host.interceptors[0]!;
  const target = { type: "text", sessionId: "s-1", sessionKind: "teaching", channels: ["content"] } as never;
  assert.equal(interceptor.hasPendingInput!(target), false);
  await host.actions.get("todays-topic")!.run({ placement: "top-bar", surface: "session", sessionId: "s-1", kind: "teaching" } as never);
  await flush();
  const dialog = doc.querySelector(".test-dialog")!;
  assert.match(dialog.querySelector("pre")!.textContent!, /^\[Learning plan\] Teach me "Ohm's and Kirchhoff's laws"/);
  clickButton(dialog, "Attach to my next message");
  assert.equal(interceptor.hasPendingInput!(target), true);
  const accepted: (() => void | Promise<void>)[] = [];
  const result = await interceptor.intercept(
    { type: "text", content: { text: "go", images: [] } },
    { ...(target as object), messages: [], signal: new AbortController().signal, onAccepted: (callback: () => void) => accepted.push(callback) } as never,
  ) as { content: { text: string } };
  assert.match(result.content.text, /^\[Learning plan\] Teach me[\s\S]*\n\ngo$/);
  assert.equal(interceptor.hasPendingInput!(target), true, "still attached until the host acknowledges the send");
  await accepted[0]!();
  assert.equal(interceptor.hasPendingInput!(target), false);
  const linked = (await server.call("get-state") as { plans: { plan: { modules: { topics: { sessionIds: string[] }[] }[] } }[] }).plans[0]!;
  assert.deepEqual(linked.plan.modules[0]!.topics[0]!.sessionIds, ["s-1"]);
  assert.equal(await interceptor.intercept({ type: "text", content: { text: "next", images: [] } }, { ...(target as object), onAccepted() {} } as never), undefined);
});

/** Create, plan and accept a course directly on the backend (the fake host has no live notifications). */
async function addCourse(server: ReturnType<typeof backend>, name: string) {
  const { created } = await server.call("add-plan") as { created: string };
  await server.call("save-profile", { planId: created, profile: { weekdays: [1, 3, 5], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: null, goalPrompt: "" } });
  await server.call("generate", { planId: created, goal: name });
  server.finish();
  await flush();
  await server.call("draft-accept", { planId: created });
  await server.call("rename-plan", { planId: created, name });
  return created;
}

const mount = async (host: ReturnType<typeof frontendHost>, id = "calendar") => {
  const root = doc.createElement("div");
  doc.body.append(root);
  host.views.get(id)!.mount(root, new AbortController().signal);
  await flush();
  return root;
};

test("the calendar shows every active plan together, stacks same-day sessions and keeps colours apart", async () => {
  const server = backend();
  await addCourse(server, "Circuits course");
  await addCourse(server, "Math course");
  await addCourse(server, "Music course");
  const host = frontendHost(server.call);
  const root = await mount(host);

  assert.deepEqual([...root.querySelectorAll(".lp-plan-row strong")].map(node => node.textContent), ["Circuits course", "Math course", "Music course"]);
  const firstWeek = root.querySelectorAll(".lp-week")[1] as HTMLElement; // the row holding Monday 2026-11-02
  // 2026-11-02 is a Monday: all three courses start "Ohm's law" that day, in separate rows, in input order.
  const monday = [...root.querySelectorAll(".lp-chip")].filter(node => node.textContent === "Ohm's law") as HTMLElement[];
  assert.equal(monday.length, 3);
  assert.equal(new Set(monday.map(node => node.style.gridRow)).size, 3, "stacked, not overlapping");
  assert.deepEqual(monday.map(node => node.style.gridColumn), ["1 / span 1", "1 / span 1", "1 / span 1"]);
  assert.deepEqual(monday.map(node => node.title.split(":")[0]), ["Circuits course", "Math course", "Music course"]);
  const colours = monday.map(node => node.style.getPropertyValue("--lp-plan"));
  assert.equal(new Set(colours).size, 3, "one colour per course");
  const hues = colours.map(value => Number(/hsl\((\d+)/.exec(value)![1]));
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) assert.ok(Math.min(Math.abs(hues[i]! - hues[j]!), 360 - Math.abs(hues[i]! - hues[j]!)) >= 40, `hues ${hues} are well separated`);
  assert.ok(firstWeek.contains(monday[0]!));
  // Today is shown only by the circled day number on its cell.
  assert.equal(root.querySelectorAll(".lp-day__number.is-today").length, 1);
  assert.deepEqual([...root.querySelectorAll(".lp-legend > span")].map(node => node.textContent), ["Circuits course", "Math course", "Music course", "Done", "Overdue"]);

  // Completing a topic marks that course's chip done (a check mark is drawn in CSS); others are untouched.
  const state = await server.call("get-state") as { plans: { id: string; plan: { modules: { topics: { id: string }[] }[] } }[] };
  await server.call("set-topic-status", { topicId: state.plans[1]!.plan.modules[0]!.topics[0]!.id, done: true });
  const doneRoot = await mount(host);
  const states = [...doneRoot.querySelectorAll(".lp-chip")].filter(node => node.textContent === "Ohm's law").map(node => node.className.match(/lp-chip--(\w+)/)![1]);
  assert.deepEqual(states, ["today", "done", "today"]);

  // Curriculum has a tab per course.
  clickButton(doneRoot, "Curriculum");
  assert.deepEqual([...doneRoot.querySelectorAll(".lp-tabs--plans .lp-tab")].map(node => node.textContent), ["Circuits course", "Math course", "Music course"]);
  clickButton(doneRoot, "Math course");
  assert.match(doneRoot.querySelector(".lp-title")!.textContent!, /EE plan/);
  assert.match(doneRoot.querySelector(".lp-hint")!.textContent!, /1 of 2 topics done/);
  assert.equal(doneRoot.querySelector(".lp-topic.is-done") !== null, true);

  // Archiving from the curriculum tab hides the course everywhere but keeps its state.
  clickButton(doneRoot, "Archive plan");
  await flush();
  assert.deepEqual([...doneRoot.querySelectorAll(".lp-tabs--plans .lp-tab")].map(node => node.textContent), ["Circuits course", "Music course"]);
  clickButton(doneRoot, "Calendar");
  assert.equal([...doneRoot.querySelectorAll(".lp-chip")].filter(node => node.textContent === "Ohm's law").length, 2);
  assert.deepEqual([...doneRoot.querySelectorAll(".lp-plan-row strong")].map(node => node.textContent), ["Circuits course", "Music course"]);
  const kept = (await server.call("get-state") as { plans: { id: string; archived: boolean; plan: { modules: { topics: { status: string }[] }[] } }[] }).plans;
  assert.deepEqual(kept.map(plan => plan.archived), [false, true, false]);
  assert.equal(kept[1]!.plan.modules[0]!.topics[0]!.status, "done");

  // Today's-topic dialog offers items from every active plan, labelled by course.
  await host.actions.get("todays-topic")!.run({ placement: "top-bar", surface: "session", sessionId: "s-7", kind: "teaching" } as never);
  await flush();
  const dialog = [...doc.querySelectorAll(".test-dialog")].at(-1)!;
  const options = [...dialog.querySelectorAll("option")].map(node => node.textContent);
  assert.ok(options.every(label => /^(Circuits|Music) course · /.test(label!)), `labelled by course: ${options}`);
  assert.equal(options.some(label => label!.startsWith("Math course")), false, "archived plan is not offered");
  assert.match(options[0]!, /^Circuits course · Scheduled 2026-11-02: Ohm's law/);
});

test("Settings manages plans: add, rename, per-plan settings, archive/unarchive and remove", async () => {
  const server = backend();
  const host = frontendHost(server.call);
  const root = doc.createElement("div");
  doc.body.append(root);
  host.settings()(root, new AbortController().signal);
  await flush();
  const tabs = () => [...root.querySelectorAll(".lp-tabs--plans .lp-tab")].map(node => node.textContent);
  assert.match(root.textContent!, /You have no plans yet/);
  assert.equal((root.querySelector(".lp-settings__plan") as HTMLElement).hidden, true);
  assert.equal([...root.querySelectorAll("button")].find(node => node.textContent === "Archive plan")!.disabled, true);

  clickButton(root, "Add plan");
  await flush();
  clickButton(root, "Add plan");
  await flush();
  assert.deepEqual(tabs(), ["Untitled plan", "Untitled plan"]);
  assert.equal((root.querySelector(".lp-settings__plan") as HTMLElement).hidden, false);

  // Settings are per plan: change the days of the second (selected) plan only.
  const boxes = () => [...root.querySelectorAll(".lp-day-toggle input")] as HTMLInputElement[];
  assert.deepEqual(boxes().map(box => box.checked), [true, false, true, false, false, true, false], "defaults: Mon, Wed, Sat");
  boxes()[1]!.checked = true;
  boxes()[1]!.dispatchEvent(new window.Event("change") as unknown as Event);
  clickButton(root, "Save schedule");
  await flush();
  const name = root.querySelector('input[aria-label="Plan name"]') as HTMLInputElement;
  name.value = "Radio";
  name.dispatchEvent(new window.Event("change") as unknown as Event);
  await flush();
  assert.deepEqual(tabs(), ["Untitled plan", "Radio"]);
  const state = await server.call("get-state") as { plans: { id: string; name: string; profile: { weekdays: number[] } }[] };
  assert.deepEqual(state.plans.map(plan => plan.profile.weekdays), [[1, 3, 6], [1, 2, 3, 6]]);

  // Switching tabs reloads that plan's own values.
  (root.querySelectorAll(".lp-tabs--plans .lp-tab")[0] as HTMLButtonElement).click();
  assert.deepEqual(boxes().map(box => box.checked), [true, false, true, false, false, true, false]);
  assert.equal(name.value, "");
  (root.querySelectorAll(".lp-tabs--plans .lp-tab")[1] as HTMLButtonElement).click();
  assert.deepEqual(boxes().map(box => box.checked), [true, true, true, false, false, true, false]);
  assert.equal(name.value, "Radio");

  // Archive / unarchive keeps the plan listed in Settings.
  clickButton(root, "Archive plan");
  await flush();
  assert.deepEqual(tabs(), ["Untitled plan", "Radio (archived)"]);
  assert.match(root.textContent!, /This plan is archived/);
  assert.equal([...root.querySelectorAll("button")].find(node => node.textContent === "Generate plan")!.disabled, true);
  clickButton(root, "Unarchive plan");
  await flush();
  assert.deepEqual(tabs(), ["Untitled plan", "Radio"]);

  // Remove asks first; "Archive instead" and Cancel keep the plan.
  clickButton(root, "Remove plan");
  let dialog = [...doc.querySelectorAll(".test-dialog")].at(-1) as HTMLElement;
  assert.match(dialog.textContent!, /Remove "Radio"\?[\s\S]*permanently deletes/);
  clickButton(dialog, "Cancel");
  assert.deepEqual(tabs(), ["Untitled plan", "Radio"]);
  clickButton(root, "Remove plan");
  dialog = [...doc.querySelectorAll(".test-dialog")].at(-1) as HTMLElement;
  clickButton(dialog, "Remove plan");
  await flush();
  assert.deepEqual(tabs(), ["Untitled plan"]);
  assert.equal(((await server.call("get-state")) as { plans: unknown[] }).plans.length, 1);
});
