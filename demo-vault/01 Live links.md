# Live links

`Vault Problems` tracks links as you edit. A link that already failed when the plugin loaded is a standing problem. A link that resolved and then breaks is a new break, with the operation that caused it. Only new breaks show a notice.

## Try a heading edit

The [source note](<./Materials/01 Live links/Source.md>) links to the original heading of the [target note](<./Materials/01 Live links/Target.md>). Change that heading with this button:

```code-button
---
caption: Change the linked heading
---
await require('/demoSetup.ts').setHeading(app, 'Replacement');
```

The plugin shows a notice naming the heading link that just broke. Manual equivalent: open the target note and change its heading from `Original` to `Replacement`.

```code-button
---
caption: Restore the linked heading
---
await require('/demoSetup.ts').setHeading(app, 'Original');
```

The problem disappears when metadata updates. Manual equivalent: change the target heading back to `Original`.

## Current surface

Analysis starts automatically when the vault is ready. Open [03 Problems](<./03 Problems.md>) to inspect the live list and try quick fixes. [02 Automatic repairs](<./02 Automatic repairs.md>) demonstrates editor repairs and their setting. [04 Syntax checks](<./04 Syntax checks.md>) demonstrates problems in the note text itself.
