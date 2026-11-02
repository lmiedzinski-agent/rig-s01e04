export type DigestStatus = 'ok' | 'retry' | 'fail';

export type DigestCounts = Record<DigestStatus, number>;

export type DigestRow = {
  job: string;
  // Owner and status come from the latest event, including a null owner.
  owner: string | null;
  // Every valid event counts as a run, including retries and failures.
  runs: number;
  retries: number;
  failures: number;
  lastStatus: DigestStatus;
  // Most recent supplied error, retained even if a later event succeeds.
  lastError: string | null;
  // Earliest/latest event times, preserving the log's original offset.
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string;
  // One row per job, sorted by job in ascending code-point order.
  rows: DigestRow[];
  // Nonblank lines with invalid JSON or an invalid event shape.
  badLines: number;
  // Counts of valid events, rather than counts of final job statuses.
  counts: DigestCounts;
};

/**
 * Implemented as readNight in ./reader.ts. Missing files and invalid night
 * names return null; empty files return a digest with no rows and zero counts.
 * Nights use YYYY-MM-DD. Events are ordered by instant, with file order
 * breaking ties. Other filesystem failures propagate to the caller.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
