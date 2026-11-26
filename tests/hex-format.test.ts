import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeHexInput } = require('../packages/serialagent-plus/media/hex-format.js') as {
  normalizeHexInput: (text: string) => string;
};

describe('HEX 发送回显格式化', () => {
  it('两字符一组、大写、空格分隔', () => {
    expect(normalizeHexInput('112233')).toBe('11 22 33');
    expect(normalizeHexInput('41 42 0d 0a')).toBe('41 42 0D 0A');
    expect(normalizeHexInput('  ab\tcd\n')).toBe('AB CD');
  });

  it('奇数位保留末尾单字符', () => {
    expect(normalizeHexInput('11223')).toBe('11 22 3');
  });

  it('空输入返回空串', () => {
    expect(normalizeHexInput('')).toBe('');
    expect(normalizeHexInput('   ')).toBe('');
    expect(normalizeHexInput(undefined as unknown as string)).toBe('');
  });
});
