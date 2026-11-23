import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { curriculumSchema } from "../src/contract.ts";
import {
  acceptGenerated, acceptRevision, allTopics, applyManualEdit, emptyState, entryOfTopic, linkSession, newEntry, parseState, pickHue,
  readCurriculum, readProfile, setTopicStatus, topicForSession, updateEntry, type Curriculum, type PlanState,
} from "../src/plan-model.ts";

const curriculum: Curriculum = {
  title: "Plan",
  summary: "",
  sources: [{ title: "MIT 6.002", url: "https://ocw.mit.edu/courses/6-002" }],
  modules: [
    { title: "Circuits", topics: [
      { title: "Ohm's law", objectives: ["a"], sessions: 1, resources: [] },
      { title: "RC circuits", objectives: ["b"], sessions: 2, resources: [] },
    ] },
    { title: "RF", topics: [{ title: "Antennas", objectives: ["c"], sessions: 1, resources: [] }] },
  ],
};

/** A state with one generated course (p-1). Module/topic IDs share one counter with plan IDs. */
function oneCourse(): PlanState {
  const { state, entry } = newEntry(emptyState(), "2026-11-02", () => 0.5);
  return acceptGenerated(state, entry.id, curriculum, "now", "pl1");
}
const planOf = (state: PlanState, index = 0) => state.plans[index]!.plan;

test("generated plans get stable IDs; state round-trips and newer formats are refused", () => {
  const state = oneCourse();
  assert.equal(state.plans[0]!.id, "p-1");
  assert.deepEqual(planOf(state)!.modules.map(module => module.id), ["m-2", "m-5"]);
  assert.deepEqual(allTopics(planOf(state)).map(topic => topic.id), ["t-3", "t-4", "t-6"]);
  assert.equal(state.nextId, 7);
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(state))), state);
  assert.throws(() => parseState({ ...state, version: 3 }), /newer than this plugin understands/);
});

test("pickHue spreads new courses into the widest gap and never reuses a close colour", () => {
  assert.equal(pickHue([], () => 0.25), 90);
  for (const rand of [() => 0, () => 0.5, () => 1, Math.random]) {
    const hues: number[] = [];
    for (let count = 0; count < 8; count++) {
      const next = pickHue(hues, rand);
      const distance = Math.min(360, ...hues.map(hue => Math.min(Math.abs(hue - next), 360 - Math.abs(hue - next))));
      // With n courses the widest gap is at least 360/n, so the new hue is at least ~0.35 of that from its neighbours.
      if (hues.length) assert.ok(distance >= 0.35 * (360 / hues.length) - 1, `hue ${next} too close (${distance}) to ${hues}`);
      hues.push(next);
    }
  }
});

test("courses keep their colour: it is stored, survives archiving and a reload, and is independent per course", () => {
  let state = emptyState();
  const first = newEntry(state, "2026-11-02", () => 0.1);
  const second = newEntry(first.state, "2026-11-02", () => 0.5);
  state = second.state;
  assert.deepEqual(state.plans.map(plan => plan.id), ["p-1", "p-2"]);
  assert.notEqual(first.entry.hue, second.entry.hue);
  const archived = updateEntry(state, "p-1", entry => ({ ...entry, archived: true }));
  const third = newEntry(archived, "2026-11-02", () => 0.5).entry;
  assert.ok(Math.abs(third.hue - first.entry.hue) > 20 && Math.abs(third.hue - second.entry.hue) > 20, "archived colours still count as taken");
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(archived))).plans.map(plan => [plan.hue, plan.archived]), [[first.entry.hue, true], [second.entry.hue, false]]);
});

test("a saved single-plan file (format 1) is migrated into one course", () => {
  const old = {
    version: 1, nextId: 7,
    profile: { weekdays: [1, 3], minutesPerSession: 30, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: null, modelOverride: null, goalPrompt: "EE" },
    plan: { id: "u", title: "EE", summary: "", createdAt: "now", sources: [], modules: [{ id: "m-1", title: "Circuits", topics: [{ id: "t-2", title: "Ohm", objectives: [], sessions: 1, resources: [], status: "done", completedAt: "2026-11-02", completionNote: "", sessionIds: ["s"] }] }] },
    draft: null,
  };
  const state = parseState(old);
  assert.equal(state.version, 2);
  assert.equal(state.plans.length, 1);
  assert.deepEqual([state.plans[0]!.id, state.plans[0]!.archived, state.plans[0]!.profile.goalPrompt, state.plans[0]!.plan!.title], ["p-7", false, "EE", "EE"]);
  assert.equal(allTopics(state.plans[0]!.plan)[0]!.status, "done");
  assert.equal(state.nextId, 8);
  assert.deepEqual(parseState(old), state, "migration is deterministic, so the colour does not change between loads");
  assert.deepEqual(parseState({ ...old, plan: null, profile: { ...old.profile, goalPrompt: "" } }).plans, [], "an untouched v1 file has no courses");
});

test("topic IDs are unique across courses and resolve to their own course; archived courses are skipped", () => {
  let state = oneCourse();
  const added = newEntry(state, "2026-11-02", () => 0.9);
  state = acceptGenerated(added.state, added.entry.id, curriculum, "now", "pl2");
  const ids = state.plans.flatMap(plan => allTopics(plan.plan).map(topic => topic.id));
  assert.equal(new Set(ids).size, 6);
  assert.equal(entryOfTopic(state, ids[3]!)?.id, "p-7");
  state = linkSession(state, ids[3]!, "s-b");
  assert.equal(topicForSession(state, "s-b")?.entry.id, "p-7");
  const archived = updateEntry(state, "p-7", entry => ({ ...entry, archived: true }));
  assert.equal(entryOfTopic(archived, ids[3]!), null);
  assert.equal(entryOfTopic(archived, ids[3]!, true)?.id, "p-7");
  assert.equal(topicForSession(archived, "s-b"), null);
  // Archiving keeps the whole state, including progress.
  assert.deepEqual(setTopicStatus(archived, ids[3]!, true, "2026-11-03").plans[1]!.plan!.modules[0]!.topics[0]!.status, "done");
  assert.throws(() => parseState({ ...JSON.parse(JSON.stringify(state)), plans: [state.plans[0], state.plans[0]] }), /duplicate ID/);
});

test("revisions keep completed topics and the progress of unfinished topics with unchanged titles", () => {
  let state = oneCourse();
  state = setTopicStatus(state, "t-3", true, "2026-11-02", "explained V=IR");
  state = linkSession(state, "t-4", "s9");
  const revised = acceptRevision(state, "p-1", {
    title: "Plan v2", summary: "more RF", sources: [],
    modules: [
      { title: "Circuits", topics: [{ title: "rc circuits", objectives: ["b2"], sessions: 3, resources: [] }] },
      { title: "RF", topics: [{ title: "Transmission lines", objectives: ["d"], sessions: 1, resources: [] }, { title: "Antennas", objectives: ["c"], sessions: 1, resources: [] }] },
    ],
  });
  const topics = allTopics(planOf(revised));
  assert.deepEqual(topics.map(topic => [topic.id, topic.title, topic.status]), [
    ["t-3", "Ohm's law", "done"],
    ["t-4", "rc circuits", "todo"],
    ["t-7", "Transmission lines", "todo"],
    ["t-6", "Antennas", "todo"],
  ]);
  assert.deepEqual(topics[1]!.sessionIds, ["s9"]);
  assert.equal(topics[1]!.sessions, 3);
  assert.equal(planOf(revised)!.modules[0]!.id, "m-2", "done module merged with same-titled revised module");
  assert.equal(topicForSession(revised, "s9")?.topic.id, "t-4");
});

test("manual edits keep progress, add new IDs and reject unknown IDs", () => {
  let state = oneCourse();
  state = setTopicStatus(state, "t-4", true, "2026-11-03");
  const edited = applyManualEdit(state, "p-1", [
    { id: "m-5", title: "Radio", topics: [{ id: "t-6", title: "Antennas", objectives: ["c"], sessions: 2 }] },
    { id: "m-2", title: "Circuits", topics: [{ id: "t-4", title: "RC", objectives: [], sessions: 2 }, { title: "Op-amps", objectives: ["x"], sessions: 1 }] },
  ]);
  assert.deepEqual(allTopics(planOf(edited)).map(topic => [topic.id, topic.title, topic.status]), [
    ["t-6", "Antennas", "todo"], ["t-4", "RC", "done"], ["t-7", "Op-amps", "todo"],
  ]);
  assert.throws(() => applyManualEdit(state, "p-1", [{ id: "m-99", title: "x", topics: [] }]), /unknown or duplicate/);
  assert.throws(() => applyManualEdit(state, "p-1", [{ title: "x", topics: [{ id: "t-3", title: "a", objectives: [], sessions: 9 }] }]), /sessions must be a whole number/);
});

test("profile and curriculum validation", () => {
  assert.deepEqual(readProfile({ weekdays: [6, 1, 1], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 4, behindMode: "fixed", targetWeeks: null, goalPrompt: " x " }).weekdays, [1, 6]);
  assert.throws(() => readProfile({ weekdays: [7], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 4, behindMode: "fixed" }), /weekdays/);
  assert.throws(() => readProfile({ weekdays: [1], minutesPerSession: 45, startDate: "2026-02-30", reviewEvery: 4, behindMode: "fixed" }), /valid YYYY-MM-DD/);
  assert.throws(() => readCurriculum({ ...curriculum, modules: [] }), /no modules/);
  const check = Compile(curriculumSchema);
  assert.equal(check.Check(curriculum), true);
  assert.equal(check.Check({ ...curriculum, modules: [{ title: "x", topics: [{ title: "y", objectives: ["z"], sessions: 5, resources: [] }] }] }), false);
});
