/** Pure calendar placement. The model decides *what* to learn; this decides *when*,
 * from study weekdays, the review interval and the behind-schedule mode. Dates are
 * local calendar dates (YYYY-MM-DD) handled in UTC arithmetic, so DST cannot shift them. */
import { allTopics, findTopic, type Plan, type Profile, type Topic } from "./plan-model.ts";

export type SlotState = "done" | "overdue" | "today" | "upcoming" | "past";
export type Slot =
  | { key: string; date: string; kind: "topic"; topicId: string; part: number; of: number; state: SlotState }
  | { key: string; date: string; kind: "review"; topicIds: string[]; state: SlotState };

export type Schedule = {
  slots: Slot[];
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

function dateState(date: string, today: string, done: boolean, review: boolean): SlotState {
  if (done) return "done";
  if (date < today) return review ? "past" : "overdue";
  return date === today ? "today" : "upcoming";
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
      slots.push({ key: `review:${date}`, date, kind: "review", topicIds: [...new Set(recent)].slice(-4), state: dateState(date, today, false, true) });
      continue;
    }
    const unit = queue[pending++]!;
    if (!recent.includes(unit.topicId)) recent.push(unit.topicId);
    if (recent.length > profile.reviewEvery * 2 + 2) recent.shift();
    slots.push({ key: `${unit.topicId}:${unit.part}`, date, kind: "topic", ...unit, state: dateState(date, today, isDone(unit), false) });
  }
  return slots;
}

export function buildSchedule(plan: Plan | null, profile: Profile, today: string): Schedule {
  const topics = allTopics(plan);
  const topicsDone = topics.filter(topic => topic.status === "done").length;
  const empty = (problem: string | null): Schedule => ({ slots: [], current: null, stats: { topicsDone, topics: topics.length, sessionsLeft: 0, endDate: null }, problem });
  if (!plan) return empty(null);
  if (!profile.weekdays.length) return empty("Choose at least one study day in Settings.");

  const byId = new Map(topics.map(topic => [topic.id, topic]));
  const unitDone = (unit: Unit) => {
    const topic = byId.get(unit.topicId);
    return topic ? unit.part <= progress(topic) : false;
  };
  let slots: Slot[];
  if (profile.behindMode === "fixed") {
    slots = place(units(topics, false), studyDays(profile.startDate, profile.weekdays), profile, today, 0, [], unitDone);
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
    slots = [...history, ...ahead];
  }
  const open = slots.filter(slot => slot.state === "overdue" || slot.state === "today" || slot.state === "upcoming");
  const current = open.find(slot => slot.state === "overdue")
    ?? open.find(slot => slot.date >= today)
    ?? null;
  const remaining = slots.filter(slot => slot.kind === "topic" && slot.state !== "done");
  return {
    slots,
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
