import type { Actor, PolicySnapshot } from './types.ts';

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Check a reviewer/expert actor against a case's frozen policy and item.
 * `conflicts` are org ids or item ids the actor is excluded from touching.
 */
export function checkEligibility(
  actor: Actor,
  item: { language: string; org_id: string; id: string },
  opts: { role: 'reviewer' | 'expert'; now?: Date }
): EligibilityResult {
  const reasons: string[] = [];
  const now = opts.now ?? new Date();
  if (actor.role !== opts.role) reasons.push(`role_${actor.role}_not_${opts.role}`);
  if (actor.consent_status !== 'opted_in') reasons.push('consent_not_opted_in');
  if (!actor.languages.includes(item.language)) reasons.push('language_not_eligible');
  if (!actor.calibration_expires_at || Date.parse(actor.calibration_expires_at) <= now.getTime()) {
    reasons.push('calibration_expired');
  }
  if (actor.conflicts.includes(item.org_id) || actor.conflicts.includes(item.id)) {
    reasons.push('conflict_of_interest');
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Validate that a pair of reviewers may occupy the two blind slots:
 * distinct principals always; distinct orgs when the policy requires it.
 */
export function checkSlotPair(
  a: Actor,
  b: Actor,
  policy: PolicySnapshot
): EligibilityResult {
  const reasons: string[] = [];
  if (a.principal_id === b.principal_id) reasons.push('same_principal');
  if (a.id === b.id) reasons.push('same_actor');
  if (policy.require_org_separation && a.org_id === b.org_id) {
    reasons.push('org_separation_required');
  }
  return { eligible: reasons.length === 0, reasons };
}
