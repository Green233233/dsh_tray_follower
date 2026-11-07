/**
 * Deterministic identifiers for unread events.
 *
 * Ids must be stable for the same logical occurrence so a restarted Host or a
 * re-delivered event cannot produce a second notification: the bridge keeps its
 * own cursor keyed by these ids (docs/DESIGN.md §4).
 */
import { createHash } from 'node:crypto'

/**
 * Build a stable `evt_` id from arbitrary parts.
 * @param {...(string | number | undefined | null)} parts
 * @returns {string}
 */
export function stableEventId(...parts) {
  const canonical = parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => String(part))
    .join('\u0000')
  return `evt_${createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 20)}`
}
