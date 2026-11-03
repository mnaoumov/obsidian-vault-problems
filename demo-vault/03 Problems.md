# Problems

`Vault Problems` keeps a live list of unresolved links. First press **Change the linked heading** in [01 Live links](<./01 Live links.md>), then open the panel:

```code-button
---
caption: Open problems
---
app.commands.executeCommandById('vault-problems:open-problems');
```

Manual equivalent: run **`Vault Problems`: Open problems** from the command palette, or select its checklist ribbon icon.

The panel groups problems by note and shows their location, severity and cause. Click the broken heading link to select its source. Choose **Quick fixes** and select the replacement heading. The notice offers **Undo** for that repair. You can also create the missing heading, or remove the link while keeping its caption.

In the editor, the same broken link has a wavy underline. Hover over it and press **Quick fixes**, or place the cursor inside it and run **`Vault Problems`: Quick fixes at cursor**. Both offer the panel's repairs and Undo. Underlines clear while your edits await fresh metadata. Frontmatter links appear in the panel because their metadata has no exact text range.

For a missing block id, quick fixes list paragraphs on which to restore it. Choose the paragraph you meant. For a missing note, candidates explain their evidence; the plugin never silently selects among them. When several links share a renamed endpoint, a grouped action updates them together.

Use **Problem kind** and **Folder** to narrow the list. In settings, **Ignore paths in Problems** accepts one path, folder or glob per line, such as `Archive` or `**/Drafts/**`. Ignoring hides panel rows; it does not change notes or disable automatic repairs.

Reference-style unlinking keeps the captions at use sites and removes their definition. In notes containing `%%` comments it is conservatively refused; choose a replacement target instead. Undo refuses to replace a note edited after a fix.
