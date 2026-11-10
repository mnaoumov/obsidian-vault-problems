# Syntax checks

Some typing mistakes change what a note means without any visible error. `Vault Problems` reports them in the Problems view and underlines them in the editor.

## A quote that swallows properties

The [fixture note](<./Materials/04 Syntax checks/Note.md>) has a quoted `title` and a `tags` list. Drop the closing quote of its title:

```code-button
---
caption: Drop the closing quote
---
await require('/demoSetup.ts').setTitleQuote(app, false);
```

Manual equivalent: open the fixture note in Source mode and delete the `"` at the end of its `title` line.

The quoted value now runs into the next lines, so Obsidian no longer reads the note's properties, and its `tags` silently disappear. Open [03 Problems](<./03 Problems.md>): the problem names the line and how many property lines it swallowed. Choose **Quick fixes**, then **Close the quote at the end of line 2**. The notice offers **Undo**. Or restore the note with this button:

```code-button
---
caption: Restore the closing quote
---
await require('/demoSetup.ts').setTitleQuote(app, true);
```

## Other checks

1. Frontmatter that does not parse as YAML is reported at the line of the error, because Obsidian then ignores every property in it.
2. A link destination with no closing `)`, such as `[text](Note.md`, shows as plain text.
3. A code span with no closing backticks in its paragraph shows its backticks literally.
4. A `%%` comment opener with no closer hides the rest of the note.

The checks skip fenced code blocks and code spans, and choose **syntax** in **Problem kind** to list only these problems. They read the note's text, so they work in Reading view, Live Preview and Source mode alike.
