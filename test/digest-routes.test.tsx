import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const configFor = (runsDir: string) => ({
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir,
});

async function withRunsFile<T>(
  night: string,
  contents: string,
  run: (runsDir: string) => Promise<T>,
): Promise<T> {
  const runsDir = await mkdtemp(join(tmpdir(), 'rig-digest-routes-'));
  try {
    await writeFile(join(runsDir, `${night}.jsonl`), contents, 'utf8');
    return await run(runsDir);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
}

const event = (at: string, job: string, status: 'ok' | 'retry' | 'fail', owner: string | null, error?: string) =>
  JSON.stringify({ at, job, status, owner, ...(error === undefined ? {} : { error }) });

describe('digest routes', () => {
  it('returns sorted JSON and renders the same jobs with warnings, null owner, bad lines, and original offsets', async () => {
    const night = '2026-10-30';
    const contents = [
      event('2026-10-30T12:00:00+05:30', 'zulu', 'fail', 'ops', 'disk full'),
      event('2026-10-30T12:00:00+05:30', 'beta', 'ok', null),
      event('2026-10-30T12:00:00+05:30', '\u{1f600}', 'ok', 'rook'),
      event('2026-10-30T12:00:00+05:30', '\uE000', 'ok', 'rook'),
      event('2026-10-30T12:01:00+05:30', 'alpha', 'retry', 'rook', 'upstream 503'),
      '{not json',
      event('2026-10-30T12:02:00+05:30', 'alpha', 'retry', 'rook', 'upstream 503'),
      event('2026-10-30T12:00:30+05:30', 'alpha', 'retry', 'rook', 'upstream 503'),
      event('2026-10-30T12:03:00+05:30', 'alpha', 'ok', 'rook'),
    ].join('\n');

    await withRunsFile(night, `${contents}\n`, async (runsDir) => {
      const app = createApp(configFor(runsDir));
      const jsonResponse = await app.request(`/api/digest/${night}`);
      expect(jsonResponse.status).toBe(200);
      const digest = (await jsonResponse.json()) as NightDigest;
      expect(digest).toMatchObject({
        night,
        badLines: 1,
        counts: { ok: 4, retry: 3, fail: 1 },
      });
      expect(digest.rows.map((row) => row.job)).toEqual(['alpha', 'beta', 'zulu', '\uE000', '\u{1f600}']);
      expect(digest.rows[0]).toMatchObject({
        job: 'alpha', owner: 'rook', runs: 4, retries: 3, failures: 0, lastStatus: 'ok',
        firstAt: '2026-10-30T12:00:30+05:30', lastAt: '2026-10-30T12:03:00+05:30',
      });
      expect(digest.rows[1]).toMatchObject({
        job: 'beta', owner: null, firstAt: '2026-10-30T12:00:00+05:30', lastAt: '2026-10-30T12:00:00+05:30',
      });

      const htmlResponse = await app.request(`/digest/${night}`);
      expect(htmlResponse.status).toBe(200);
      const html = await htmlResponse.text();
      expect(html).toContain('bad lines 1');
      const alphaIndex = html.indexOf('<td>alpha</td>');
      const betaIndex = html.indexOf('<td>beta</td>');
      const zuluIndex = html.indexOf('<td>zulu</td>');
      const privateUseIndex = html.indexOf('<td>\uE000</td>');
      const emojiIndex = html.indexOf('<td>\u{1f600}</td>');
      expect(alphaIndex).toBeGreaterThan(-1);
      expect(alphaIndex).toBeLessThan(betaIndex);
      expect(betaIndex).toBeLessThan(zuluIndex);
      expect(zuluIndex).toBeLessThan(privateUseIndex);
      expect(privateUseIndex).toBeLessThan(emojiIndex);
      expect(html).toContain('<td class="warn">3</td>');
      expect(html).toContain('<td class="warn">fail</td>');
      expect(html).toContain('<td>—</td>');
      expect(html).toContain('<td>2026-10-30T12:00:30+05:30</td>');
      expect(html).toContain('<td>2026-10-30T12:03:00+05:30</td>');
      expect(html).toContain('<td>2026-10-30T12:00:00+05:30</td>');
    });
  });

  it('returns a successful empty digest and renders “nothing ran” for an empty file', async () => {
    const night = '2026-10-31';

    await withRunsFile(night, '', async (runsDir) => {
      const app = createApp(configFor(runsDir));
      const jsonResponse = await app.request(`/api/digest/${night}`);
      expect(jsonResponse.status).toBe(200);
      await expect(jsonResponse.json()).resolves.toEqual({
        night,
        rows: [],
        badLines: 0,
        counts: { ok: 0, retry: 0, fail: 0 },
      });

      const htmlResponse = await app.request(`/digest/${night}`);
      expect(htmlResponse.status).toBe(200);
      expect(await htmlResponse.text()).toContain('nothing ran');
    });
  });

  it('returns 404 from both routes when the night file is missing', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'rig-digest-routes-'));
    try {
      const app = createApp(configFor(runsDir));
      const htmlResponse = await app.request('/digest/2026-11-01');
      const jsonResponse = await app.request('/api/digest/2026-11-01');
      expect(htmlResponse.status).toBe(404);
      expect(await htmlResponse.text()).toContain('night not found');
      expect(jsonResponse.status).toBe(404);
      await expect(jsonResponse.json()).resolves.toEqual({ error: 'Night not found' });
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});
