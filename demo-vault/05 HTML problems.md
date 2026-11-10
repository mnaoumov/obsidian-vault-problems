# HTML problems

Obsidian renders the HTML in a note through its own sanitizer. A tag it does not know, or one it changes or removes, such as `<script>`, silently renders differently from what the source says. `Vault Problems` lists these tags as **Warning** rows of the **html** kind in [03 Problems](<./03 Problems.md>), and underlines them in the editor.

## What it needs

The tags come from the shared HTML index of the [`Advanced Metadata Cache`](https://github.com/mnaoumov/obsidian-advanced-metadata-cache) plugin, 2.5.0 or later. Install it and turn on its opt-in **HTML module**. It keeps one persisted index of each note's HTML and judges each tag with Obsidian's own sanitizer, so `Vault Problems` never parses your notes for HTML itself, and a note that has not changed is not read again.

Without that plugin, or with its HTML module off, the Problems view says that HTML is not checked, rather than showing a vault that only looks clean.

<!-- obsidian-dev-toolkit-disable-next-line demo-vault-validation/try-it-code-button -- the rows come from another plugin this vault does not ship, so the steps are reading, not a scripted edit -->
## Try it

Open the [fixture note](<./Materials/05 HTML problems/Note.md>), then open the Problems view and choose **html** in **Problem kind**:

1. `<nonExistingTag>` is an unknown tag.
2. `<script>` is removed by the sanitizer.
3. `<alpha-widget>` is a custom element. It is not called unknown just because no script registered it, but the sanitizer drops it, so that is reported.
4. `<b>` is ordinary HTML and is not reported, and the code span is not HTML at all.

Edit the note, for example delete the `<script>` line, and its row disappears once Obsidian has read the change.

## Why there is no quick fix

An HTML tag is found by a lexical scan, so an unusual Markdown construct can make a false candidate. Deleting markup on such a candidate could lose content, so these problems are reported for you to review, and nothing is changed for you.
