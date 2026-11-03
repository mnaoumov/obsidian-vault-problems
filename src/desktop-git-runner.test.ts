import {
  describe,
  expect,
  it
} from 'vitest';

import { createDesktopGitRunner } from './desktop-git-runner.ts';

describe('Desktop git history transport', () => {
  it('runs git in the requested checkout and returns its output', async () => {
    const run = createDesktopGitRunner(import.meta.dirname);
    expect(await run(['rev-parse', '--is-inside-work-tree'])).toBe('true\n');
  });
});
