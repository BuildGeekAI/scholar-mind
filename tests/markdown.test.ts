import { describe, expect, it } from 'vitest';
import { normaliseMath } from '../components/Markdown';

describe('normaliseMath', () => {
  it('converts backslash-paren to dollars', () => {
    expect(normaliseMath('The bound is \\(O(n^2)\\) here.')).toBe('The bound is $O(n^2)$ here.');
  });
  it('converts backslash-bracket to double dollars', () => {
    expect(normaliseMath('\\[ E = mc^2 \\]')).toBe('$$ E = mc^2 $$');
  });
  it('leaves existing dollar maths alone', () => {
    expect(normaliseMath('already $x+1$ fine')).toBe('already $x+1$ fine');
  });
  it('does not rewrite inside a code span', () => {
    const src = 'run `awk \\[0\\]` now';
    expect(normaliseMath(src)).toBe(src);
  });
  it('does not rewrite inside a fenced block', () => {
    const src = '```\nsed \\(x\\)\n```';
    expect(normaliseMath(src)).toBe(src);
  });
  it('restores code fences unchanged alongside converted maths', () => {
    const out = normaliseMath('see \\(a\\) and `code \\[b\\]` end');
    expect(out).toBe('see $a$ and `code \\[b\\]` end');
  });
  it('handles empty and undefined input', () => {
    expect(normaliseMath('')).toBe('');
    expect(normaliseMath(undefined as any)).toBe('');
  });
  it('handles multi-line display maths', () => {
    expect(normaliseMath('\\[\na+b\n\\]')).toBe('$$\na+b\n$$');
  });
});
