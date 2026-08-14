import { describe, expect, test } from 'vitest';
import { formatDuration, formatRate } from '../../ui/format.js';

describe('formatDuration', () => {
  test('rounds under a minute to <1m', () => {
    expect(formatDuration(59_999)).toBe('<1m');
    expect(formatDuration(0)).toBe('<1m');
  });

  test('shows whole minutes under an hour', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(37 * 60_000)).toBe('37m');
  });

  test('shows whole hours with no remainder minutes as just hours', () => {
    expect(formatDuration(2 * 60 * 60_000)).toBe('2h');
  });

  test('shows hours and minutes together', () => {
    expect(formatDuration(2 * 60 * 60_000 + 14 * 60_000)).toBe('2h 14m');
  });
});

describe('formatRate', () => {
  test('renders an em dash when too little play time has elapsed to estimate a rate', () => {
    expect(formatRate(10, 0)).toBe('—');
  });

  test('renders a per-minute rate rounded to one decimal', () => {
    expect(formatRate(30, 60_000)).toBe('30');
    expect(formatRate(1, 40_000)).toBe('1.5');
  });
});
