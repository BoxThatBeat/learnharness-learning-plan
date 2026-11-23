/** Pure plan model: saved state, validation, curriculum → plan conversion, revision
 * merging and manual edits. No I/O; shared by backend, frontend and tests. */

export const STATE_VERSION = 2;
export const LIMITS = {
  modules: 30,
  topicsPerModule: 40,
  topics: 300,
  title: 160,
  objective: 300,
  objectives: 8,
  resources: 6,
  sessionsPerTopic: 4,
  goalPrompt: 8_000,
  revisionPrompt: 4_000,
  note: 1_000,
  summary: 2_000,
  planName: 80,
  plans: 20,
} as const;

export type ModelChoice = { provider: string; id: string };
export type BehindMode = "shift" | "fixed";

export type Profile = {
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  minutesPerSession: number;
  /** Local calendar date, YYYY-MM-DD. */
  startDate: string;
  /** Every Nth slot is a review/practice slot; 0 disables reviews. */
  reviewEvery: number;
  behindMode: BehindMode;
  targetWeeks: number | null;
  modelOverride: ModelChoice | null;
  goalPrompt: string;
};

export type Resource = { title: string; url: string };

export type Topic = {
  id: string;
  title: string;
  objectives: string[];
  sessions: number;
  resources: Resource[];
  status: "todo" | "done";
  completedAt: string | null;
  completionNote: string;
  /** Learning sessions started for this topic via the kickoff button, oldest first. */
  sessionIds: string[];
};

export type Module = { id: string; title: string; topics: Topic[] };

export type Plan = {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  sources: Resource[];
  modules: Module[];
};

/** What the planning model returns (no IDs or progress). */
export type Curriculum = {
  title: string;
  summary: string;
  sources: Resource[];
  modules: { title: string; topics: { title: string; objectives: string[]; sessions: number; resources: Resource[] }[] }[];
};

export type DraftKind = "generate" | "revise";
export type Draft =
  | { status: "running"; kind: DraftKind; requestId: string; taskId: string | null; startedAt: string }
  | { status: "ready"; kind: DraftKind; requestId: string; curriculum: Curriculum }
  | { status: "failed"; kind: DraftKind; requestId: string; error: string };

/** One planned course: its own settings, curriculum and AI draft. */
export type PlanEntry = {
  /** Stable ID (`p-N`); never reused. */
  id: string;
  /** The learner's name for the course; blank falls back to the curriculum title. */
  name: string;
  /** Calendar colour as an HSL hue (0–360). Chosen once when the course is created, never changed. */
  hue: number;
  /** Archived courses are hidden everywhere but keep their full state. */
  archived: boolean;
  profile: Profile;
  plan: Plan | null;
  draft: Draft | null;
};

export type PlanState = {
  version: typeof STATE_VERSION;
  plans: PlanEntry[];
  /** Shared by plans, modules and topics, so topic IDs (`t-N`) are unique across all courses. */
  nextId: number;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Local calendar date of a timestamp (the machine's time zone), YYYY-MM-DD. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function defaultProfile(today: string): Profile {
  return {
    weekdays: [1, 3, 6],
    minutesPerSession: 60,
    startDate: today,
    reviewEvery: 4,
    behindMode: "shift",
    targetWeeks: null,
    modelOverride: null,
    goalPrompt: "",
  };
}

export function emptyState(): PlanState {
  return { version: STATE_VERSION, plans: [], nextId: 1 };
}

/** Pick a hue for a new course: the middle of the widest gap between the hues already in use
 * (archived ones included, so a course never changes colour or clashes after unarchiving), with
 * some random jitter. With `n` courses the nearest neighbour is always at least ~0.35 × (360/n)
 * away, and the first course gets a random hue. */
export function pickHue(used: readonly number[], rand: () => number = Math.random): number {
  if (!used.length) return Math.floor(rand() * 360) % 360;
  const sorted = [...used].map(hue => ((hue % 360) + 360) % 360).sort((a, b) => a - b);
  let start = sorted[0]!;
  let gap = 0;
  sorted.forEach((hue, index) => {
    const next = index + 1 < sorted.length ? sorted[index + 1]! : sorted[0]! + 360;
    if (next - hue > gap) { gap = next - hue; start = hue; }
  });
  const jitter = (rand() - 0.5) * 0.3;
  return Math.round(((start + gap * (0.5 + jitter)) % 360 + 360) % 360);
}

export function newEntry(state: PlanState, today: string, rand: () => number = Math.random): { state: PlanState; entry: PlanEntry } {
  if (state.plans.length >= LIMITS.plans) throw new Error(`At most ${LIMITS.plans} plans are supported. Remove one first.`);
  const entry: PlanEntry = {
    id: `p-${state.nextId}`, name: "", hue: pickHue(state.plans.map(plan => plan.hue), rand), archived: false,
    profile: defaultProfile(today), plan: null, draft: null,
  };
  return { state: { ...state, nextId: state.nextId + 1, plans: [...state.plans, entry] }, entry };
}

export const activeEntries = (state: PlanState): PlanEntry[] => state.plans.filter(entry => !entry.archived);
export const findEntry = (state: PlanState, id: string): PlanEntry | null => state.plans.find(entry => entry.id === id) ?? null;
export const entryName = (entry: Pick<PlanEntry, "name" | "plan">): string => entry.name || entry.plan?.title || "Untitled plan";

export function updateEntry(state: PlanState, id: string, update: (entry: PlanEntry) => PlanEntry): PlanState {
  if (!findEntry(state, id)) throw new Error("That plan no longer exists.");
  return { ...state, plans: state.plans.map(entry => entry.id === id ? update(entry) : entry) };
}

/** The course a topic belongs to. Topic IDs are unique across courses; archived courses are
 * skipped unless asked for. */
export function entryOfTopic(state: PlanState, topicId: string, includeArchived = false): PlanEntry | null {
  return state.plans.find(entry => (includeArchived || !entry.archived) && findTopic(entry.plan, topicId)) ?? null;
}

export function readName(value: unknown): string {
  return text(value ?? "", "Plan name", LIMITS.planName, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is longer than ${max} characters.`);
  return trimmed;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function readModel(value: unknown): ModelChoice | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string" || !value.provider || !value.id) {
    throw new Error("Model choice is malformed.");
  }
  return { provider: value.provider, id: value.id };
}

/** Validate a full profile (from Settings or disk). */
export function readProfile(value: unknown): Profile {
  if (!isRecord(value)) throw new Error("Schedule settings are malformed.");
  if (!Array.isArray(value.weekdays) || value.weekdays.some(day => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Study days must be weekdays 0–6.");
  }
  const weekdays = [...new Set(value.weekdays as number[])].sort((a, b) => a - b);
  if (!isDate(value.startDate)) throw new Error("Start date must be a valid YYYY-MM-DD date.");
  if (value.behindMode !== "shift" && value.behindMode !== "fixed") throw new Error("Behind-schedule mode must be shift or fixed.");
  return {
    weekdays,
    minutesPerSession: integer(value.minutesPerSession, "Minutes per session", 10, 600),
    startDate: value.startDate,
    reviewEvery: integer(value.reviewEvery, "Review interval", 0, 20),
    behindMode: value.behindMode,
    targetWeeks: value.targetWeeks === null || value.targetWeeks === undefined ? null : integer(value.targetWeeks, "Target weeks", 1, 520),
    modelOverride: readModel(value.modelOverride),
    goalPrompt: typeof value.goalPrompt === "string" ? text(value.goalPrompt, "Goal", LIMITS.goalPrompt, false) : "",
  };
}

function readResources(value: unknown, label: string): Resource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} resources must be a list.`);
  return value.slice(0, LIMITS.resources * 4).flatMap(entry => {
    if (!isRecord(entry) || typeof entry.url !== "string" || !/^https?:\/\//i.test(entry.url.trim())) return [];
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim().slice(0, LIMITS.title) : entry.url.trim();
    return [{ title, url: entry.url.trim().slice(0, 2_000) }];
  });
}

function readObjectives(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} objectives must be a list.`);
  if (value.length > LIMITS.objectives) throw new Error(`${label} has more than ${LIMITS.objectives} objectives.`);
  return value.map((entry, index) => text(entry, `${label} objective ${index + 1}`, LIMITS.objective)).filter(Boolean);
}

function readTopic(value: unknown, label: string): Topic {
  if (!isRecord(value) || typeof value.id !== "string" || !/^t-\d+$/.test(value.id)) throw new Error(`${label} has no valid ID.`);
  return {
    id: value.id,
    title: text(value.title, `${label} title`, LIMITS.title),
    objectives: readObjectives(value.objectives, label),
    sessions: integer(value.sessions, `${label} sessions`, 1, LIMITS.sessionsPerTopic),
    resources: readResources(value.resources, label),
    status: value.status === "done" ? "done" : "todo",
    completedAt: isDate(value.completedAt) ? value.completedAt : null,
    completionNote: typeof value.completionNote === "string" ? value.completionNote.slice(0, LIMITS.note) : "",
    sessionIds: Array.isArray(value.sessionIds) ? value.sessionIds.filter((id): id is string => typeof id === "string").slice(-50) : [],
  };
}

function readPlan(value: unknown): Plan | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !Array.isArray(value.modules)) throw new Error("Saved plan is malformed.");
  const ids = new Set<string>();
  const modules = value.modules.map((module, mIndex): Module => {
    if (!isRecord(module) || typeof module.id !== "string" || !/^m-\d+$/.test(module.id) || !Array.isArray(module.topics)) {
      throw new Error(`Saved module ${mIndex + 1} is malformed.`);
    }
    const topics = module.topics.map((topic, tIndex) => readTopic(topic, `Saved topic ${mIndex + 1}.${tIndex + 1}`));
    for (const id of [module.id, ...topics.map(topic => topic.id)]) {
      if (ids.has(id)) throw new Error(`Saved plan has duplicate ID ${id}.`);
      ids.add(id);
    }
    return { id: module.id, title: text(module.title, `Saved module ${mIndex + 1} title`, LIMITS.title), topics };
  });
  return {
    id: typeof value.id === "string" ? value.id : "plan",
    title: typeof value.title === "string" ? value.title.slice(0, LIMITS.title) : "Learning plan",
    summary: typeof value.summary === "string" ? value.summary.slice(0, LIMITS.summary) : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    sources: readResources(value.sources, "Plan"),
    modules,
  };
}

/** Validate model output (or a saved draft) into a bounded curriculum. */
export function readCurriculum(value: unknown): Curriculum {
  if (!isRecord(value) || !Array.isArray(value.modules)) throw new Error("Curriculum is malformed.");
  if (!value.modules.length) throw new Error("Curriculum has no modules.");
  if (value.modules.length > LIMITS.modules) throw new Error(`Curriculum has more than ${LIMITS.modules} modules.`);
  let count = 0;
  const modules = value.modules.map((module, mIndex) => {
    if (!isRecord(module) || !Array.isArray(module.topics) || !module.topics.length) throw new Error(`Module ${mIndex + 1} has no topics.`);
    if (module.topics.length > LIMITS.topicsPerModule) throw new Error(`Module ${mIndex + 1} has too many topics.`);
    count += module.topics.length;
    return {
      title: text(module.title, `Module ${mIndex + 1} title`, LIMITS.title),
      topics: module.topics.map((topic, tIndex) => {
        const label = `Topic ${mIndex + 1}.${tIndex + 1}`;
        if (!isRecord(topic)) throw new Error(`${label} is malformed.`);
        return {
          title: text(topic.title, `${label} title`, LIMITS.title),
          objectives: readObjectives(topic.objectives, label),
          sessions: integer(topic.sessions, `${label} sessions`, 1, LIMITS.sessionsPerTopic),
          resources: readResources(topic.resources, label).slice(0, LIMITS.resources),
        };
      }),
    };
  });
  if (count > LIMITS.topics) throw new Error(`Curriculum has more than ${LIMITS.topics} topics.`);
  return {
    title: text(value.title, "Plan title", LIMITS.title),
    summary: typeof value.summary === "string" ? value.summary.trim().slice(0, LIMITS.summary) : "",
    sources: readResources(value.sources, "Plan").slice(0, 30),
    modules,
  };
}

function readDraft(value: unknown): Draft | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.requestId !== "string" || (value.kind !== "generate" && value.kind !== "revise")) {
    throw new Error("Saved draft is malformed.");
  }
  const base = { kind: value.kind as DraftKind, requestId: value.requestId };
  if (value.status === "running") {
    return { status: "running", ...base, taskId: typeof value.taskId === "string" ? value.taskId : null, startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString() };
  }
  if (value.status === "ready") return { status: "ready", ...base, curriculum: readCurriculum(value.curriculum) };
  if (value.status === "failed") return { status: "failed", ...base, error: String(value.error ?? "Planning failed.") };
  throw new Error("Saved draft is malformed.");
}

function entryIds(entry: PlanEntry): string[] {
  return [entry.id, ...(entry.plan?.modules ?? []).flatMap(module => [module.id, ...module.topics.map(topic => topic.id)])];
}

function readEntry(value: unknown, index: number): PlanEntry {
  if (!isRecord(value) || typeof value.id !== "string" || !/^p-\d+$/.test(value.id)) throw new Error(`Saved plan ${index + 1} has no valid ID.`);
  const hue = typeof value.hue === "number" && Number.isFinite(value.hue) ? ((value.hue % 360) + 360) % 360 : (index * 137.508) % 360;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name.trim().slice(0, LIMITS.planName) : "",
    hue: Math.round(hue),
    archived: value.archived === true,
    profile: readProfile(value.profile),
    plan: readPlan(value.plan),
    draft: readDraft(value.draft),
  };
}

/** Parse saved state; refuses newer formats rather than rewriting them. Format 1 (a single
 * plan) is migrated in memory and written as format 2 on the next change. */
export function parseState(raw: unknown): PlanState {
  if (!isRecord(raw) || typeof raw.version !== "number") throw new Error("Saved learning plan data has no version.");
  if (raw.version > STATE_VERSION) {
    throw new Error(`Saved learning plan data uses format ${raw.version}, newer than this plugin understands (${STATE_VERSION}). Update the plugin; the file was not changed.`);
  }
  let plans: PlanEntry[];
  let storedNext: unknown = raw.nextId;
  if (raw.version === 1) {
    const plan = readPlan(raw.plan);
    const profile = readProfile(raw.profile);
    const draft = readDraft(raw.draft);
    const highest = highestId(plan ? [{ id: "p-0", plan } as PlanEntry] : []);
    const next = typeof storedNext === "number" && Number.isSafeInteger(storedNext) && storedNext > highest ? storedNext : highest + 1;
    plans = plan || draft || profile.goalPrompt ? [{ id: `p-${next}`, name: "", hue: 212, archived: false, profile, plan, draft }] : [];
    storedNext = next + 1;
  } else if (raw.version === STATE_VERSION) {
    if (!Array.isArray(raw.plans)) throw new Error("Saved plans are malformed.");
    plans = raw.plans.map(readEntry);
  } else throw new Error(`Unsupported learning plan data format ${raw.version}.`);
  const seen = new Set<string>();
  for (const id of plans.flatMap(entryIds)) {
    if (seen.has(id)) throw new Error(`Saved plans have duplicate ID ${id}.`);
    seen.add(id);
  }
  const highest = highestId(plans);
  const nextId = typeof storedNext === "number" && Number.isSafeInteger(storedNext) && storedNext > highest ? storedNext : highest + 1;
  return { version: STATE_VERSION, plans, nextId };
}

function highestId(plans: readonly PlanEntry[]): number {
  return Math.max(0, ...plans.flatMap(entryIds).map(id => Number(id.slice(2))));
}

export function allTopics(plan: Plan | null): Topic[] {
  return plan ? plan.modules.flatMap(module => module.topics) : [];
}

export function findTopic(plan: Plan | null, topicId: string): { module: Module; topic: Topic } | null {
  for (const module of plan?.modules ?? []) {
    const topic = module.topics.find(candidate => candidate.id === topicId);
    if (topic) return { module, topic };
  }
  return null;
}

/** The most recently linked topic for a session, if any. */
export function topicForSession(state: PlanState, sessionId: string): { entry: PlanEntry; topic: Topic } | null {
  for (const entry of activeEntries(state)) {
    const topic = allTopics(entry.plan).find(candidate => candidate.sessionIds.includes(sessionId));
    if (topic) return { entry, topic };
  }
  return null;
}

const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function freshTopic(id: string, source: Curriculum["modules"][number]["topics"][number]): Topic {
  return { id, title: source.title, objectives: source.objectives, sessions: source.sessions, resources: source.resources, status: "todo", completedAt: null, completionNote: "", sessionIds: [] };
}

/** Replace a course's plan with a newly generated curriculum. */
export function acceptGenerated(state: PlanState, entryId: string, curriculum: Curriculum, now: string, planId: string): PlanState {
  let nextId = state.nextId;
  const modules = curriculum.modules.map(module => ({
    id: `m-${nextId++}`,
    title: module.title,
    topics: module.topics.map(topic => freshTopic(`t-${nextId++}`, topic)),
  }));
  const next = updateEntry(state, entryId, entry => ({ ...entry, plan: { id: planId, title: curriculum.title, summary: curriculum.summary, createdAt: now, sources: curriculum.sources, modules } }));
  return { ...next, nextId };
}

/** Merge a revised curriculum for the unfinished part. Completed topics are kept as they
 * were; unfinished topics whose titles match keep their IDs and linked sessions. */
export function acceptRevision(state: PlanState, entryId: string, curriculum: Curriculum): PlanState {
  const plan = findEntry(state, entryId)?.plan;
  if (!plan) throw new Error("There is no plan to revise.");
  let nextId = state.nextId;
  const todoByTitle = new Map(allTopics(plan).filter(topic => topic.status === "todo").map(topic => [normalize(topic.title), topic]));
  const used = new Set<string>();
  const doneModules = plan.modules
    .map(module => ({ ...module, topics: module.topics.filter(topic => topic.status === "done") }))
    .filter(module => module.topics.length);
  const doneByTitle = new Map(doneModules.map(module => [normalize(module.title), module]));
  const merged: Module[] = [];
  const consumedDone = new Set<string>();
  const revised = curriculum.modules.map(module => {
    const doneModule = doneByTitle.get(normalize(module.title));
    if (doneModule) consumedDone.add(doneModule.id);
    const topics = module.topics.map(source => {
      const existing = todoByTitle.get(normalize(source.title));
      if (existing && !used.has(existing.id)) {
        used.add(existing.id);
        return { ...existing, title: source.title, objectives: source.objectives, sessions: source.sessions, resources: source.resources };
      }
      return freshTopic(`t-${nextId++}`, source);
    });
    return { id: doneModule?.id ?? `m-${nextId++}`, title: module.title, topics: [...(doneModule?.topics ?? []), ...topics] };
  });
  merged.push(...doneModules.filter(module => !consumedDone.has(module.id)), ...revised);
  const next = updateEntry(state, entryId, entry => ({
    ...entry,
    plan: {
      ...plan,
      title: curriculum.title,
      summary: curriculum.summary,
      sources: [...plan.sources, ...curriculum.sources.filter(source => !plan.sources.some(old => old.url === source.url))].slice(0, 40),
      modules: merged,
    },
  }));
  return { ...next, nextId };
}

/** Manual curriculum edit from the plan view. Existing IDs keep their progress. */
export function applyManualEdit(state: PlanState, entryId: string, input: unknown): PlanState {
  const plan = findEntry(state, entryId)?.plan;
  if (!plan) throw new Error("There is no plan to edit.");
  if (!Array.isArray(input)) throw new Error("Expected a list of modules.");
  if (input.length > LIMITS.modules) throw new Error(`At most ${LIMITS.modules} modules are supported.`);
  const known = new Map(allTopics(plan).map(topic => [topic.id, topic]));
  const knownModules = new Set(plan.modules.map(module => module.id));
  const seen = new Set<string>();
  let nextId = state.nextId;
  let count = 0;
  const modules = input.map((module, mIndex): Module => {
    const label = `Module ${mIndex + 1}`;
    if (!isRecord(module) || !Array.isArray(module.topics)) throw new Error(`${label} is malformed.`);
    let id: string;
    if (typeof module.id === "string" && knownModules.has(module.id) && !seen.has(module.id)) id = module.id;
    else if (module.id === undefined || module.id === null || module.id === "") id = `m-${nextId++}`;
    else throw new Error(`${label} has an unknown or duplicate ID.`);
    seen.add(id);
    count += module.topics.length;
    const topics = module.topics.map((topic, tIndex): Topic => {
      const topicLabel = `Topic ${mIndex + 1}.${tIndex + 1}`;
      if (!isRecord(topic)) throw new Error(`${topicLabel} is malformed.`);
      const fields = {
        title: text(topic.title, `${topicLabel} title`, LIMITS.title),
        objectives: readObjectives(topic.objectives, topicLabel),
        sessions: integer(topic.sessions, `${topicLabel} sessions`, 1, LIMITS.sessionsPerTopic),
      };
      if (typeof topic.id === "string" && known.has(topic.id) && !seen.has(topic.id)) {
        seen.add(topic.id);
        return { ...known.get(topic.id)!, ...fields };
      }
      if (topic.id !== undefined && topic.id !== null && topic.id !== "") throw new Error(`${topicLabel} has an unknown or duplicate ID.`);
      return { ...fields, id: `t-${nextId++}`, resources: [], status: "todo", completedAt: null, completionNote: "", sessionIds: [] };
    });
    return { id, title: text(module.title, `${label} title`, LIMITS.title), topics };
  }).filter(module => module.topics.length > 0);
  if (count > LIMITS.topics) throw new Error(`At most ${LIMITS.topics} topics are supported.`);
  return { ...updateEntry(state, entryId, entry => ({ ...entry, plan: { ...plan, modules } })), nextId };
}

function updateTopic(state: PlanState, topicId: string, update: (topic: Topic) => Topic): PlanState {
  const owner = entryOfTopic(state, topicId, true);
  if (!owner?.plan) throw new Error(`Unknown topic ${topicId}.`);
  const plan = owner.plan;
  return updateEntry(state, owner.id, entry => ({
    ...entry,
    plan: { ...plan, modules: plan.modules.map(module => ({ ...module, topics: module.topics.map(topic => topic.id === topicId ? update(topic) : topic) })) },
  }));
}

export function setTopicStatus(state: PlanState, topicId: string, done: boolean, today: string, note = ""): PlanState {
  return updateTopic(state, topicId, topic => done
    ? { ...topic, status: "done", completedAt: topic.status === "done" && topic.completedAt ? topic.completedAt : today, completionNote: note.slice(0, LIMITS.note) || topic.completionNote }
    : { ...topic, status: "todo", completedAt: null, completionNote: "" });
}

export function linkSession(state: PlanState, topicId: string, sessionId: string): PlanState {
  if (!sessionId || sessionId.length > 200) throw new Error("Invalid session ID.");
  return updateTopic(state, topicId, topic => topic.sessionIds.includes(sessionId)
    ? topic
    : { ...topic, sessionIds: [...topic.sessionIds, sessionId].slice(-50) });
}
