import { post } from './cloud-http.js';
import { shapeOf } from './shape.js';
import { CloudError } from './cloud-error.js';
import { Budget, deadline, systemClock, type CloudClock } from './cloud-time.js';
import {
  accessTokenFrom,
  armBody,
  armCommand,
  credentialsFor,
  originFor,
  paths,
  selectSite,
  sessionIdFrom,
  siteLoginBody,
  sitesFrom,
  stateBody,
  type ArmTarget,
  type Credentials,
  type Session,
  type Site,
} from './cloud-protocol.js';
export type { ArmTarget, Credentials, Site } from './cloud-protocol.js';

export interface ClientOptions {
  origin?: string;
  requestTimeoutMs?: number;
  readBudgetMs?: number;
  writeBudgetMs?: number;
  clock?: CloudClock;
}

export interface StateResult {
  siteId: number;
  /** False when the cloud answered from its cache because the panel did not respond. */
  fromControlPanel: boolean;
  value: unknown;
}

export class RiscoClient {
  #credentials: Credentials;
  #origin: string;
  #session: Session | undefined;
  #login: Promise<Session> | undefined;
  #shutdown = new AbortController();
  #paused: CloudError | undefined;
  #cooldownUntil = 0;
  #clock: CloudClock;
  #requestTimeout: number;
  #readBudget: number;
  #writeBudget: number;
  #failures = 0;
  #notBefore = 0;
  #transient: CloudError | undefined;
  #invalidations: number[] = [];
  #rejectedShape: { stage: string; shape: unknown } | undefined;

  constructor(credentials: Credentials, options: ClientOptions = {}) {
    this.#credentials = credentialsFor(credentials);
    this.#origin = originFor(options.origin);
    this.#clock = options.clock ?? systemClock;
    this.#requestTimeout = deadline(options.requestTimeoutMs, 15_000);
    this.#readBudget = deadline(options.readBudgetMs, 45_000);
    this.#writeBudget = deadline(options.writeBudgetMs, 20_000);
  }

  /** Values-free structure of the latest authentication reply that did not decode. */
  rejectedShape(): { stage: string; shape: unknown } | undefined {
    return this.#rejectedShape;
  }

  close(): void {
    this.#shutdown.abort();
    this.#session = undefined;
  }

  /** Account sites visible to these credentials. Does not open a panel session. */
  async sites(options: { signal?: AbortSignal } = {}): Promise<Site[]> {
    this.checkAccess();
    const budget = new Budget(this.#readBudget, this.#clock, [
      this.#shutdown.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const token = this.decode(
        'login',
        await this.request(paths.login, this.userBody(), budget),
        accessTokenFrom,
      );
      return this.decode('sites', await this.request(paths.sites, {}, budget, token), sitesFrom);
    } catch (error) {
      this.pauseIfDenied(error);
      throw error;
    } finally {
      budget.dispose();
    }
  }

  /**
   * Transport acknowledgment only, never evidence that the panel changed state. A dispatched
   * command is never replayed, including after session expiry or a panel timeout.
   */
  async arm(
    partitionId: number,
    target: ArmTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<StateResult> {
    this.checkAccess();
    const command = armCommand(partitionId, target);
    const budget = new Budget(this.#writeBudget, this.#clock, [
      this.#shutdown.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let dispatched = false;
    try {
      budget.check();
      await this.waitBackoff(budget);
      const session = await budget.wait(this.authenticate());
      const body = armBody(session, command);
      this.checkAccess();
      budget.check();
      dispatched = true;
      try {
        const value = await this.request(paths.arm(session.siteId), body, budget, session.token);
        this.#failures = 0;
        return { siteId: session.siteId, fromControlPanel: true, value };
      } catch (error) {
        if (error instanceof CloudError && error.category === 'session-expired')
          this.invalidate(session);
        throw error;
      }
    } catch (error) {
      this.pauseIfDenied(error, false);
      let safe = error instanceof CloudError ? error : new CloudError('invalid-request');
      if (dispatched && this.isTransient(safe)) safe = this.backoff(safe);
      throw new CloudError(safe.category, safe.retryAfterMs, dispatched, safe.vendorResult);
    } finally {
      budget.dispose();
    }
  }

  /**
   * Reads are safe to repeat. When the live panel read times out, either as vendor result 72 or
   * by exceeding this client's request deadline, the read falls back once to the cloud's cached
   * state within the same budget instead of backing off.
   */
  async state(options: { signal?: AbortSignal } = {}): Promise<StateResult> {
    this.checkAccess();
    const budget = new Budget(this.#readBudget, this.#clock, [
      this.#shutdown.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      budget.check();
      await this.waitBackoff(budget);
      let session = await budget.wait(this.authenticate());
      let fromControlPanel = true;
      let renewed = false;
      let retries = 0;
      for (;;) {
        this.checkAccess();
        await this.waitBackoff(budget);
        try {
          const value = await this.request(
            paths.state(session.siteId),
            stateBody(session, fromControlPanel),
            budget,
            session.token,
          );
          this.#failures = 0;
          return { siteId: session.siteId, fromControlPanel, value };
        } catch (error) {
          this.pauseIfDenied(error, false);
          if (
            error instanceof CloudError &&
            fromControlPanel &&
            (error.category === 'panel-timeout' ||
              (error.category === 'timeout' && budget.remaining() > 0 && !budget.signal.aborted))
          ) {
            fromControlPanel = false;
            continue;
          }
          if (error instanceof CloudError && this.isTransient(error)) {
            const failure = this.backoff(error);
            if (renewed || retries >= 2) throw failure;
            retries += 1;
            continue;
          }
          if (!(error instanceof CloudError) || error.category !== 'session-expired') throw error;
          this.invalidate(session);
          if (renewed) this.cooldown();
          renewed = true;
          session = await budget.wait(this.authenticate());
        }
      }
    } finally {
      budget.dispose();
    }
  }

  private invalidate(session: Session): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    const now = this.#clock.now();
    this.#invalidations = this.#invalidations.filter((time) => now - time < 60_000);
    this.#invalidations.push(now);
    if (this.#invalidations.length >= 3) this.cooldown();
  }

  private cooldown(): never {
    this.#cooldownUntil = this.#clock.now() + 300_000;
    this.#session = undefined;
    this.#invalidations = [];
    throw new CloudError('session-contention', 300_000);
  }

  private async authenticate(): Promise<Session> {
    this.checkAccess();
    if (this.#session) return this.#session;
    this.#login ??= this.login()
      .catch((error: unknown) => {
        this.pauseIfDenied(error);
        if (error instanceof CloudError && error.category === 'session-expired') this.cooldown();
        if (error instanceof CloudError && this.isTransient(error)) throw this.backoff(error);
        throw error;
      })
      .finally(() => {
        this.#login = undefined;
      });
    return this.#login;
  }

  private isTransient(error: CloudError): boolean {
    return (
      error.category === 'unavailable' ||
      error.category === 'rate-limited' ||
      error.category === 'timeout' ||
      error.category === 'panel-timeout'
    );
  }

  private backoff(error: CloudError): CloudError {
    const delay = Math.max(
      error.retryAfterMs,
      Math.min(300_000, 5000 * 2 ** Math.min(this.#failures, 6) * (1 + 0.2 * this.#clock.random())),
    );
    this.#failures = Math.min(6, this.#failures + 1);
    this.#notBefore = Math.max(this.#notBefore, this.#clock.now() + delay);
    this.#transient = new CloudError(error.category, this.#notBefore - this.#clock.now());
    return this.#transient;
  }

  private async waitBackoff(budget: Budget): Promise<void> {
    while (this.#notBefore > this.#clock.now()) {
      const delay = this.#notBefore - this.#clock.now();
      budget.check();
      if (delay >= budget.remaining())
        throw new CloudError(this.#transient?.category ?? 'unavailable', delay);
      await budget.wait(this.#clock.sleep(delay, budget.signal));
    }
    budget.check();
  }

  private checkAccess(): void {
    if (this.#shutdown.signal.aborted) throw new CloudError('cancelled');
    if (this.#paused) throw this.#paused;
    if (this.#cooldownUntil > this.#clock.now())
      throw new CloudError('session-contention', this.#cooldownUntil - this.#clock.now());
  }

  private pauseIfDenied(error: unknown, accountScope = true): void {
    if (
      error instanceof CloudError &&
      (error.category === 'invalid-credentials' ||
        error.category === 'invalid-pin' ||
        error.category === 'site-selection' ||
        (accountScope && error.category === 'permission-denied'))
    ) {
      this.#paused = error;
      this.#session = undefined;
    }
  }

  private decode<T>(stage: string, value: unknown, decoder: (value: unknown) => T): T {
    try {
      const result = decoder(value);
      this.#rejectedShape = undefined;
      return result;
    } catch (error) {
      if (error instanceof CloudError && error.category === 'invalid-response')
        this.#rejectedShape = { stage, shape: shapeOf(value) };
      throw error;
    }
  }

  private userBody(): { userName: string; password: string } {
    return { userName: this.#credentials.username, password: this.#credentials.password };
  }

  private async login(): Promise<Session> {
    const budget = new Budget(3 * this.#requestTimeout, this.#clock, [this.#shutdown.signal]);
    try {
      const token = this.decode(
        'login',
        await this.request(paths.login, this.userBody(), budget),
        accessTokenFrom,
      );
      const site = selectSite(
        this.decode('sites', await this.request(paths.sites, {}, budget, token), sitesFrom),
        this.#credentials.siteId,
      );
      let sessionId: string;
      try {
        sessionId = this.decode(
          'siteLogin',
          await this.request(
            paths.siteLogin(site.id),
            siteLoginBody(this.#credentials.pin),
            budget,
            token,
          ),
          sessionIdFrom,
        );
      } catch (error) {
        // Panels lock their keypad after repeated wrong codes: any definite rejection of the
        // PIN stage pauses traffic instead of re-authenticating in a loop.
        if (
          error instanceof CloudError &&
          (this.isTransient(error) ||
            error.category === 'cancelled' ||
            error.category === 'invalid-response')
        )
          throw error;
        throw new CloudError('invalid-pin');
      }
      this.#session = { token, siteId: site.id, sessionId };
      return this.#session;
    } finally {
      budget.dispose();
    }
  }

  private async request(
    path: string,
    body: unknown,
    operation: Budget,
    token?: string,
  ): Promise<unknown> {
    this.checkAccess();
    operation.check();
    const budget = new Budget(Math.min(this.#requestTimeout, operation.remaining()), this.#clock, [
      operation.signal,
    ]);
    try {
      return await operation.wait(
        budget.wait(
          post({
            origin: this.#origin,
            path,
            body,
            ...(token ? { token } : {}),
            signal: budget.signal,
            now: () => this.#clock.now(),
          }),
        ),
      );
    } finally {
      budget.dispose();
    }
  }
}
