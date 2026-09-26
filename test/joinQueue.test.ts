import { describe, expect, it } from 'vitest';

import { joinQueue } from '../src/joinQueue';
import type { PendingJoinRequest } from '../src/session';

// Ways the Owner's pending-request queue (ticket 09) could fail, written before src/joinQueue.ts:
//  1. The banner names a request other than the first pending one.
//  2. "Not now" does not hide the banner: a dismissed request is still named.
//  3. Dismissing one request hides the banner although another is still pending.
//  4. The ⋯ → Join requests (n) count drops dismissed requests; it must count every pending one.
//  5. The list drops dismissed requests; it must keep every pending one.
//  6. A Group at the four-Member cap is not reported full, so Approve is offered.
//  7. A Group under the cap is reported full, so a request that could be approved is not.
//  8. No pending requests yields a banner instead of none.

const PRIYA: PendingJoinRequest = { uid: 'priya-uid', displayName: 'Priya' };
const ALEX: PendingJoinRequest = { uid: 'alex-uid', displayName: 'Alex' };
const NOTHING_DISMISSED: ReadonlySet<string> = new Set();

describe('joinQueue', () => {
  it('names the first pending request, and counts and lists them all', () => {
    expect(joinQueue([PRIYA, ALEX], 2, NOTHING_DISMISSED)).toEqual({
      banner: PRIYA,
      full: false,
      count: 2,
      requests: [PRIYA, ALEX],
    });
  });

  it('hides the banner for a dismissed request but keeps it counted and listed', () => {
    const queue = joinQueue([PRIYA], 2, new Set([PRIYA.uid]));

    expect(queue.banner).toBeNull();
    expect(queue.count).toBe(1);
    expect(queue.requests).toEqual([PRIYA]);
  });

  it('names another pending request the Owner has not dismissed', () => {
    expect(joinQueue([PRIYA, ALEX], 2, new Set([PRIYA.uid])).banner).toEqual(ALEX);
  });

  it('shows no banner when nothing is pending', () => {
    expect(joinQueue([], 2, NOTHING_DISMISSED).banner).toBeNull();
  });

  it.each([0, 1, 2, 3])('is not full at %i Members', (memberCount) => {
    expect(joinQueue([PRIYA], memberCount, NOTHING_DISMISSED).full).toBe(false);
  });

  it.each([4, 5])('is full at %i Members, but still names and lists the request', (memberCount) => {
    const queue = joinQueue([PRIYA], memberCount, NOTHING_DISMISSED);

    expect(queue.full).toBe(true);
    expect(queue.banner).toEqual(PRIYA);
    expect(queue.count).toBe(1);
  });
});
