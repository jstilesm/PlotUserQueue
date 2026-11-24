import type { Queue, Controls, PendingJob, Moves } from './types.ts'

export function statusText(queue: Queue): string {
    // Status text will depend on whats happening

    const pending = queue.pending;
    const active = queue.active

    // Print active
    if (active) {
         // Print paused
        if (active?.paused) {
            return `Paused: ${active.name}`
        } else {
            return `Plotting ${active.name} for ${active.user}`
        }
    } else {
        // Queue Empty
        if (pending.length === 0) {
            return `Queue empty`
        }
        // Held job, shares with user
        if (queue.hold) {
            return `Check the plotter, then release ${pending[0].name}`
        }
        // not held
        return `Starting next plot`
        
    }


}

export function controls(queue: Queue): Controls {
    const pending = queue.pending;
    const active = queue.active
    const hold = queue.hold; 
    return {
        // if not held CAN hold
        hold: !hold, 
        // can release if held, nothing is active, and something is pending
        release: hold && !active && pending.length > 0,
        // can pause if active and not paused
        pause: active !== null && !active.paused, 
        // can resume if active and paused
        resume: active !== null && active.paused,
        // can cancel if active
        cancel: active !== null
    }
}

export function moves(pending: PendingJob[]) : Moves[] {
    return pending.map((job, i) => {
        const status = {
            id: job.id, 
            top: true, 
            up: true, 
            down: true
        }
        // if top cant go down 
        if (i === 0) {
            status.top = false;
            status.up = false;
        } 
        // if bottom cant go up
        if (i === pending.length - 1) {
            status.down = false;
        } 
        return status
    })
}