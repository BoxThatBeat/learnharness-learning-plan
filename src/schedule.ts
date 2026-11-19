/** Pure calendar placement. The model decides *what* to learn; this decides *when*,
 * from study weekdays, the review interval and the behind-schedule mode. Dates are
 * local calendar dates (YYYY-MM-DD) handled in UTC arithmetic, so DST cannot shift them. */
import { allTopics, findTopic, type Plan, type Profile, type Topic } from "./plan-model.ts";

export type SlotState = "done" | "overdue" | "today" | "upcoming" | "past";
export type Slot =
  | { key: string; date: string; kind: "topic"; topicId: string; part: number; of: number; state: SlotState }
  | { key: string; date: string; kind: "review"; topicIds: string[]; state: SlotState };

/** A topic's sessions drawn as one calendar block from its first to its last session day.
 * `end` is the topic's due date: it is overdue only once that whole day has passed. */
export type Block = {
  key: string; topicId: string; start: string; end: string;
  firstPart: number; lastPart: number; of: number;
  /** The session to work on next (the last one when everything is done). */
  part: number;
  state: SlotState;
};

export type Schedule = {
  slots: Slot[];
  blocks: Block[];
  /** The item the kickoff button offers: oldest overdue, else today's, else the next one. */
  current: Slot | null;
  stats: { topicsDone: number; topics: number; sessionsLeft: number; endDate: string | null };
  problem: string | null;
};

const MAX_SLOTS = 2_000;

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}
export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * 86_400_000).toISOString().slice(0, 10);
}
export function weekday(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** Study days on or after `from`, endlessly (bounded by the caller). */
function* studyDays(from: string, weekdays: readonly number[]): Generator<string> {
  if (!weekdays.length) return;
  let date = from;
  for (let guard = 0; guard < 366 * 20; guard++, date = addDays(date, 1)) {
    if (weekdays.includes(weekday(date))) yield date;
  }
}

type Unit = { topicId: string; part: number; of: number };

/** How many sessions of a topic are finished. Starting session k (linking it) means
 * sessions 1..k-1 are behind the learner; the last part finishes only when the topic is done. */
export function progress(topic: Topic): number {
  return topic.status === "done" ? topic.sessions : Math.min(topic.sessions - 1, Math.max(0, topic.sessionIds.length - 1));
}

function units(topics: readonly Topic[], skipProgress: boolean): Unit[] {
  return topics.flatMap(topic => {
    const from = skipProgress ? progress(topic) : 0;
    return Array.from({ length: topic.sessions - from }, (_, index) => ({ topicId: topic.id, part: from + index + 1, of: topic.sessions }));
  });
}

function dateState(date: string, today: string): SlotState {
  if (date < today) return "past";
  return date === today ? "today" : "upcoming";
}

/** A topic is overdue only after the last day of its span; while today falls inside the
 * span it is in progress ("today"), even if its first session's day has passed. */
function topicState(first: string, last: string, today: string): SlotState {
  if (last < today) return "overdue";
  return first <= today ? "today" : "upcoming";
}

function settle(slots: Slot[], today: string): Slot[] {
  const span = new Map<string, { first: string; last: string }>();
  for (const slot of slots) {
    if (slot.kind !== "topic") continue;
    const seen = span.get(slot.topicId);
    span.set(slot.topicId, { first: seen && seen.first < slot.date ? seen.first : slot.date, last: seen && seen.last > slot.date ? seen.last : slot.date });
  }
  return slots.map(slot => {
    if (slot.kind !== "topic" || slot.state === "done") return slot;
    const { first, last } = span.get(slot.topicId)!;
    return { ...slot, state: topicState(first, last, today) };
  });
}

export function buildBlocks(slots: readonly Slot[]): Block[] {
  const blocks = new Map<string, Block & { next: number | null }>();
  for (const slot of slots) {
    if (slot.kind !== "topic") continue;
    const block = blocks.get(slot.topicId);
    if (!block) {
      blocks.set(slot.topicId, {
        key: slot.topicId, topicId: slot.topicId, start: slot.date, end: slot.date,
        firstPart: slot.part, lastPart: slot.part, of: slot.of, part: slot.part,
        state: slot.state, next: slot.state === "done" ? null : slot.part,
      });
      continue;
    }
    block.start = slot.date < block.start ? slot.date : block.start;
    block.end = slot.date > block.end ? slot.date : block.end;
    block.firstPart = Math.min(block.firstPart, slot.part);
    block.lastPart = Math.max(block.lastPart, slot.part);
    if (slot.state !== "done") {
      block.state = slot.state;
      block.next ??= slot.part;
    }
  }
  return [...blocks.values()].map(({ next, ...block }) => ({ ...block, part: next ?? block.lastPart }));
}

/** The session a block's "start" actions refer to. */
export function blockSlot(block: Block): Slot {
  return { key: `${block.topicId}:${block.part}`, date: block.start, kind: "topic", topicId: block.topicId, part: block.part, of: block.of, state: block.state };
}

export type WeekBar = { block: Block; col: number; span: number; lane: number; fromPrev: boolean; toNext: boolean };

/** Lay a week's blocks (Monday first) onto stacked lanes, clipped to the week. */
export function layoutWeek(blocks: readonly Block[], weekStart: string): { bars: WeekBar[]; lanes: number } {
  const dayIndex = (date: string) => Math.round((toUtc(date) - toUtc(weekStart)) / 86_400_000);
  const inWeek = blocks
    .filter(block => dayIndex(block.end) >= 0 && dayIndex(block.start) <= 6)
    .sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const laneEnds: number[] = [];
  const bars = inWeek.map((block): WeekBar => {
    const col = Math.max(0, dayIndex(block.start));
    const last = Math.min(6, dayIndex(block.end));
    let lane = laneEnds.findIndex(end => end < col);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = last;
    return { block, col, span: last - col + 1, lane, fromPrev: dayIndex(block.start) < 0, toNext: dayIndex(block.end) > 6 };
  });
  return { bars, lanes: laneEnds.length };
}

/** Interleave review slots into a unit stream. `offset` continues the count across history. */
function place(
  queue: Unit[], days: Generator<string>, profile: Profile, today: string, offset: number,
  recent: string[], isDone: (unit: Unit) => boolean,
): Slot[] {
  const slots: Slot[] = [];
  let index = offset;
  let pending = 0;
  for (const date of days) {
    if (pending >= queue.length || slots.length >= MAX_SLOTS) break;
    index++;
    if (profile.reviewEvery > 0 && index % profile.reviewEvery === 0 && recent.length) {
      slots.push({ key: `review:${date}`, date, kind: "review", topicIds: [...new Set(recent)].slice(-4), state: dateState(date, today) });
      continue;
    }
    const unit = queue[pending++]!;
    if (!recent.includes(unit.topicId)) recent.push(unit.topicId);
    if (recent.length > profile.reviewEvery * 2 + 2) recent.shift();
    // Topic states depend on the whole topic's span, so `settle` fills them in afterwards.
    slots.push({ key: `${unit.topicId}:${unit.part}`, date, kind: "topic", ...unit, state: isDone(unit) ? "done" : "upcoming" });
  }
  return slots;
}

export function buildSchedule(plan: Plan | null, profile: Profile, today: string): Schedule {
  const topics = allTopics(plan);
  const topicsDone = topics.filter(topic => topic.status === "done").length;
  const empty = (problem: string | null): Schedule => ({ slots: [], blocks: [], current: null, stats: { topicsDone, topics: topics.length, sessionsLeft: 0, endDate: null }, problem });
  if (!plan) return empty(null);
  if (!profile.weekdays.length) return empty("Choose at least one study day in Settings.");

  const byId = new Map(topics.map(topic => [topic.id, topic]));
  const unitDone = (unit: Unit) => {
    const topic = byId.get(unit.topicId);
    return topic ? unit.part <= progress(topic) : false;
  };
  let slots: Slot[];
  if (profile.behindMode === "fixed") {
    slots = settle(place(units(topics, false), studyDays(profile.startDate, profile.weekdays), profile, today, 0, [], unitDone), today);
  } else {
    // History: finished topics on their completion dates; then the rest from today on.
    const history: Slot[] = topics
      .filter(topic => topic.status === "done")
      .map(topic => ({ key: `${topic.id}:done`, date: topic.completedAt ?? today, kind: "topic" as const, topicId: topic.id, part: topic.sessions, of: topic.sessions, state: "done" as const }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const behind = topics.reduce((sum, topic) => sum + progress(topic), 0);
    const recent = history.map(slot => (slot as { topicId: string }).topicId).slice(-4);
    const from = profile.startDate > today ? profile.startDate : today;
    const ahead = place(units(topics.filter(topic => topic.status !== "done"), true), studyDays(from, profile.weekdays), profile, today, behind, recent, () => false);
    slots = [...history, ...settle(ahead, today)];
  }
  const open = slots.filter(slot => slot.state === "overdue" || slot.state === "today" || slot.state === "upcoming");
  // Past-dated sessions of a topic still in progress are "today", so the first open slot is next.
  const current = open.find(slot => slot.state === "overdue") ?? open[0] ?? null;
  const remaining = slots.filter(slot => slot.kind === "topic" && slot.state !== "done");
  return {
    slots,
    blocks: buildBlocks(slots),
    current,
    stats: { topicsDone, topics: topics.length, sessionsLeft: remaining.length, endDate: remaining.at(-1)?.date ?? null },
    problem: null,
  };
}

/** Text prepended to the learner's message when they kick off an item. */
export function brief(plan: Plan, slot: Slot, profile: Profile, sessionKind: "teaching" | "practice"): string {
  const minutes = `about ${profile.minutesPerSession} minutes`;
  if (slot.kind === "review") {
    const titles = slot.topicIds.map(id => findTopic(plan, id)?.topic.title).filter(Boolean);
    const list = titles.map(title => `- ${title}`).join("\n");
    return sessionKind === "practice"
      ? `[Learning plan] Review session (${minutes}). Give me practice problems mixing these recent topics:\n${list}`
      : `[Learning plan] Review session (${minutes}). Check and consolidate my understanding of these recent topics:\n${list}`;
  }
  const found = findTopic(plan, slot.topicId);
  if (!found) return "[Learning plan] (topic no longer in the plan)";
  const { module, topic } = found;
  const part = topic.sessions > 1 ? ` — session ${slot.part} of ${slot.of}` : "";
  const objectives = topic.objectives.length ? `\nObjectives:\n${topic.objectives.map(objective => `- ${objective}`).join("\n")}` : "";
  const verb = sessionKind === "practice" ? "Give me practice problems on" : "Teach me";
  return `[Learning plan] ${verb} "${topic.title}" (module: ${module.title}${part}; ${minutes}).${objectives}`;
}

/** The slot a kickoff starts for a topic: the next session after those already started. */
export function slotForTopic(plan: Plan, topicId: string, today: string): Slot | null {
  const found = findTopic(plan, topicId);
  if (!found) return null;
  const part = Math.min(found.topic.sessions, found.topic.sessionIds.length + 1);
  return { key: `${topicId}:${part}`, date: today, kind: "topic", topicId, part, of: found.topic.sessions, state: "today" };
}
