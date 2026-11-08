/**
 * Shared constants for the dsh-tray-follower host plugin.
 *
 * Everything here is plain data so the pure modules can be unit-tested with
 * `node --test` and no DSH runtime.
 */

/** Version of the state-file contract described in docs/DESIGN.md §4. */
export const SCHEMA_VERSION = 1

/** Every status written into `workspaces[].sessions[].status` (contract order). */
export const SESSION_STATUSES = Object.freeze([
  'running',
  'waiting-approval',
  'waiting-choice',
  'waiting-input',
  'completed',
  'failed',
  'idle',
])

/** Every kind written into `unreadEvents[].kind`. */
export const UNREAD_KINDS = Object.freeze(['completed', 'failed', 'needs-attention'])

/** State writes are coalesced; the contract requires ≤250 ms. */
export const STATE_DEBOUNCE_MS = 200

/** A "needs attention" unread event is published only after this quiet delay,
 * so an approval/question that is answered instantly never becomes a bridge
 * notification. */
export const ATTENTION_NOTIFY_DELAY_MS = 1_200

/** Periodic tick that refreshes `updatedAt` and prunes stale entries. */
export const TICK_INTERVAL_MS = 5_000

/** How long a finished, no-longer-live session stays in the published state. */
export const RETENTION_MS = 5 * 60_000

/** Self-imposed cap so a pathological event stream cannot grow the state file. */
export const MAX_TRACKED_SESSIONS = 200

/** Maximum retained unread events (contract: keep last 50). */
export const MAX_UNREAD_EVENTS = 50

/** Recently seen unread ids kept for de-duplication beyond the published ring. */
export const MAX_SEEN_UNREAD_IDS = 400

/** Tray menu ordering: things that need the user come first, idle last. */
export const STATUS_RANK = Object.freeze({
  'waiting-approval': 0,
  'waiting-choice': 1,
  'waiting-input': 2,
  running: 3,
  failed: 4,
  completed: 5,
  idle: 6,
})

/** Tool registered by @deepseek-ai/dsh-tool-ask-user. */
export const ASK_USER_TOOL = 'ask_user_question'

/** Synthetic workspace id used when a live conversation belongs to no workspace. */
export const UNASSIGNED_WORKSPACE_ID = 'unassigned'
