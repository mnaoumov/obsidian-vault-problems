import type { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';

import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';

/**
Shows one repair and keeps its Undo button available if the guarded operation fails.
*/
export function showRepairNotice(notices: PluginNoticeComponent, message: string, undo: () => Promise<void>): HTMLButtonElement {
  const fragment = createFragment();
  fragment.append(message);
  const button = fragment.createEl('button', { text: 'Undo' });
  button.addEventListener('click', () => {
    invokeAsyncSafely(() => undoRepair(button, undo, notices));
  });
  notices.showNotice(fragment);
  return button;
}

/**
Disables duplicate clicks while the entire multi-file undo is in progress.
*/
export async function undoRepair(button: HTMLButtonElement, undo: () => Promise<void>, notices: PluginNoticeComponent): Promise<void> {
  button.disabled = true;
  try {
    await undo();
    notices.showNotice('Link repair undone.');
  } catch (error) {
    button.disabled = false;
    throw error;
  }
}
