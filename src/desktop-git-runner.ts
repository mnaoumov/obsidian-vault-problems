import type { GitRunner } from '@mnaoumov/obsidian-lib/git-rename-history';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT_IN_BYTES = 268_435_456;
const GIT_TIMEOUT_IN_MILLISECONDS = 30_000;

/**
Loaded only on desktop when the user asks for candidates.
*/
export function createDesktopGitRunner(cwd: string): GitRunner {
  return async (arguments_) => {
    const { stdout } = await execFileAsync('git', [...arguments_], { cwd, encoding: 'utf-8', maxBuffer: GIT_OUTPUT_LIMIT_IN_BYTES, timeout: GIT_TIMEOUT_IN_MILLISECONDS, windowsHide: true });
    return stdout;
  };
}
