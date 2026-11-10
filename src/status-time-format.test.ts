/**
 * /status shows the expiry as date and time with a zone label and never
 * rounds a partial day away (4.9 days left must not read as "4").
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatStatusExpiry, formatTimeRemaining } from './telegram-bot-handler.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatTimeRemaining keeps the partial day as hours', () => {
  assert.equal(formatTimeRemaining(4 * DAY + 23 * HOUR + 59 * MIN), '4 days, 23 hours');
  assert.equal(formatTimeRemaining(5 * DAY), '5 days, 0 hours');
  assert.equal(formatTimeRemaining(1 * DAY + 1 * HOUR), '1 day, 1 hour');
  assert.equal(formatTimeRemaining(5 * HOUR + 12 * MIN), '5 hours, 12 minutes');
  assert.equal(formatTimeRemaining(1 * MIN), '1 minute');
  assert.equal(formatTimeRemaining(30_000), 'less than a minute');
  assert.equal(formatTimeRemaining(-1), 'less than a minute');
  assert.equal(formatTimeRemaining(Number.NaN), 'less than a minute');
});

test('formatStatusExpiry shows date and time in Eastern time with a zone label', () => {
  // 2026-11-15T02:34:47Z is Sat Nov 14, 9:34 PM EST
  const s = formatStatusExpiry(new Date('2026-11-15T02:34:47Z'));
  assert.match(s, /^Sat, Nov 14, 2026, 9:34\s?PM EST$/);
  // Daylight time label in summer
  assert.match(formatStatusExpiry(new Date('2026-07-01T16:00:00Z')), /12:00\s?PM EDT$/);
});
