/* WHO IS ACTUALLY ASKING WHETHER THE BOARD IS STILL BEING FED.
 *
 * ingestion-stall-alert.yml was written to ask that question every 30 minutes. GitHub does not
 * run it every 30 minutes. Measured over 2026-08-27..2026-09-02, every scheduled workflow in this
 * repository - not just this one - was delivered five to eight times a day with a median gap of
 * 3.5 to 5 hours, whatever cron it declared. The two-hourly workflow had been landing within a
 * minute or two of its declared 120 until 2026-08-26, then slipped to 220-440 minutes alongside
 * everything else, which is the measurement that matters: the throttling is account-wide and
 * cadence-blind, so no declared interval buys detection back. GitHub's scheduler is best-effort on public repositories
 * and it is currently not delivering.
 *
 * SO THE SAMPLING MOVED IN HERE, where an interval is an interval. This runs inside the API
 * process, which Railway keeps alive with restartPolicy ALWAYS and probes at /health.
 *
 * IT DELIBERATELY DOES NOT RUN IN THE WORKER. The worker is the component that failed on
 * 2026-09-01: it sat in a logo-verification retry loop reporting SUCCESS and polling nothing. A
 * check hosted inside it would have been wedged by the same loop it was supposed to report. The
 * alarm has to be on a different circuit from the fire, and the API is that circuit - it does not
 * share the drain loop, and its own death is separately visible at /health.
 *
 * WHY IT REMEMBERS INSTEAD OF JUST ANSWERING. The endpoint alone answers "is the board stale right
 * now". Sampled every few hours, that question does not merely answer late - it misses outright:
 * a stall that begins and ends between two reads leaves no trace. Continuous sampling plus a
 * retained record turns a sparse reader into an adequate one, because the reader stops needing to
 * be present at the moment of failure. That is the difference between detection latency, which is
 * now the interval below, and notification latency, which is still whenever GitHub feels like it.
 *
 * EVERYTHING HERE FAILS CLOSED, for the reason ingestionHealth fails closed: the 2026-09-01 stall
 * was silent for seven and a half hours because every signal defaulted to "fine" without evidence.
 * A monitor that never started, a read that threw, and a board that has never been polled must all
 * be distinguishable from a board that is genuinely fresh, and none of them may read as healthy.
 */
import { ingestionHealth, type IngestionHealth } from './ingestionHealth';

export const DEFAULT_MONITOR_INTERVAL_MS = 10 * 60_000;
/* Long enough that an observation survives until the next GitHub delivery even at the worst
   measured gap (400 minutes), so a recorded stall cannot expire unread; short enough that the
   alarm clears itself within a day once the board recovers, instead of staying red until a human
   acknowledges it and thereby training everyone to ignore it. */
export const DEFAULT_OBSERVATION_RETENTION_MS = 12 * 60 * 60_000;
export const DEFAULT_THRESHOLD_MS = 180 * 60_000;

export type BoardFreshness = { newest_seen_at: Date | null; active_jobs: number };

export type IngestionObservations = {
  /* False whenever sampling is not actually happening - the process never started the monitor, or
     it has been stopped. A reader must treat this as a failure, not as an absence of bad news. */
  monitor_running: boolean;
  monitor_interval_minutes: number;
  retention_hours: number;
  threshold_minutes: number;
  started_at: string | null;
  checks: number;
  read_failures: number;
  last_checked_at: string | null;
  /* The last sample that positively proved the board fresh. Stays put across read failures on
     purpose: an unreadable database is not evidence of a healthy board. */
  last_healthy_at: string | null;
  currently_stalled: boolean | null;
  /* Stall samples still inside the retention window. */
  stall_observations: number;
  first_stall_observed_at: string | null;
  last_stall_observed_at: string | null;
  worst_staleness_minutes: number | null;
  worst_observed_at: string | null;
};

type StallSample = { at: number; staleness_minutes: number | null };

export type IngestionStallMonitorOptions = {
  read: () => Promise<BoardFreshness>;
  thresholdMs?: number;
  intervalMs?: number;
  retentionMs?: number;
  logger?: Pick<Console, 'log' | 'error'>;
  now?: () => Date;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class IngestionStallMonitor {
  private readonly read: () => Promise<BoardFreshness>;
  private readonly thresholdMs: number;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly logger: Pick<Console, 'log' | 'error'>;
  private readonly now: () => Date;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private handle: unknown = null;
  private startedAt: number | null = null;
  private checks = 0;
  private readFailures = 0;
  private lastCheckedAt: number | null = null;
  private lastHealthyAt: number | null = null;
  private currentlyStalled: boolean | null = null;
  private stalls: StallSample[] = [];
  private worst: StallSample | null = null;
  private inFlight = false;

  constructor(options: IngestionStallMonitorOptions) {
    this.read = options.read;
    this.thresholdMs = positive(options.thresholdMs, DEFAULT_THRESHOLD_MS);
    this.intervalMs = positive(options.intervalMs, DEFAULT_MONITOR_INTERVAL_MS);
    this.retentionMs = positive(options.retentionMs, DEFAULT_OBSERVATION_RETENTION_MS);
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((handler, ms) => {
      const timer = setInterval(handler, ms);
      /* Never hold the process open. A monitor that keeps a dying API alive turns a clean restart
         into a hang, and Railway's restart policy is a better recovery than this timer is. */
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.startedAt = this.now().getTime();
    this.handle = this.setTimer(() => { void this.check(); }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }

  /**
   * One sample. Never throws: this is called from a timer with no caller to catch it, and a
   * monitor that dies on the first transient database blip is a monitor that was never running
   * when it mattered.
   */
  async check(): Promise<IngestionHealth | null> {
    /* A read that outlives the interval must not stack up behind itself. Skipping is correct -
       the next tick asks the same question, and the freshness of the answer is what matters, not
       the count of attempts. */
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const freshness = await this.read();
      const at = this.now();
      this.checks += 1;
      this.lastCheckedAt = at.getTime();
      const health = ingestionHealth(freshness.newest_seen_at, this.thresholdMs, at);
      if (health.stalled) {
        this.currentlyStalled = true;
        const sample: StallSample = { at: at.getTime(), staleness_minutes: health.staleness_minutes };
        this.stalls.push(sample);
        if (this.worst === null || (sample.staleness_minutes ?? Infinity) >= (this.worst.staleness_minutes ?? Infinity)) {
          this.worst = sample;
        }
        this.logger.error(JSON.stringify({
          event: 'ingestion_stall_alert',
          alert: true,
          stalled: true,
          staleness_minutes: health.staleness_minutes,
          newest_seen_at: health.newest_seen_at,
          threshold_minutes: Math.floor(this.thresholdMs / 60_000),
          active_jobs: freshness.active_jobs,
          checked_at: at.toISOString(),
        }));
      } else {
        this.currentlyStalled = false;
        this.lastHealthyAt = at.getTime();
      }
      this.prune(at.getTime());
      return health;
    } catch (error) {
      /* A read failure is UNKNOWN, not healthy, and it must not refresh last_healthy_at. It is
         also not recorded as a stall: the board's freshness was never established either way, and
         inventing a stall out of a database blip is how an alarm earns its way into being
         ignored. A monitor that cannot read at all shows up as a last_healthy_at that stops
         advancing, which is the signal a reader should judge. */
      this.readFailures += 1;
      this.lastCheckedAt = this.now().getTime();
      this.logger.error(JSON.stringify({
        event: 'ingestion_stall_check_failed',
        alert: true,
        error: error instanceof Error ? error.message : String(error),
        checked_at: new Date(this.lastCheckedAt).toISOString(),
      }));
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    this.stalls = this.stalls.filter((sample) => sample.at >= cutoff);
    if (this.worst !== null && this.worst.at < cutoff) {
      this.worst = this.stalls.reduce<StallSample | null>((worst, sample) => (
        worst === null || (sample.staleness_minutes ?? Infinity) >= (worst.staleness_minutes ?? Infinity)
          ? sample
          : worst
      ), null);
    }
  }

  snapshot(): IngestionObservations {
    this.prune(this.now().getTime());
    return {
      monitor_running: this.running,
      monitor_interval_minutes: Math.floor(this.intervalMs / 60_000),
      retention_hours: this.retentionMs / (60 * 60_000),
      threshold_minutes: Math.floor(this.thresholdMs / 60_000),
      started_at: iso(this.startedAt),
      checks: this.checks,
      read_failures: this.readFailures,
      last_checked_at: iso(this.lastCheckedAt),
      last_healthy_at: iso(this.lastHealthyAt),
      currently_stalled: this.currentlyStalled,
      stall_observations: this.stalls.length,
      first_stall_observed_at: iso(this.stalls.length ? this.stalls[0].at : null),
      last_stall_observed_at: iso(this.stalls.length ? this.stalls[this.stalls.length - 1].at : null),
      worst_staleness_minutes: this.worst?.staleness_minutes ?? null,
      worst_observed_at: iso(this.worst?.at ?? null),
    };
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Read a millisecond setting from the environment, falling back rather than throwing.
 *
 * A misconfigured value must not stop the monitor from running at all - the default is always a
 * defensible setting, and a monitor that refused to start over a bad env var would reproduce
 * exactly the silence this exists to end. Floored at a minute so a typo cannot turn a health
 * check into a hot loop against the board.
 */
export function millisecondsFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(60_000, parsed);
}

let singleton: IngestionStallMonitor | null = null;

/** The process-wide monitor, created on first use so route reads and the boot path share one record. */
export function getIngestionStallMonitor(options?: IngestionStallMonitorOptions): IngestionStallMonitor {
  if (singleton === null) {
    if (!options) throw new Error('The ingestion stall monitor must be created with a reader before it can be read');
    singleton = new IngestionStallMonitor(options);
  }
  return singleton;
}

export function peekIngestionStallMonitor(): IngestionStallMonitor | null {
  return singleton;
}

/** Test-only reset. */
export function resetIngestionStallMonitor(): void {
  singleton?.stop();
  singleton = null;
}
