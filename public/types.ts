
interface Job {
    id: string;
    name: string;
    user: string;
}

interface ActiveJob extends Job {
    preview: string | null;
    progress: number | null;
    paused: boolean;
}
export interface PendingJob extends Job {
    preview: string | null;
}
interface RecentJob extends Job {
    state: 'done' | 'failed' | 'cancelled';
    finished: string;
}
export type Controls = {
    hold: boolean,
    release: boolean,
    pause: boolean;
    resume: boolean;
    cancel: boolean
}
export type Moves = {
    id: string,
    top: boolean,
    up: boolean,
    down: boolean
}

export type Queue = {
    hold: boolean;
    active: ActiveJob | null;
    pending: PendingJob[];
    recent: RecentJob[];
}

