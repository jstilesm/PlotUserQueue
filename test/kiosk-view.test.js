// Tests for public/kiosk-view.ts: the kiosk's decisions, as pure functions.
// Given a /queue.json object, what should the screen say, and which buttons
// can be pressed? No DOM here; kiosk.js does the drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusText, controls, moves } from '../public/kiosk-view.ts';

const job = (id, extra = {}) => ({ id, name: `${id}.hpgl`, user: 'Dan', preview: null, ...extra });
const queue = (over = {}) => ({ hold: false, active: null, pending: [], recent: [], ...over });
const plotting = (paused = false) => ({ ...job('a'), progress: null, paused });

// ---- statusText(queue): the one line in the header ----

test('statusText: empty queue', () => {
  assert.equal(statusText(queue()), 'Queue empty');
  assert.equal(statusText(queue({ hold: true })), 'Queue empty', 'hold with nothing waiting is still empty');
});

test('statusText: plotting names the job and the person', () => {
  assert.equal(statusText(queue({ active: plotting() })), 'Plotting a.hpgl for Dan');
});

test('statusText: paused says so', () => {
  assert.equal(statusText(queue({ active: plotting(true) })), 'Paused: a.hpgl');
});

test('statusText: held with a job waiting asks for the checklist', () => {
  assert.equal(statusText(queue({ hold: true, pending: [job('b')] })), 'Check the plotter, then release b.hpgl');
});

test('statusText: not held, nothing active, something waiting: about to start', () => {
  assert.equal(statusText(queue({ pending: [job('b')] })), 'Starting next plot');
});

// ---- controls(queue): which header/active/checklist buttons are enabled ----

test('controls: empty queue, only Hold', () => {
  assert.deepEqual(controls(queue()), { hold: true, release: false, pause: false, resume: false, cancel: false });
});

test('controls: while plotting, Pause and Cancel; Release is off even when held', () => {
  assert.deepEqual(
    controls(queue({ hold: true, active: plotting(), pending: [job('b')] })),
    { hold: false, release: false, pause: true, resume: false, cancel: true },
  );
});

test('controls: while paused, Resume and Cancel, not Pause', () => {
  assert.deepEqual(
    controls(queue({ active: plotting(true) })),
    { hold: true, release: false, pause: false, resume: true, cancel: true },
  );
});

test('controls: held, idle, job waiting: Release', () => {
  assert.deepEqual(
    controls(queue({ hold: true, pending: [job('b')] })),
    { hold: false, release: true, pause: false, resume: false, cancel: false },
  );
});

test('controls: held with nothing waiting: no Release', () => {
  assert.equal(controls(queue({ hold: true })).release, false);
});

// ---- moves(pending): which move buttons each pending row gets ----

test('moves: first can only go down, last only up and top', () => {
  assert.deepEqual(moves([job('a'), job('b'), job('c')]), [
    { id: 'a', top: false, up: false, down: true },
    { id: 'b', top: true, up: true, down: true },
    { id: 'c', top: true, up: true, down: false },
  ]);
});

test('moves: a single job cannot move at all', () => {
  assert.deepEqual(moves([job('a')]), [{ id: 'a', top: false, up: false, down: false }]);
});

test('moves: empty list', () => {
  assert.deepEqual(moves([]), []);
});
