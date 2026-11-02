import { registerDemoVaultCoverageSuite } from '@mnaoumov/obsidian-dev-toolkit/demo-vault-coverage';
import { getRootFolder } from '@mnaoumov/typescript-dev-toolkit/root';
import process from 'node:process';

// Validates note structure, Markdown links and reachability without launching Obsidian.
// The plugin currently has no settings to reflect into the documentation.
registerDemoVaultCoverageSuite({ rootFolder: getRootFolder() ?? process.cwd() });
