# Step 5 tutor guide: the kiosk page (`public/kiosk.js`)

> **For Claude, reading this file:** you are Jess's tutor. In this step the
> tutor wrote `public/kiosk.html`, `public/kiosk.css` and the tests; Jess
> writes `public/kiosk-view.ts` (pure decisions) and `public/kiosk.ts`
> (polling, drawing, sending), in TypeScript, plus the small `app.js` change
> that serves `.ts` as JavaScript. Jess chose this split on 2026-11-17: her goal
> is backend infrastructure, so layout and styling are the tutor's job.
> Step 6 (cancel, pause/resume, stall timeout) was done before this step.

---

## How to tutor

Same rules as before: tests first, Jess types her files, hint ladder,
explain-back, update only the Progress log. HTML/CSS questions: just answer
or change them; they're plumbing here.

### Things to know about Jess

- Comfortable with the whole API (she wrote every route), `fetch` from tests,
  JSON, promises/`await`, errors with `status`.
- New in this step: the browser as a client (`fetch` from a page, the DOM,
  `<template>` cloning, event delegation), polling, and UI state that can be
  stale or in flight.
- Slips to expect: forgetting a `fetch` POST needs `{ method: 'POST' }`;
  treating a 4xx as an exception (`fetch` only rejects on network failure,
  so check `res.ok`); re-attaching event listeners on every redraw;
  redrawing the checklist and wiping the ticks every poll.

---

## What Step 5 must produce

### `app.js`: serve `.ts` as JavaScript (Jess's backend piece)

- `.ts` in `TYPES` as `text/javascript; charset=utf-8`.
- In `serveStatic`, when the extension is `.ts`, run the file's text through
  `stripTypeScriptTypes` from `node:module` before sending it.
- Tests (`test/app.test.js`, 2 new): `/hello.ts` comes back with no type
  annotations and can be imported and called; a missing `.ts` is a JSON 404.
  Fixture: `public/hello.ts`.
- Only erasable syntax works (no `enum`, `namespace`, parameter properties);
  `tsconfig.json` sets `erasableSyntaxOnly` so the editor flags them.
- Stripping never checks types. Type errors come from VS Code or `tsc -p .`
  (laptop only; plotpi just strips).

### `public/kiosk-view.ts` (pure, tested in Node)

```js
export function statusText(queue)   // → string for the header
export function controls(queue)     // → { hold, release, pause, resume, cancel } booleans
export function moves(pending)      // → [{ id, top, up, down }] booleans per row
```

Rules (the tests in `test/kiosk-view.test.js` are the contract):

- `statusText`: `'Queue empty'` when nothing is active or pending (hold or
  not); `'Plotting <name> for <user>'`; `'Paused: <name>'`; held + idle +
  waiting → `'Check the plotter, then release <first pending name>'`; not held
  + idle + waiting → `'Starting next plot'`.
- `controls`: `hold` iff not held; `release` iff held and nothing active and
  something pending; `pause` iff active and not paused; `resume` iff active and
  paused; `cancel` iff active.
- `moves`: `top` and `up` unless first; `down` unless last.

### `public/kiosk.ts` (browser only, checked by hand)

- Poll `GET /queue.json` every 1.5 s; on success hide `#error`, on failure
  show "Can't reach plotq".
- Draw: `#status-text`; `#active` (shown iff active; badge iff paused);
  `#checklist` (shown iff `controls(q).release`); `#pending-list` from the
  `pending-item` template (move buttons enabled from `moves`); `#recent-list`
  from `recent-item`; button `disabled` from `controls`.
- One click listener on `document` (event delegation): `data-action` →
  `/queue/<action>` or, for `cancel`, `/jobs/<active id>/cancel`;
  `data-move` / `data-cancel` on a pending row → `/jobs/<id>/move?to=…` /
  `/jobs/<id>/cancel`. After any POST, poll at once.
- Checklist: Release enabled only when all three boxes are ticked
  (AND `controls(q).release`). Ticks reset when the job it was for changes
  (a new first pending id), not on every poll.
- A failed POST shows the server's `{ error }` message in `#error`.

### Done when

- `npm test` green (13 new tests).
- Laptop: `PLOT_CMD=test/fake-plot.sh FAKE_PLOT_SECONDS=20 DATA_DIR=/tmp/plotq-dev npm start`,
  open `http://localhost:3001/kiosk.html` in a 480×320 window (browser dev
  tools, responsive mode). Upload two jobs with curl; reorder, release via the
  checklist, pause, resume, cancel, all from the page.

---

## Decisions already made (explain the "why")

- **Polling, not push.** One request every 1.5 s is nothing for plotq, needs
  no new server code, and recovers by itself after a restart. Push
  (Server-Sent Events, websockets) is a later option.
- **The server is the truth; the page only asks.** No button changes the
  screen by itself; it sends a POST and the next poll shows the result. So the
  page can never disagree with plotq for longer than one poll.
- **Decisions in `kiosk-view.js`, drawing in `kiosk.js`.** The rules ("can
  Release be pressed?") are pure functions of the queue, so they're testable
  without a browser. Same idea as thin routes over a store.
- **Release is disabled while something plots.** From Step 4: a Release
  during a plot would apply to the next job with nobody having checked its
  paper.

## Decisions to let Jess make

- What a button shows while its POST is in flight (`data-busy` is styled).
- Whether Cancel on the active job asks "Are you sure?" (one more tap, but a
  stray touch on a 3.5" screen ruins a plot). *Recommend: yes, tap twice.*
- Poll interval (1.5 s suggested).

---

## Lessons

### Lesson K0: Orientation (no code)

- **Explain:** the page is just another client of the API, like curl. The
  browser fetches `kiosk.html`, which loads `kiosk.js`, which calls the same
  routes. `<template>` and `cloneNode`; event delegation (one listener,
  `event.target.closest('button')`).
- **Ask:** "Someone taps Pause. The POST succeeds, but the next poll is 1.5 s
  away. What does the screen show in between, and is that a problem?"
  "The Pi reboots while the kiosk is open. What does the page do?"
- **Checkpoint:** Jess can trace one tap from the button to `worker.pause()`
  and back to the redraw.

### Lesson K0b: serving `.ts` (backend)

- **Build:** the `app.js` change above.
- **Ask:** "`readFile` returns a Buffer. What does `stripTypeScriptTypes` need,
  and what does `res.end` accept?"

### Lesson K1: `kiosk-view.ts`

- **Build:** the three pure functions against the tests.
- **Watch for:** `active.paused` when `active` is null (`?.`); `moves` index
  logic (`i > 0`, `i < length - 1`).

### Lesson K2: `kiosk.ts`, read and draw

- **Build:** poll loop, `#error`, draw every section from one `queue` object.
- **Watch for:** appending rows without clearing the list first (rows
  multiply every poll); `hidden` is a property, `el.hidden = true`.

### Lesson K3: `kiosk.ts`, send

- **Build:** delegated click handler, POST helper that checks `res.ok` and
  shows `{ error }`, checklist ticks and their reset rule.
- **Watch for:** `fetch` doesn't reject on 404/409; ticks wiped by redraw.

### Lesson K4: the laptop run, wrap-up

- The "done when" run. Explain-back: why the page never updates its own state
  after a tap. Commit: `Add kiosk page (step 5)`.
- Next: plotscreen setup (X + fbdev + Chromium kiosk, `sudo`: Jess runs it),
  systemd unit on plotpi, upload page.

---

## Progress log

- 2026-11-17, setup: Jess chose option 2 (tutor writes HTML/CSS, Jess writes
  the JS). Tutor wrote `public/kiosk.html` (header + Hold, error bar, active
  card, checklist, pending and recent lists, two `<template>`s),
  `public/kiosk.css` (fixed 480×320, 44 px targets, dark), this guide, and 13
  tests in `test/kiosk-view.test.js`. plotscreen: no reflash needed (Debian 13
  Lite already sees display and touch; X + Chromium to be installed on top);
  first check it's reachable again. Next: K0.
- 2026-11-17: Jess asked for TypeScript. Options given: JSDoc + `@ts-check`;
  real `.ts` with plotq stripping types when serving (`module.stripTypeScriptTypes`,
  built-in); `tsc` build step. Jess chose stripping-on-serve (no build, no
  packages). Verified on plotpi (Node v22.23.5): `stripTypeScriptTypes`
  exists and `.ts` runs directly. Tutor renamed the two empty files to
  `kiosk-view.ts`/`kiosk.ts`, pointed `kiosk.html` and the tests at them, added
  `public/hello.ts`, 2 app tests, and `tsconfig.json` (noEmit, DOM lib,
  `allowImportingTsExtensions`, `erasableSyntaxOnly`). Next: K0b.
- 2026-11-18, K0b: done, 86/87 (the one failing is `kiosk-view.test.js`,
  waiting for K1). Jess added `.ts` to `TYPES` and strips in `serveStatic`
  with `path.extname(file) === '.ts'`. Bugs: result of `stripTypeScriptTypes`
  discarded (it returns, doesn't mutate); Buffer passed instead of a string,
  then `.toString` applied after the strip instead of before. Final:
  `body = stripTypeScriptTypes(body.toString('utf8'))`. Next: K1.
- 2026-11-18, K1: done, 99/99, `tsc -p .` clean. Jess wrote `types.ts`
  (`Job` base, `ActiveJob`/`PendingJob`/`RecentJob` via `extends`, `state`
  as a union, `Queue`, `Controls`, `Moves`) and the three functions. Concepts:
  narrow types to the real data (`id: string`, `finished: string`, no extra
  `| null`); `import type` so the browser never fetches `types.ts`; return
  types catching a fall-through path (`statusText` two-`if` ending); arrays
  are always truthy (`&& pending`, `!pending` → `pending.length > 0`);
  `&&` returns an operand, so `active !== null && …` keeps a boolean; first
  and last can be the same row (`moves`). Release semantics clarified:
  held + idle + something pending. Next: K2 (`kiosk.ts` poll and draw).
- 2026-11-19, K2 pieces 1–2: poll loop (`fetch('/queue.json')`, `res.ok`
  check, `#error` bar with a friendly message + `console.error`, 1500 ms),
  `draw` sets the status line, `#active` and `#checklist` visibility with
  `hidden = !condition`, fills fields via the tutor's `$(selector, root)`
  helper. Confusions cleared: plotq serves the frontend itself (no separate
  server); the server had been started on plotpi, so `localhost` in the
  laptop browser found nothing. Review found the paused badge inverted and the
  checklist's name/user written into `activeSection`. Tutor confirmed the
  served `kiosk.ts`/`kiosk-view.ts` are valid JS after stripping. Next: piece 3
  (lists: `replaceChildren()` before appending, template `cloneNode`).
- 2026-11-20, K2 piece 3: pending and recent lists drawn from the templates
  with `replaceChildren()` first. Bugs: `$('pendingList')`/`$('pending-empty')`
  /`$('badge')` (missing `#`/`.`, camel-case id, no row root); an exception in
  `draw` lands in `poll`'s catch and shows "Can't reach plotq"; `length > 0`
  guards stopped emptied lists from clearing; badge text set to name/user
  instead of `state`, plus a `.bdage` typo. Tutor CSS fix: `#queue` needed
  `min-height: 0` (column flex item wouldn't shrink, so it was clipped instead
  of scrolling). Next: piece 4 (disabled states), then K3.
- 2026-11-21, K2 piece 4: done, `tsc -p .` clean. Fixed buttons via a loop
  over `['hold', …] as const` with `[data-action="…"]` attribute selectors and
  `disabled = !can[name]`; row move buttons set inside `pending.forEach((job, i))`
  from `moves(pending)[i]`. Concepts: attribute selectors; `as const` so a
  string can index `Controls`; `Moves[]` is an array, so index by row first
  (TS7015 caught `possibleMoves['top']`); clone a fresh fragment per row
  (append empties it); query buttons with `row` as root (the template content
  isn't searched by `document`, so the first row threw). A stray `$('$can')`
  would have thrown a `SyntaxError` whenever the checklist showed — `tsc`
  can't check selector strings. Next: K3 (sending).
