/**
 * Payment adapter contract plus a team-controlled LOCAL-LEDGER implementation.
 *
 * LOCAL-LEDGER records compensation intents and references inside this checkout.
 * It is NOT a live payment rail: it can never produce external settlement proof,
 * so entitlements paid through it are recorded as provider 'LOCAL-LEDGER' and
 * are always distinguishable from verified external payouts.
 */
export interface PaymentQuote {
  amount_minor: number;
  currency: string;
  expires_at: string;
}

export interface PaymentResult {
  ref: string;
  status: 'pending' | 'settled' | 'unknown';
}

export interface PaymentAdapter {
  name: string;
  /** Whether refunds/cancellations are supported by this adapter. */
  supportsRefund: boolean;
  quote(amountMinor: number, currency: string): PaymentQuote;
  execute(quote: PaymentQuote, scope: string): PaymentResult;
  status(ref: string): PaymentResult;
}

export class LocalLedgerAdapter implements PaymentAdapter {
  name = 'LOCAL-LEDGER';
  supportsRefund = false;
  private refs = new Map<string, PaymentResult['status']>();
  private seq = 0;
  /** Test hook: force a status answer for fault injection. */
  forcedStatus: PaymentResult['status'] | null = null;

  quote(amountMinor: number, currency: string): PaymentQuote {
    return {
      amount_minor: amountMinor,
      currency,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  execute(quote: PaymentQuote, scope: string): PaymentResult {
    const ref = `local-${scope}-${++this.seq}`;
    const status = this.forcedStatus ?? 'settled';
    this.refs.set(ref, status);
    return { ref, status };
  }

  status(ref: string): PaymentResult {
    const status = this.forcedStatus ?? this.refs.get(ref) ?? 'unknown';
    return { ref, status };
  }

  /** Test hook: simulate the provider confirming settlement for a reference. */
  settle(ref: string): void {
    if (this.refs.has(ref)) this.refs.set(ref, 'settled');
  }
}
