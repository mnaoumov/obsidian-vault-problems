/**
 * @file
 *
 * The global setup of `integration-tests:rename-handler`: the harness's own, plus the released `Advanced Rename and
 * Delete Handler`, whose bulk-operation lifecycle notifications the link engine subscribes to. It is a project of
 * its own so the other suites keep a vault where no other plugin acts on a rename.
 */

import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';

import {
  ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID,
  getAdvancedRenameAndDeleteHandlerPopulate
} from './helpers/advanced-rename-and-delete-handler-seed.ts';

export const { setup, teardown } = createSetup({
  enableCommunityPlugins: [ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID],
  populate: getAdvancedRenameAndDeleteHandlerPopulate
});
