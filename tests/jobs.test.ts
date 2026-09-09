import { describe, expect, it } from 'vitest';
import { JobStatus, backoffSeconds, nextStatusAfterFailure } from '../server/jobs';

/**
 * The retry policy, as pure arithmetic.
 *
 * A queue's failure handling is the part nobody exercises by hand: it only runs
 * when something is already going wrong, so it has to be right by construction.
 * The two decisions worth pinning are how long to wait and when to stop waiting.
 */

describe('backoffSeconds', () => {
  it('starts short, so a transient blip costs seconds not minutes', () => {
    expect(backoffSeconds(1)).toBe(30);
  });

  it('doubles with each attempt', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(4)).toBe(240);
  });

  it('is capped, so a long-lived outage does not push a retry over the horizon', () => {
    expect(backoffSeconds(20)).toBe(15 * 60);
    expect(backoffSeconds(100)).toBe(15 * 60);
  });

  it('never returns a negative or zero delay, whatever it is handed', () => {
    // attempts is incremented before the failure is recorded, so 0 should not
    // occur — but a delay of 0 would mean a hot retry loop against a failing API.
    for (const attempts of [0, -1, -100]) {
      expect(backoffSeconds(attempts)).toBeGreaterThan(0);
    }
  });

  it('increases monotonically up to the cap', () => {
    let previous = 0;
    for (let attempts = 1; attempts <= 10; attempts += 1) {
      const delay = backoffSeconds(attempts);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it('is deterministic, so a schedule can be reasoned about and asserted', () => {
    expect(backoffSeconds(3)).toBe(backoffSeconds(3));
  });
});

describe('nextStatusAfterFailure', () => {
  it('requeues while attempts remain', () => {
    expect(nextStatusAfterFailure(1, 3)).toBe<JobStatus>('queued');
    expect(nextStatusAfterFailure(2, 3)).toBe<JobStatus>('queued');
  });

  it('dead-letters once the last attempt is spent', () => {
    expect(nextStatusAfterFailure(3, 3)).toBe<JobStatus>('dead');
  });

  it('dead-letters rather than looping if attempts somehow overshoot', () => {
    expect(nextStatusAfterFailure(9, 3)).toBe<JobStatus>('dead');
  });

  it('honours a max of one — a job that must not be retried is not retried', () => {
    expect(nextStatusAfterFailure(1, 1)).toBe<JobStatus>('dead');
  });

  it('gives exactly maxAttempts tries, no more and no fewer', () => {
    const max = 3;
    const outcomes = [1, 2, 3].map(attempts => nextStatusAfterFailure(attempts, max));
    expect(outcomes).toEqual(['queued', 'queued', 'dead']);
  });
});
