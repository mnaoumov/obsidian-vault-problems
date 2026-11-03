# Automatic repairs

When an editor operation has exactly one repair, `Vault Problems` updates the links that followed the old target. Its notice names each endpoint change and offers **Undo** for all rewritten notes together.

## Edit a heading

1. Open [the target](<./Materials/02 Automatic repairs/Target.md>) in an editor.
2. Change the heading `Original` to `Revised`, keeping it on the same line.
3. Open [the source](<./Materials/02 Automatic repairs/Source.md>). Its heading link now points to `Revised`, with its label preserved.
4. Press **Undo** in the repair notice. The source link returns to `Original`.
5. Restore the target heading to `Original` to reset this exercise.

Undo restores the links changed by the repair. It refuses to overwrite a rewritten note if you have edited that note since the repair.

## Move a heading and a block

1. In [the target](<./Materials/02 Automatic repairs/Target.md>), select its entire contents and cut them.
2. Open [the destination](<./Materials/02 Automatic repairs/Destination.md>), place the cursor on a new line at the end, and paste.
3. Open [the source](<./Materials/02 Automatic repairs/Source.md>). Both the heading link and the block link now lead to the destination.
4. To reset the exercise, cut the pasted heading and paragraph from the destination and paste them back into the target. Their links follow the move back.

Use one selection and paste exactly what was cut. An intervening text edit or a different paste leaves the problem reported for review. A duplicate replacement heading or block id also prevents an automatic repair.

## Turn automatic repairs off

Open **Settings**, select **`Vault Problems`**, and turn off **Automatically repair links**. Repeat the heading edit: the link stays unchanged and a notice reports the new problem. Restore the original heading and turn the setting back on afterward. The setting survives a restart.

These exercises use editor operations, which supply the evidence for a repair. The buttons in [01 Live links](<./01 Live links.md>) change files through the vault API and demonstrate the reporting engine.
