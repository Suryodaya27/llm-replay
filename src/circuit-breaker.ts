/**
 * Circuit Breaker — prevents cascading failures when LLM providers are down.
 *
 * Design Pattern: Circuit Breaker (from Michael Nygard's "Release It!")
 *
 * Three states:
 *   CLOSED  → normal operation, requests pass through
 *   OPEN    → provider is down, requests fail immediately (fast failure)
 *   HALF_OPEN → testing if provider recovered, allows one probe request
 *
 * State transitions:
 *   CLOSED → OPEN: when failure count exceeds threshold within window
 *   OPEN → HALF_OPEN: after cooldown period expires
 *   HALF_OPEN → CLOSED: if probe request succeeds
 *   HALF_OPEN → OPEN: if probe request fails
 *
 * Why this matters:
 *   Without a circuit breaker, agents hang for minutes when Ollama is down.
 *   With it, they get an instant error and can handle it gracefully.
 *   The proxy auto-recovers when the provider comes back — no manual restart.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time window for counting failures (ms) */
  failureWindow: number;
  /** How long to stay open before trying again (ms) */
  cooldownMs: number;
  /** Timeout for individual requests (ms) — if exceeded, counts as failure */
  requestTimeout: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  failureWindow: 30_000,    // 30 seconds
  cooldownMs: 15_000,       // 15 seconds
  requestTimeout: 120_000,  // 2 minutes (LLMs are slow)
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = []; // timestamps of recent failures
  private lastFailure: number = 0;
  private openedAt: number = 0;
  private readonly config: CircuitBreakerConfig;

  // Observable state for monitoring
  private _totalRequests = 0;
  private _totalFailures = 0;
  private _totalShortCircuited = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function through the circuit breaker.
   * If circuit is open, throws immediately without calling fn.
   * If fn fails or times out, records failure and may open circuit.
   *
   * Design Pattern: Template Method — the breaker controls the lifecycle,
   * the caller provides the operation.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this._totalRequests++;

    // Check if circuit allows the request
    if (!this.canRequest()) {
      this._totalShortCircuited++;
      throw new CircuitOpenError(
        `Circuit breaker is OPEN — provider appears down. Will retry in ${this.remainingCooldown()}ms`,
        this.state,
        this.remainingCooldown()
      );
    }

    // Execute with timeout
    try {
      const result = await this.withTimeout(fn(), this.config.requestTimeout);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Can a request go through right now? */
  private canRequest(): boolean {
    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        // Check if cooldown has expired → transition to half_open
        const elapsed = Date.now() - this.openedAt;
        if (elapsed >= this.config.cooldownMs) {
          this.state = 'half_open';
          return true; // allow one probe request
        }
        return false; // still cooling down
      }

      case 'half_open':
        return true; // allow the probe
    }
  }

  /** Called when a request succeeds */
  private onSuccess(): void {
    if (this.state === 'half_open') {
      // Probe succeeded → close the circuit
      this.state = 'closed';
      this.failures = [];
    }
  }

  /** Called when a request fails */
  private onFailure(): void {
    this._totalFailures++;
    const now = Date.now();
    this.lastFailure = now;
    this.failures.push(now);

    // Remove failures outside the window
    const windowStart = now - this.config.failureWindow;
    this.failures = this.failures.filter(t => t >= windowStart);

    if (this.state === 'half_open') {
      // Probe failed → back to open
      this.state = 'open';
      this.openedAt = now;
      return;
    }

    // Check if failures exceed threshold → open circuit
    if (this.failures.length >= this.config.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  /** Remaining cooldown time before next probe (ms) */
  private remainingCooldown(): number {
    if (this.state !== 'open') return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.config.cooldownMs - elapsed);
  }

  /** Wrap a promise with a timeout */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Request timed out after ${ms}ms`));
      }, ms);

      promise
        .then((val) => { clearTimeout(timer); resolve(val); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  // --- Public observability ---

  get currentState(): CircuitState { return this.state; }
  get stats() {
    return {
      state: this.state,
      totalRequests: this._totalRequests,
      totalFailures: this._totalFailures,
      totalShortCircuited: this._totalShortCircuited,
      recentFailures: this.failures.length,
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null,
    };
  }

  /** Manually reset the breaker (for testing or admin override) */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
  }
}

/** Custom error thrown when circuit is open */
export class CircuitOpenError extends Error {
  constructor(
    message: string,
    public readonly circuitState: CircuitState,
    public readonly retryAfterMs: number
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
