import { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  showRepairNotice,
  undoRepair
} from './repair-notice.ts';

describe('Repair notice', () => {
  it('names the repair and undoes the whole operation through its button', async () => {
    const notices = new PluginNoticeComponent({ app: App.createConfigured__().asOriginalType__(), pluginName: 'Vault Problems' });
    const show = vi.spyOn(notices, 'showNotice');
    const undo = vi.fn<() => Promise<void>>().mockResolvedValue();
    const button = showRepairNotice(notices, 'Original → Replacement', undo);
    expect(button.parentElement?.textContent).toContain('Original → Replacement');
    button.click();
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledWith('Link repair undone.');
    });
    expect(undo).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    notices.unload();
  });

  it('keeps Undo available when restoring would overwrite later edits', async () => {
    const notices = new PluginNoticeComponent({ app: App.createConfigured__().asOriginalType__(), pluginName: 'Vault Problems' });
    const button = createEl('button');
    await expect(undoRepair(button, () => Promise.reject(new Error('Later edit')), notices)).rejects.toThrow('Later edit');
    expect(button.disabled).toBe(false);
    notices.unload();
  });
});
