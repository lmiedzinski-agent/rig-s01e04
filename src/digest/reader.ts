import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, ReadNight } from './types.js';

type Event = {
  at: string;
  job: string;
  status: DigestStatus;
  owner: string | null;
  error?: string;
  instant: number;
  fraction: string;
};

function validNight(night: string): boolean {
  if (night.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return false;
  const [year, month, day] = night.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function parseEvent(line: string): Event | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('at' in value) || typeof value.at !== 'string'
    || !('job' in value) || typeof value.job !== 'string' || !value.job.trim()
    || !('owner' in value) || (value.owner !== null && typeof value.owner !== 'string')
    || !('status' in value) || (value.status !== 'ok' && value.status !== 'retry' && value.status !== 'fail')
    || ('error' in value && typeof value.error !== 'string')) return null;

  // Require a timezone so chronology never depends on the server's local timezone.
  const time = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/i.exec(value.at);
  if (!time || time[0] !== value.at || !validNight(time[1]) || Number(time[2]) > 23
    || Number(time[3]) > 59 || Number(time[4]) > 59
    || (time[7] !== undefined && (Number(time[7]) > 23 || Number(time[8]) > 59))) return null;
  const instant = Date.parse(value.at);
  if (!Number.isFinite(instant)) return null;

  return {
    at: value.at,
    job: value.job,
    owner: value.owner,
    status: value.status,
    ...('error' in value ? { error: value.error as string } : {}),
    instant,
    // Date.parse truncates sub-millisecond precision; keep it for ordering ties.
    fraction: (time[5] ?? '').replace(/0+$/, ''),
  };
}

function compareJobs(left: DigestRow, right: DigestRow): number {
  const a = Array.from(left.job);
  const b = Array.from(right.job);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validNight(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  let badLines = 0;
  const events: Event[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (event) events.push(event);
    else badLines++;
  }
  // Stable sorting preserves file order for events at the same instant.
  events.sort((a, b) => a.instant - b.instant
    || (a.fraction < b.fraction ? -1 : a.fraction > b.fraction ? 1 : 0));

  const counts = { ok: 0, retry: 0, fail: 0 };
  const jobs = new Map<string, DigestRow>();
  for (const event of events) {
    counts[event.status]++;
    let row = jobs.get(event.job);
    if (!row) {
      row = {
        job: event.job, owner: event.owner, runs: 0, retries: 0, failures: 0,
        lastStatus: event.status, lastError: null, firstAt: event.at, lastAt: event.at,
      };
      jobs.set(event.job, row);
    }
    row.runs++;
    if (event.status === 'retry') row.retries++;
    if (event.status === 'fail') row.failures++;
    row.owner = event.owner;
    row.lastStatus = event.status;
    if (event.error !== undefined) row.lastError = event.error;
    row.lastAt = event.at;
  }

  return { night, rows: [...jobs.values()].sort(compareJobs), badLines, counts };
};
