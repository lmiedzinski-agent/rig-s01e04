import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

const night = '2026-10-28';
const base = { at: '2026-10-29T01:00:00+01:00', job: 'job', owner: 'rook', status: 'ok' };
let runsDir: string;

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'rig-reader-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

function writeEvents(events: unknown[]) {
  writeFileSync(join(runsDir, `${night}.jsonl`), events.map(event => JSON.stringify(event)).join('\n'));
}

describe('readNight', () => {
  it('reads the real fixture without changing it', () => {
    const path = 'runs/2026-10-28.jsonl';
    const before = readFileSync(path);
    const digest = readNight('runs', night);
    expect(digest).toEqual({
      night,
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        {
          job: 'digest/render', owner: null, runs: 1, retries: 0, failures: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
        },
        {
          job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, failures: 0,
          lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
        },
        {
          job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, failures: 0,
          lastStatus: 'ok', lastError: 'lock held',
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
        },
        {
          job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, failures: 1,
          lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
        },
        {
          job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, failures: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
        },
      ],
    });
    expect(readFileSync(path)).toEqual(before);
  });

  it('orders by instant across offsets and retains the latest supplied error', () => {
    writeEvents([
      { ...base, at: '2026-10-29T01:30:00-02:00', owner: null },
      { ...base, at: '2026-10-29T03:00:00Z', status: 'fail', error: 'latest error' },
      { ...base, at: '2026-10-29T04:00:00+02:00', status: 'retry', error: 'older error' },
    ]);
    expect(readNight(runsDir, night)).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 1, fail: 1 },
      rows: [{
        job: 'job', owner: null, runs: 3, retries: 1, failures: 1,
        lastStatus: 'ok', lastError: 'latest error',
        firstAt: '2026-10-29T04:00:00+02:00', lastAt: '2026-10-29T01:30:00-02:00',
      }],
    });
  });

  it('breaks equivalent-instant ties in file order, including owners and errors', () => {
    writeEvents([
      { ...base, at: '2026-10-29T01:00:00.100+01:00', status: 'fail', error: 'first' },
      { ...base, at: '2026-10-29T00:00:00.1Z', status: 'retry', error: '' },
      { ...base, at: '2026-10-28T20:00:00.1000-04:00', owner: null },
    ]);
    expect(readNight(runsDir, night)?.rows[0]).toEqual({
      job: 'job', owner: null, runs: 3, retries: 1, failures: 1,
      lastStatus: 'ok', lastError: '',
      firstAt: '2026-10-29T01:00:00.100+01:00', lastAt: '2026-10-28T20:00:00.1000-04:00',
    });
  });

  it('orders fractional instants more precisely than milliseconds', () => {
    writeEvents([
      { ...base, at: '2026-10-29T00:00:00.1239Z', owner: 'latest' },
      { ...base, at: '2026-10-29T00:00:00.1231Z', owner: 'earliest' },
    ]);
    expect(readNight(runsDir, night)?.rows[0]).toMatchObject({
      owner: 'latest', firstAt: '2026-10-29T00:00:00.1231Z', lastAt: '2026-10-29T00:00:00.1239Z',
    });
  });

  it('sorts job names by code point and safely groups object-property names', () => {
    writeEvents(['😀', '__proto__', 'a', '\uE000', 'Z', 'constructor', 'a'].map(job => ({ ...base, job })));
    const rows = readNight(runsDir, night)?.rows;
    expect(rows?.map(row => row.job)).toEqual(['Z', '__proto__', 'a', 'constructor', '\uE000', '😀']);
    expect(rows?.find(row => row.job === 'a')?.runs).toBe(2);
  });

  const invalidEvents: unknown[] = [
    null, [], true, 123, 'text', {},
    { ...base, at: undefined }, { ...base, at: 123 }, { ...base, at: 'not a date' },
    { ...base, at: '2026-10-29' }, { ...base, at: '2026-10-29T01:00:00' },
    { ...base, at: '2026-10-29T01:00:00Z\n' },
    { ...base, at: '2026-02-29T01:00:00Z' }, { ...base, at: '2026-10-29T24:00:00Z' },
    { ...base, at: '2026-10-29T01:60:00Z' }, { ...base, at: '2026-10-29T01:00:60Z' },
    { ...base, at: '2026-10-29T01:00:00+24:00' }, { ...base, at: '2026-10-29T01:00:00+01:60' },
    { ...base, job: undefined }, { ...base, job: null }, { ...base, job: '' }, { ...base, job: '  ' },
    { ...base, owner: undefined }, { ...base, owner: 3 }, { ...base, owner: {} },
    { ...base, status: undefined }, { ...base, status: 'unknown' }, { ...base, status: ['ok'] },
    { ...base, error: null }, { ...base, error: false }, { ...base, error: {} },
  ];

  it.each(invalidEvents.map((value, index) => ({ value, index })))('counts invalid shape $index without losing valid events', ({ value }) => {
    writeEvents([base, value, { ...base, owner: null }]);
    const digest = readNight(runsDir, night);
    expect(digest?.badLines).toBe(1);
    expect(digest?.counts).toEqual({ ok: 2, retry: 0, fail: 0 });
    expect(digest?.rows).toHaveLength(1);
    expect(digest?.rows[0]).toMatchObject({ runs: 2, owner: null });
  });

  it('counts broken JSON and ignores blank lines, including CRLF and trailing whitespace', () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), `\r\n \t\r\n{broken\r\n ${JSON.stringify(base)} \r\n{"truncated":`);
    expect(readNight(runsDir, night)).toMatchObject({ badLines: 2, counts: { ok: 1, retry: 0, fail: 0 } });
  });

  it.each(['', '\n \t\r\n'])('returns an empty digest for an empty or blank file', contents => {
    writeFileSync(join(runsDir, `${night}.jsonl`), contents);
    expect(readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('returns an empty digest with bad-line counts when every event is invalid', () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), 'broken\nnull\n');
    expect(readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 2, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('returns null for missing files or a missing runs directory', () => {
    expect(readNight(runsDir, night)).toBeNull();
    expect(readNight(join(runsDir, 'missing'), night)).toBeNull();
  });

  it.each(['../2026-10-28', 'nested/2026-10-28', '/2026-10-28', '..\\2026-10-28', '2026-10-28.jsonl', '2026-10-28\n', '2026-1-2', '2026-00-28', '2026-13-01', '2026-02-29', '2026-10-00', '2026-10-32', ''])('rejects unsafe or invalid night %j', invalid => {
    expect(readNight(runsDir, invalid)).toBeNull();
  });

  it('accepts a valid leap-day night', () => {
    writeFileSync(join(runsDir, '2024-02-29.jsonl'), JSON.stringify({ ...base, at: '2024-02-29T01:00:00Z' }));
    expect(readNight(runsDir, '2024-02-29')?.badLines).toBe(0);
    expect(readNight(runsDir, '2024-02-29')?.rows).toHaveLength(1);
  });

  it('rejects traversal and malformed names even when the target file exists', () => {
    writeEvents([base]);
    const child = join(runsDir, 'child');
    mkdirSync(child);
    expect(readNight(child, `../${night}`)).toBeNull();
    expect(readNight(child, join(runsDir, night))).toBeNull();
    writeFileSync(join(runsDir, `${night}\n.jsonl`), JSON.stringify(base));
    expect(readNight(runsDir, `${night}\n`)).toBeNull();
  });

  it('propagates other filesystem failures', () => {
    mkdirSync(join(runsDir, `${night}.jsonl`));
    expect(() => readNight(runsDir, night)).toThrow();
  });
});
