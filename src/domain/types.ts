export type Role = 'admin' | 'steward' | 'budget_owner' | 'reviewer' | 'expert' | 'qa';

export type CaseState =
  | 'opened'
  | 'slots_reserved'
  | 'reviewing'
  | 'concordant'
  | 'awaiting_expert'
  | 'waiting_funds'
  | 'expert_decided'
  | 'unresolved'
  | 'exported';

export type AssignmentState = 'offered' | 'accepted' | 'delivered' | 'expired' | 'cancelled';
export type EntitlementState = 'payable' | 'pending' | 'paid' | 'failed';
export type PatchState = 'draft' | 'approved' | 'exported';
export type DecisionSource = 'concordant' | 'expert' | 'supersede';

export interface Actor {
  id: string;
  tenant_id: string;
  principal_id: string;
  org_id: string;
  role: Role;
  alias: string;
  consent_status: 'opted_in' | 'opted_out' | null;
  languages: string[];
  calibration_expires_at: string | null;
  conflicts: string[];
  created_at: string;
}

export interface PolicySnapshot {
  policy_id: string;
  version: number;
  taxonomy: string[];
  taxonomy_hash: string;
  guideline_text: string;
  guideline_hash: string;
  expert_on_disagreement: boolean;
  allow_concordance: boolean;
  require_org_separation: boolean;
  review_price_minor: number;
  expert_price_minor: number;
  currency: string;
}

/** Lease length for an offer, in milliseconds. */
export const DEFAULT_LEASE_MS = 24 * 60 * 60 * 1000;
