# Path and attachment checks

Two kinds of problem do not break a link today, but break the vault somewhere else: a name that another device cannot store or link to, and an attachment kept outside the folder its note is set to use. `Vault Problems` lists them in [03 Problems](<./03 Problems.md>) under the **path** and **misplaced-attachment** kinds.

## A name a link cannot reach

Obsidian refuses a `#`, `^`, `[`, `]` or `|` in a link target, so a note named with one of them can be created, but no link can reach it. Create such a note in the [materials folder](<./Materials/06 Path and attachment checks/Note.md>):

```code-button
---
caption: Create a note named Draft #1
---
await require('/demoSetup.ts').createIncompatibleName(app);
```

Manual equivalent: create a note in `Materials/06 Path and attachment checks` and name it `Draft #1`, accepting Obsidian's warning about the name.

Open the Problems view and choose **path** in **Problem kind**. The row names the character. Choose **Quick fixes**, then **Rename to Draft -1.md**: the note is renamed with the **Forbidden character replacement** in place of `#`, and the notice offers **Undo**.

The same check reports names that a platform you sync to cannot store: reserved names such as `CON`, a trailing dot or space, a forbidden character such as `:` or `?`, and names or paths that are too long. Only the platform you are running on is checked by default. Turn the others on in the plugin settings, and set **Longest vault folder path** to the longest folder this vault lives in on any device. Remove the note when you are done:

```code-button
---
caption: Remove the Draft note
---
await require('/demoSetup.ts').removeIncompatibleName(app);
```

## An attachment outside its folder

This vault keeps attachments in `_assets/attachments`. Put an image beside the [fixture note](<./Materials/06 Path and attachment checks/Note.md>) and embed it there instead:

```code-button
---
caption: Create a misplaced attachment
---
await require('/demoSetup.ts').createMisplacedAttachment(app);
```

Manual equivalent: copy any image into `Materials/06 Path and attachment checks` with your file manager, then embed it in the fixture note with `![[...]]`.

The embed still works, so the row is a **Warning** of the **misplaced-attachment** kind. Choose **Quick fixes**, then **Move Diagram.svg to _assets/attachments**: Obsidian updates the embed, and the notice offers **Undo**, which moves it back. The **Misplaced attachments** setting reports every such link, only an attachment that no linking note holds in its own folder, or none. Remove the image and its embed when you are done:

```code-button
---
caption: Remove the misplaced attachment
---
await require('/demoSetup.ts').removeMisplacedAttachment(app);
```
