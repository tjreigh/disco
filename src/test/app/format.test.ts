import { describe, expect, test } from 'vitest';
import { formatMultiplier } from '../../app/format.js';

describe('formatMultiplier', () => {
  test('renders a whole-number multiplier without decimals', () => {
    expect(formatMultiplier(2)).toBe('2');
    expect(formatMultiplier(1)).toBe('1');
  });

  test('renders a fractional multiplier to two decimal places', () => {
    expect(formatMultiplier(2.5)).toBe('2.50');
    expect(formatMultiplier(1.333333)).toBe('1.33');
  });
});
