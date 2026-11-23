import { describe, it, expect } from 'vitest';
import { calculateBackoffDelay, DEFAULT_OUTBOX_RETRY_CONFIG } from './outbox.js';

describe('Bounded Outbox Relay Backoff (G3-C / PD-AT-08)', () => {
  const zeroJitter = () => 0;
  const fixedJitter = () => 250;

  it('calculates exponential backoff delay with ceiling', () => {
    // Retry 0: base 1000ms
    expect(calculateBackoffDelay(0, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 1000,
      isExhausted: false,
    });

    // Retry 1: 2000ms
    expect(calculateBackoffDelay(1, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 2000,
      isExhausted: false,
    });

    // Retry 2: 4000ms
    expect(calculateBackoffDelay(2, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 4000,
      isExhausted: false,
    });

    // Retry 3: 8000ms
    expect(calculateBackoffDelay(3, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 8000,
      isExhausted: false,
    });

    // Retry 4: 16000ms
    expect(calculateBackoffDelay(4, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 16000,
      isExhausted: false,
    });

    // Max cap: 30000ms with fixed jitter 250ms
    const customConfig = { ...DEFAULT_OUTBOX_RETRY_CONFIG, maxRetries: 10 };
    expect(calculateBackoffDelay(5, customConfig, fixedJitter)).toEqual({
      delayMs: 30250, // 30000 capped + 250 jitter
      isExhausted: false,
    });
  });

  it('enforces retry ceiling and transitions to exhausted', () => {
    // Retry count reaches or exceeds maxRetries (5)
    expect(calculateBackoffDelay(5, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 0,
      isExhausted: true,
    });

    expect(calculateBackoffDelay(6, DEFAULT_OUTBOX_RETRY_CONFIG, zeroJitter)).toEqual({
      delayMs: 0,
      isExhausted: true,
    });
  });

  it('adds bounded jitter within configured range', () => {
    const jitterFn = (max: number) => max - 1; // 999ms
    const result = calculateBackoffDelay(0, DEFAULT_OUTBOX_RETRY_CONFIG, jitterFn);
    expect(result.delayMs).toBe(1999);
    expect(result.isExhausted).toBe(false);
  });
});
