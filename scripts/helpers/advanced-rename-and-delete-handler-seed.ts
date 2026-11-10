/**
 * @file
 *
 * Seeds `Advanced Rename and Delete Handler` into an integration vault, so the rename-handler suite drives the
 * published provider of the bulk-operation lifecycle notifications this plugin subscribes to.
 *
 * The seeded copy is the RELEASED build, pinned, for the reason `download-released-plugin.ts` gives: it is what
 * a user installs, and a test that follows a moving artifact stops being a statement about anything. Contract
 * `1.4.0`, which carries the notifications, first shipped in `3.5.0`.
 *
 * Its settings are seeded too, so it does nothing the suite did not ask for: its bulk members act whatever the
 * settings say, while an ordinary rename or deletion is left to Obsidian.
 */

import type { PopulateFilesParams } from 'obsidian-integration-testing';

import { downloadReleasedPlugin } from './download-released-plugin.ts';

/**
 * The provider's `manifest.id`, which is also the folder it is seeded into.
 */
export const ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID = 'advanced-rename-and-delete-handler';

/**
 * The release seeded.
 */
export const ADVANCED_RENAME_AND_DELETE_HANDLER_VERSION = '3.5.1';

const ADVANCED_RENAME_AND_DELETE_HANDLER_REPO = 'mnaoumov/obsidian-advanced-rename-and-delete-handler';

// Every vault the harness opens keeps its configuration in the default folder.
const VAULT_CONFIG_FOLDER = '.obsidian';

const SEEDED_SETTINGS = {
  shouldHandleDeletions: false,
  shouldHandleRenames: false,
  shouldRenameAttachmentFiles: false,
  shouldRenameAttachmentFolder: false
};

/**
 * Builds the files that install the provider into a vault, with its settings.
 *
 * @returns The populate map.
 */
export async function getAdvancedRenameAndDeleteHandlerPopulate(): Promise<PopulateFilesParams> {
  const files = await downloadReleasedPlugin({
    pluginId: ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID,
    repo: ADVANCED_RENAME_AND_DELETE_HANDLER_REPO,
    version: ADVANCED_RENAME_AND_DELETE_HANDLER_VERSION
  });

  const pluginFolder = `${VAULT_CONFIG_FOLDER}/plugins/${ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID}`;
  return {
    [`${pluginFolder}/data.json`]: JSON.stringify(SEEDED_SETTINGS),
    [`${pluginFolder}/main.js`]: files.mainJs,
    [`${pluginFolder}/manifest.json`]: files.manifestJson
  };
}
