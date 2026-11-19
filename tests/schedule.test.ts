import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptGenerated, defaultProfile, emptyState, linkSession, setTopicStatus, type Curriculum, type PlanState, type Profile } from "../src/plan-model.ts";
import { addDays, brief, buildSchedule, layoutWeek, slotForTopic, weekday } from "../src/schedule.ts";

const curriculum: Curriculum = {
  title: "EE for CS grads",
  summary: "Circuits then RF.",
  sources: [],
  modules: [
    { title: "Circuits", topics: [
      { title: "Ohm's law", objectives: ["Apply V=IR"], sessions: 1, resources: [] },
      { title: "RC circuits", objectives: ["Compute time constants"], sessions: 2, resources: [] },
    ] },
    { title: "RF", topics: [{ title: "Antennas", objectives: [], sessions: 1, resources: [] }] },
  ],
};

// 2026-11-02 is a Monday.
const profile = (overrides: Partial<Profile> = {}): Profile => ({ ...defaultProfile("2026-11-02"), weekdays: [1, 3, 5], reviewEvery: 0, behindMode: "fixed", ...overrides });
const planned = (): PlanState => acceptGenerated(emptyState("2026-11-02"), curriculum, "2026-11-02T00:00:00Z", "p1");

test("date helpers are calendar-safe across DST and month ends", () => {
  assert.equal(weekday("2026-11-02"), 1);
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // EU DST weekend
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("fixed mode places units on study days from the start date and flags overdue work", () => {
  const state = planned();
  const schedule = buildSchedule(state.plan, profile(), "2026-11-02");
  assert.deepEqual(schedule.slots.map(slot => [slot.date, slot.kind === "topic" ? `${slot.topicId}:${slot.part}/${slot.of}` : "review", slot.state]), [
    ["2026-11-02", "t-2:1/1", "today"],
    ["2026-11-04", "t-3:1/2", "upcoming"],
    ["2026-11-06", "t-3:2/2", "upcoming"],
    ["2026-11-09", "t-5:1/1", "upcoming"],
  ]);
  assert.equal(schedule.current?.date, "2026-11-02");
  assert.equal(schedule.stats.endDate, "2026-11-09");

  const later = buildSchedule(state.plan, profile(), "2026-11-05");
  // t-3 (11-04 and 11-06) is due at the end of 11-06, so its first session passing is not overdue.
  assert.deepEqual(later.slots.map(slot => slot.state), ["overdue", "today", "today", "upcoming"]);
  assert.equal(later.current?.date, "2026-11-02", "oldest overdue first");

  const last = buildSchedule(state.plan, profile(), "2026-11-06");
  assert.deepEqual(last.slots.map(slot => slot.state), ["overdue", "today", "today", "upcoming"], "still due on its last day");
  const after = buildSchedule(state.plan, profile(), "2026-11-07");
  assert.deepEqual(after.slots.map(slot => slot.state), ["overdue", "overdue", "overdue", "upcoming"], "overdue once the last day has passed");
});

test("a multi-session topic is one block spanning its first to last session, due on the last day", () => {
  const state = planned();
  const schedule = buildSchedule(state.plan, profile(), "2026-11-05");
  assert.deepEqual(schedule.blocks.map(block => [block.topicId, block.start, block.end, block.firstPart, block.lastPart, block.state]), [
    ["t-2", "2026-11-02", "2026-11-02", 1, 1, "overdue"],
    ["t-3", "2026-11-04", "2026-11-06", 1, 2, "today"],
    ["t-5", "2026-11-09", "2026-11-09", 1, 1, "upcoming"],
  ]);
  assert.equal(schedule.current?.date, "2026-11-02");
  const onlyRc = buildSchedule(setTopicStatus(state, "t-2", true, "2026-11-02").plan, profile(), "2026-11-05");
  assert.equal(onlyRc.current?.kind === "topic" ? `${onlyRc.current.topicId}:${onlyRc.current.part}` : null, "t-3:1", "an in-progress topic's next session is current");
});

test("weeks lay blocks out in lanes, clipped at the week edges", () => {
  const state = planned();
  const { blocks } = buildSchedule(state.plan, profile({ weekdays: [1, 2, 3, 4, 5, 6, 0] }), "2026-11-02");
  // Daily study: Ohm 11-02, RC 11-03..11-04, Antennas 11-05.
  const week = layoutWeek(blocks, "2026-11-02");
  assert.deepEqual(week.bars.map(bar => [bar.block.topicId, bar.col, bar.span, bar.lane]), [["t-2", 0, 1, 0], ["t-3", 1, 2, 0], ["t-5", 3, 1, 0]]);
  assert.equal(week.lanes, 1);
  const spanning = { ...blocks[1]!, start: "2026-10-30", end: "2026-11-03" };
  const clipped = layoutWeek([spanning, blocks[0]!], "2026-11-02");
  assert.deepEqual(clipped.bars.map(bar => [bar.col, bar.span, bar.lane, bar.fromPrev, bar.toNext]), [[0, 2, 0, true, false], [0, 1, 1, false, false]]);
  assert.deepEqual(layoutWeek(blocks, "2026-11-09").bars, []);
});

test("shift mode moves unfinished work to the next study days and keeps history on completion dates", () => {
  let state = planned();
  state = setTopicStatus(state, "t-2", true, "2026-11-02");
  const schedule = buildSchedule(state.plan, profile({ behindMode: "shift" }), "2026-11-10");
  assert.deepEqual(schedule.slots.map(slot => [slot.date, slot.kind === "topic" ? slot.topicId : "review", slot.state]), [
    ["2026-11-02", "t-2", "done"],
    ["2026-11-11", "t-3", "upcoming"],
    ["2026-11-13", "t-3", "upcoming"],
    ["2026-11-16", "t-5", "upcoming"],
  ]);
  assert.equal(schedule.slots.some(slot => slot.state === "overdue"), false);
  assert.equal(schedule.current?.date, "2026-11-11");
});

test("starting later sessions of a multi-session topic advances its progress", () => {
  let state = planned();
  state = linkSession(state, "t-3", "s1");
  const next = slotForTopic(state.plan!, "t-3", "2026-11-04");
  assert.equal(next?.kind === "topic" ? next.part : null, 2);
  state = linkSession(state, "t-3", "s2");
  const fixed = buildSchedule(state.plan, profile(), "2026-11-09");
  const parts = fixed.slots.filter(slot => slot.kind === "topic" && slot.topicId === "t-3").map(slot => slot.state);
  assert.deepEqual(parts, ["done", "overdue"], "part 1 behind the learner, part 2 still open until the topic is completed");
  const shifted = buildSchedule(state.plan, profile({ behindMode: "shift" }), "2026-11-09");
  assert.equal(shifted.slots.filter(slot => slot.kind === "topic" && slot.topicId === "t-3").length, 1);
});

test("review slots appear every Nth session and cover recent topics", () => {
  const schedule = buildSchedule(planned().plan, profile({ reviewEvery: 3 }), "2026-11-02");
  const kinds = schedule.slots.map(slot => slot.kind);
  assert.deepEqual(kinds, ["topic", "topic", "review", "topic", "topic"]);
  const review = schedule.slots[2]!;
  assert.equal(review.kind === "review" && review.topicIds.join(","), "t-2,t-3");
});

test("no study days is reported instead of looping", () => {
  const schedule = buildSchedule(planned().plan, profile({ weekdays: [] }), "2026-11-02");
  assert.match(schedule.problem!, /study day/);
  assert.equal(schedule.slots.length, 0);
});

test("briefs carry the prefix, objectives, session part and length", () => {
  const state = planned();
  const slot = slotForTopic(state.plan!, "t-3", "2026-11-04")!;
  const text = brief(state.plan!, slot, profile({ minutesPerSession: 45 }), "teaching");
  assert.match(text, /^\[Learning plan\] Teach me "RC circuits" \(module: Circuits — session 1 of 2; about 45 minutes\)/);
  assert.match(text, /- Compute time constants/);
  assert.match(brief(state.plan!, slot, profile(), "practice"), /Give me practice problems on "RC circuits"/);
});
