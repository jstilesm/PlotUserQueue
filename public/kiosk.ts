import type { Queue } from "./types.ts";
import { statusText, controls, moves } from "./kiosk-view.ts";

function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`kiosk.html has no ${selector}`);
  return el;
}

function draw(queue : Queue) {
    const statusSection = $('#status-text');
    const activeSection = $('#active');
    const checklistSection = $('#checklist');
    const can = controls(queue)

    activeSection.hidden = queue.active === null;
    checklistSection.hidden = !can.release;

    statusSection.textContent = statusText(queue)

    if (queue.active) {
        $('.name', activeSection).textContent = queue.active.name;
        $('.user', activeSection).textContent = queue.active.user;
        if (queue.active.paused) {
            $('.badge.paused', activeSection).hidden = false
        } else {
            $('.badge.paused', activeSection).hidden = true
        }
    }
    if (can.release) {
        $('.name', checklistSection).textContent = queue.pending[0].name;
        $('.user', checklistSection).textContent = queue.pending[0].user;
    }
}

async function poll() {
    const errorBar = $('#error');
    try {
        const res = await fetch('/queue.json')
        if (!res.ok) {
            throw new Error(`HTTP Error! Status ${res.status}`)
        }
        const queue: Queue = await res.json();
        draw(queue)
        errorBar.hidden = true;
    } catch (error) {
        errorBar.textContent = `Can't reach plotq`;
        errorBar.hidden = false;
        console.error(error)
    }
}

// poll on load
poll();
// every 1.5 seconds
setInterval(poll, 1500);