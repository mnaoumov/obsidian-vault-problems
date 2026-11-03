import { registerDemoVaultCoverageSuite } from '@mnaoumov/obsidian-dev-toolkit/demo-vault-coverage';
import { getRootFolder } from '@mnaoumov/typescript-dev-toolkit/root';
import process from 'node:process';

// Validates note structure, Markdown links and reachability without launching Obsidian.
// The automatic-repair preference is demonstrated by the manual editor walkthrough.
registerDemoVaultCoverageSuite({ rootFolder: getRootFolder() ?? process.cwd() });
