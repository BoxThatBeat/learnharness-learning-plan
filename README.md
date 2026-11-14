# Learning plan (LearnHarness plugin)

Turn a long-term goal into a researched curriculum, schedule it on a calendar around
your study days, and start each day's topic from a teaching or practice session.

> *"I have a computer science degree and a math minor. I now want to become a mix
> between an electrical engineer and a mechatronics engineer, focusing on electronic
> circuits and radio communication. Research what syllabuses at good universities
> include and make me a learning plan."*

## Features

- **Settings → Learning plan**
  - Pick your study days (sessions per week = days ticked), session length, start
    date, review frequency, and what happens when you fall behind.
  - Describe your background and goal, then press **Generate plan**. A planning
    worker uses the model's knowledge of how good universities structure the field.
    It can also read specific public syllabus pages with a built-in `fetch_url` tool.
  - The result arrives as a **draft** you review before accepting.
- **Sidebar tab "Learning plan"**
  - **Calendar:** a month view with topics colour-coded as today, upcoming, overdue,
    done or review. Click a topic for its objectives, resources and linked sessions,
    and to mark it done or not done.
  - **Curriculum:** rename, reorder, add or remove topics and set how many sessions
    each needs. **Revise with AI** rewrites only the unfinished part, for example
    "more RF, add a PCB design module". Completed topics and in-progress topics with
    unchanged titles keep their progress.
- **Starting a topic**
  - **In a new session:** open a Teaching or Practice session and type
    "start today's topic" as your first message, or "start t-12" for a specific
    topic. The teacher also offers today's topic if you open with something like
    "hi" or "go". Once you choose, it calls `learning_plan_start_topic`. That links
    the session to the topic and gives the teacher the brief (topic, objectives,
    session part, length).
  - **In a session that's under way:** use the **Today's topic** button in the
    session's top bar. It offers today's scheduled item, or the oldest overdue one,
    or any unfinished topic you pick. **Attach** it, then send a message (even "go").
    The `[Learning plan]` brief goes in front of that message and the session is
    linked to the topic.
  - The button isn't shown on the new-session screen: LearnHarness only creates a
    session, and its top bar, when you send the first message.
  - Linked sessions can be opened later from the topic in the calendar.
- **Teacher integration**
  - Teacher and practice agents see the plan and the upcoming items.
  - They can call `learning_plan_complete_topic` once you've demonstrably met a
    topic's objectives. In a session linked to a topic, the topic is inferred.
  - `learning_plan_overview` shows them the full curriculum.

## Scheduling

The model decides **what** to learn; plain code decides **when**. Changing your
availability reschedules instantly, with no model call.

- **Auto-shift:** finished topics stay on the day you completed them; everything
  unfinished flows onto your next study days.
- **Keep dates:** the calendar counts from the start date and missed sessions show as
  overdue. Starting today's topic picks up the oldest overdue item first.
- **Multi-session topics** show `part/of`. Starting session *k* marks the earlier
  parts behind you, and the topic finishes when it is marked done.
- **Review slots:** every *N*th slot is a review of recently scheduled topics (0
  turns them off).

## Cost and privacy

Generating or revising a plan runs a multi-step model task (up to 25 turns, 10 min)
with your **strong** model slot, or the model you pick in Settings. That can cost
noticeably more than a chat turn. Nothing runs until you press a button.

`fetch_url` sends HTTP requests from your machine to the public pages the planner
chooses. It has these limits:
- http(s) only;
- no credentials in URLs;
- loopback, private, link-local and similar addresses are refused, including on
  every redirect hop;
- at most 10 pages per run, 15 s each, 1 MB each, reduced to text.

The address check happens before connecting. It is a guard against mistakes, not
a guarantee against DNS-rebinding attacks.

## Data

`<plugin data>/plan.json` holds your profile, the plan and any pending draft.
- Writes are atomic.
- If the file is unreadable or uses a newer format, the plugin leaves it untouched
  and shows the error.
- Topic IDs (`t-N`) are stable and never reused.

## Install from GitHub

Requires LearnHarness 0.6.1 or later, and Node.js with npm for the build. Clone into
the plugins directory shown in **Settings → Community plugins**. The folder must be
named `learning-plan`.

```sh
git clone https://github.com/BoxThatBeat/learnharness-learning-plan.git "<plugins directory>/learning-plan"
cd "<plugins directory>/learning-plan"
npm ci
npm run build
```

Refresh the Community plugins list and enable **Learning plan**. To update later,
run `git pull && npm ci && npm run build`, then restart LearnHarness.

## Develop elsewhere

```sh
npm ci
npm run typecheck
npm test          # unit, backend and happy-dom frontend integration tests
npm run install:local -- "<plugins directory>"
```

`.sdk/` is the type-only LearnHarness plugin SDK (API v1, from app 0.6.1).

## License

AGPL-3.0-only (see `LICENSE`). The bundled `.sdk/` types and
`scripts/install-plugin-local.mjs` come from the LearnHarness plugin authoring kit,
which is AGPL-3.0.
