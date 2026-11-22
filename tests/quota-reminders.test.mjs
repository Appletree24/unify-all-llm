import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQuotaReminders } from '../dist/quota/reminders.js';

const now = Date.parse('2026-11-21T05:00:00Z');
const inMinutes = (minutes) => new Date(now + minutes * 60_000).toISOString();
const reading = (limits, targetId = 'gemini-pro') => ({
  provider: 'gemini-pro', targetId, label: targetId, checkedAt: inMinutes(0), reading: { status: 'ok', limits },
});

test('reminds about remaining quota at the 30-minute boundary and deduplicates aliases and restarts', () => {
  const limits = [
    { label: '5-hour quota', remaining: 72, unit: '%', resetsAt: inMinutes(30) },
    { label: 'Later quota', remaining: 85, unit: '%', resetsAt: inMinutes(31) },
    { label: 'Expired quota', remaining: 2, unit: '%', resetsAt: inMinutes(-1) },
  ];
  const sample = [reading(limits), reading(limits, 'alternate')];
  const first = collectQuotaReminders(sample, {}, now);
  assert.equal(first.notice?.title, '额度即将重置');
  assert.equal(first.notice?.lines.length, 1);
  assert.match(first.notice.lines[0], /5-hour quota.*72%.*30 分钟/);
  assert.equal(first.changed, true);

  const repeated = collectQuotaReminders(sample, JSON.parse(JSON.stringify(first.history)), now);
  assert.equal(repeated.notice, undefined);
  assert.equal(repeated.changed, false);

  const next = collectQuotaReminders([reading([{ ...limits[0], resetsAt: inMinutes(60) }])], first.history, now + 30 * 60_000);
  assert.match(next.notice?.lines[0] ?? '', /5-hour quota.*30 分钟/);
});

test('warns at 10 percent and combines simultaneous warnings for the same window', () => {
  const sample = reading([
    { label: 'Weekly quota', remaining: 10, unit: '%', resetsAt: inMinutes(5) },
    { label: 'Just above threshold', remaining: 10.1, unit: '%', resetsAt: inMinutes(45) },
    { label: 'Depleted quota', remaining: 0, unit: '%', resetsAt: inMinutes(2) },
    { label: 'Unknown balance fraction', remaining: 0.01, unit: 'CNY' },
  ]);
  const { notice } = collectQuotaReminders([sample], {}, now);
  assert.equal(notice?.title, '套餐额度提醒');
  assert.equal(notice?.lines.length, 2);
  assert.match(notice.lines[0], /Weekly quota.*10%.*5 分钟.*快用完/);
  assert.match(notice.lines[1], /Depleted quota.*额度已用完/);
});

test('no-reset quotas rearm after recovery; errors and minor fluctuations stay quiet', () => {
  const sample = (remaining) => [reading([{ label: 'Requests', remaining, total: 40, unit: 'requests' }])];
  const low = collectQuotaReminders(sample(4), {}, now);
  assert.match(low.notice?.lines[0] ?? '', /4 requests/);
  const error = { ...sample(0)[0], reading: { status: 'error', message: 'timeout' } };
  assert.equal(collectQuotaReminders([error], low.history, now).notice, undefined);
  const fluctuation = collectQuotaReminders(sample(5), low.history, now);
  assert.equal(collectQuotaReminders(sample(2), fluctuation.history, now).notice, undefined);
  const recovery = collectQuotaReminders(sample(7), fluctuation.history, now);
  assert.equal(recovery.changed, true);
  assert.match(collectQuotaReminders(sample(2), recovery.history, now).notice?.lines[0] ?? '', /2 requests/);
});
