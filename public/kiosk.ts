import type { Queue, ActiveJob, RecentJob, PendingJob } from "./types.ts";
import { statusText, controls, moves } from "./kiosk-view.ts";

// Helper to find HTML Elements within the HTML
function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`kiosk.html has no ${selector}`);
  return el;
}


function drawActive(active: ActiveJob, section: HTMLElement) {
     $('.name', section).textContent = active.name;
     $('.user', section).textContent = active.user;

     // add id for click actions
     section.dataset.id = active.id
        if (active.paused) {
            $('.badge.paused', section).hidden = false
        } else {
            $('.badge.paused', section).hidden = true
        }

}
function drawPending(pending: PendingJob[], section: HTMLElement) {
    const template = $<HTMLTemplateElement>('#pending-item');
    const possibleMoves = moves(pending)

    // clear the last draw's rows, each time i cycle through a job, 
    // dont want to grab the name and users from the previous
    section.replaceChildren();

    pending.forEach((job, i) => {
        // provides context so the whole document isnt searched for the items
        let row = template.content.cloneNode(true) as DocumentFragment
        
        // Turn on or off directions buttons based off of possible moves
        for (const name of ['top', 'up', 'down'] as const) {
            $<HTMLButtonElement>(`[data-move="${name}"]`, row).disabled = !possibleMoves[i][name]

        }
        // add id for click actions
        $('li', row).dataset.id = job.id

        $('.name', row).textContent = job.name;
        $('.user', row).textContent = job.user;
        section.append(row)
    })

}
function drawRecent(recent: RecentJob[], section: HTMLElement) {
    const template = $<HTMLTemplateElement>('#recent-item');

    section.replaceChildren();

    for (const job of recent) {

        let row = template.content.cloneNode(true) as DocumentFragment
        $('.name', row).textContent = job.name;
        $('.user', row).textContent = job.user;
        $('.badge.state', row).classList.add(job.state);
        $('.badge.state', row).textContent = job.state;
        section.append(row)
    }
}
let lastNextId: string | undefined

function draw(queue : Queue) {
    const statusSection = $('#status-text');
    const activeSection = $('#active');
    const pendingSection = $('#pending-list')
    const checklistSection = $('#checklist');
    const recentSection = $('#recent-list')

    const can = controls(queue)
    
    activeSection.hidden = queue.active === null;
    $('#pending-empty').hidden = queue.pending.length > 0;

    checklistSection.hidden = !can.release;

    statusSection.textContent = statusText(queue)
    if (queue.active) {
        drawActive(queue.active, activeSection)
    }
    drawPending(queue.pending, pendingSection)

    drawRecent(queue.recent, recentSection)


    // Turn on or off buttons based off of release
   for (const name of ['hold', 'pause', 'resume', 'cancel'] as const) {
        $<HTMLButtonElement>(`[data-action="${name}"]`).disabled = !can[name]
    }

    // grey out print button if all buttons not checked
    const boxes = document.querySelectorAll<HTMLInputElement>('input[name=check]')
    if (queue.pending[0]?.id !== lastNextId) {
        [...boxes].forEach(b => {b.checked = false })
    }
    lastNextId = queue.pending[0]?.id
    const allTicked = [...boxes].every(b => b.checked)
    $<HTMLButtonElement>('[data-action="release"]').disabled = !(can.release && allTicked)

    if (can.release) {
        $('.name', checklistSection).textContent = queue.pending[0].name;
        $('.user', checklistSection).textContent = queue.pending[0].user;
    }
}

async function send(path :string) {
    const errorBar = $('#error');
    try {
        const res = await fetch(path, {method: 'POST'})
        const data = await res.json()
        
        if (!res.ok) {
            throw new Error(data.error || `HTTP Error! Status ${res.status}`)
        }
        errorBar.hidden = true;
        poll();
    } catch (error) {
        if (error instanceof Error) {
            errorBar.textContent = `${error.message}`;
        } else {
            errorBar.textContent = `Something went wrong`
        }
        errorBar.hidden = false;
    }
    
}
let lastText: string | undefined;
let lastQueue: Queue | undefined;

async function poll() {
    const errorBar = $('#error');
    try {
        const res = await fetch('/queue.json')
        const text = await res.text()
        if (!res.ok) {
            throw new Error(`HTTP Error! Status ${res.status}`)
        }

        errorBar.hidden = true;
        if (text === lastText) {
            return
        }
        lastText = text
        const queue: Queue = JSON.parse(text) 
        lastQueue = queue
        draw(queue)
    } catch (error) {
        errorBar.textContent = `Can't reach plotq`;
        errorBar.hidden = false;
        console.error(error)
    }
}

document.addEventListener('click', (event) => {
  const button = (event.target as Element).closest('button')
  if (!button || button.disabled) return
  const {action, move} = button.dataset
  const rowId = button.closest('li')?.dataset.id

  if (action === 'cancel') {
        send(`/jobs/${$('#active').dataset.id}/${action}`)
    } else if (action) {
        send(`/queue/${action}`)
    } else if (move) {
        send(`/jobs/${rowId}/move?to=${move}`)
  } else if ('cancel' in button.dataset) {
        send(`/jobs/${rowId}/cancel`)
  }
  
})
document.addEventListener('change', () => {
    if (lastQueue) draw(lastQueue)
})

// poll on load
poll();
// every 1.5 seconds
setInterval(poll, 1500);

