import { MAX_MEMBERS } from './groupDocs';
import type { PendingJoinRequest } from './session';

/**
 * What the Owner's map shows for the pending Join requests (spec §7.4, §7.5): the one request the banner
 * names, whether the Group is full so Approve must not be offered, how many the ⋯ item counts, and the
 * whole list the ⋯ → Join requests screen shows.
 */
export type JoinQueue = {
  banner: PendingJoinRequest | null;
  full: boolean;
  count: number;
  requests: PendingJoinRequest[];
};

/**
 * The Owner's view of the pending Join requests. `dismissed` holds the uids "Not now" hid this session:
 * the banner names the first request that is still pending and not hidden, while the ⋯ item and the list
 * keep every pending request findable regardless. `memberCount` is the Group's live Member count,
 * compared against the cap the rules cannot enforce (§5).
 *
 * This owns no subscription and no state of its own: the caller passes the live reads and its own
 * dismissal set, so "Not now" hides the banner for this session without writing anything.
 */
export function joinQueue(
  requests: PendingJoinRequest[],
  memberCount: number,
  dismissed: ReadonlySet<string>,
): JoinQueue {
  return {
    banner: requests.find((request) => !dismissed.has(request.uid)) ?? null,
    full: memberCount >= MAX_MEMBERS,
    count: requests.length,
    requests,
  };
}
