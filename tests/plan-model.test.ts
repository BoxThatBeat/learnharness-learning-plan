import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { curriculumSchema } from "../src/contract.ts";
import {
  acceptGenerated, acceptRevision, allTopics, applyManualEdit, emptyState, linkSession, parseState, readCurriculum,
  readProfile, setTopicStatus, topicForSession, type Curriculum,
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

test("generated plans get stable IDs; state round-trips and newer formats are refused", () => {
  const state = acceptGenerated(emptyState("2026-11-02"), curriculum, "now", "p1");
  assert.deepEqual(state.plan!.modules.map(module => module.id), ["m-1", "m-4"]);
  assert.deepEqual(allTopics(state.plan).map(topic => topic.id), ["t-2", "t-3", "t-5"]);
  assert.equal(state.nextId, 6);
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(state))), state);
  assert.throws(() => parseState({ ...state, version: 2 }), /newer than this plugin understands/);
});

test("revisions keep completed topics and the progress of unfinished topics with unchanged titles", () => {
  let state = acceptGenerated(emptyState("2026-11-02"), curriculum, "now", "p1");
  state = setTopicStatus(state, "t-2", true, "2026-11-02", "explained V=IR");
  state = linkSession(state, "t-3", "s9");
  const revised = acceptRevision(state, {
    title: "Plan v2", summary: "more RF", sources: [],
    modules: [
      { title: "Circuits", topics: [{ title: "rc circuits", objectives: ["b2"], sessions: 3, resources: [] }] },
      { title: "RF", topics: [{ title: "Transmission lines", objectives: ["d"], sessions: 1, resources: [] }, { title: "Antennas", objectives: ["c"], sessions: 1, resources: [] }] },
    ],
  });
  const topics = allTopics(revised.plan);
  assert.deepEqual(topics.map(topic => [topic.id, topic.title, topic.status]), [
    ["t-2", "Ohm's law", "done"],
    ["t-3", "rc circuits", "todo"],
    ["t-6", "Transmission lines", "todo"],
    ["t-5", "Antennas", "todo"],
  ]);
  assert.deepEqual(topics[1]!.sessionIds, ["s9"]);
  assert.equal(topics[1]!.sessions, 3);
  assert.equal(revised.plan!.modules[0]!.id, "m-1", "done module merged with same-titled revised module");
  assert.equal(topicForSession(revised.plan, "s9")?.id, "t-3");
});

test("manual edits keep progress, add new IDs and reject unknown IDs", () => {
  let state = acceptGenerated(emptyState("2026-11-02"), curriculum, "now", "p1");
  state = setTopicStatus(state, "t-3", true, "2026-11-03");
  const edited = applyManualEdit(state, [
    { id: "m-4", title: "Radio", topics: [{ id: "t-5", title: "Antennas", objectives: ["c"], sessions: 2 }] },
    { id: "m-1", title: "Circuits", topics: [{ id: "t-3", title: "RC", objectives: [], sessions: 2 }, { title: "Op-amps", objectives: ["x"], sessions: 1 }] },
  ]);
  assert.deepEqual(allTopics(edited.plan).map(topic => [topic.id, topic.title, topic.status]), [
    ["t-5", "Antennas", "todo"], ["t-3", "RC", "done"], ["t-6", "Op-amps", "todo"],
  ]);
  assert.throws(() => applyManualEdit(state, [{ id: "m-99", title: "x", topics: [] }]), /unknown or duplicate/);
  assert.throws(() => applyManualEdit(state, [{ title: "x", topics: [{ id: "t-2", title: "a", objectives: [], sessions: 9 }] }]), /sessions must be a whole number/);
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
