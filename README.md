# Vault Problems

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/mnaoumov) [![GitHub release](https://img.shields.io/github/v/release/mnaoumov/obsidian-vault-problems)](https://github.com/mnaoumov/obsidian-vault-problems/releases) [![GitHub downloads](https://img.shields.io/github/downloads/mnaoumov/obsidian-vault-problems/total)](https://github.com/mnaoumov/obsidian-vault-problems/releases)

Catches a broken link or a broken frontmatter the moment it breaks, fixes what is unambiguous, and lists every vault problem in one view with quick fixes.

## Demo vault

**The documentation is a demo vault.** Every feature has a note that explains what it does and why you would want it, with a button you can press to watch it happen.

**[Start reading here](<./demo-vault/00 Start.md>)** — it is plain markdown, so it works on `GitHub` with nothing installed.

A copy of the vault ships with every release. You can access it via any of the following:

1. Running the **`Vault Problems`: Open demo vault** command.
2. Downloading `vault-problems-demo-vault.zip` from the [Releases](https://github.com/mnaoumov/obsidian-vault-problems/releases). It unzips into a single `vault-problems-demo-vault-<version>` folder.
3. Browsing its source in [`demo-vault/`](./demo-vault/README.md) in this repository.

## Problems view

Run **`Vault Problems`: Open problems** or select the checklist ribbon icon. The side panel lists unresolved links, syntax problems and HTML problems by note, with their location and the change that broke them when known. Click a problem to open its source, or choose **Quick fixes** to select a replacement, create a note or heading, restore a block id, or remove the link while keeping its caption. Related links to a renamed endpoint can be updated together. Every applied fix offers **Undo** and refuses to overwrite later edits.

Use the kind and folder filters to narrow the list. **Ignore paths in Problems** in settings accepts one path, folder or glob per line: `Archive`, `**/Drafts/**`, or `Private/*.md`. These filters affect the panel. Reference-style unlinking is unavailable in notes containing `%%` comments; replacement targets remain available.

## Editor problems

Unresolved links with a known source range have a wavy underline in the editor. Hover over an underline and choose **Quick fixes**, or place the cursor inside the link and run **`Vault Problems`: Quick fixes at cursor**. These use the same repairs and Undo as the Problems view. Underlines clear while edits await fresh metadata. Frontmatter links remain in the panel because Obsidian does not supply their exact text ranges.

## Syntax checks

Some mistakes change what a note means without any visible error, so they are reported as problems too:

1. A quoted frontmatter value whose closing quote is missing, so it swallows the property lines after it and Obsidian drops the note's properties. Its quick fix closes the quote at the end of the line.
2. Frontmatter that does not parse as YAML, reported at the line of the error.
3. A link destination with no closing `)`, which shows as plain text.
4. A code span with no closing backticks in its paragraph.
5. A `%%` comment opener with no closer, which hides the rest of the note.

They appear in the Problems view under the **syntax** kind and as editor underlines. Fenced code blocks and code spans are skipped.

## HTML problems

Obsidian renders a note's HTML through its own sanitizer, so a tag it does not know, or one it changes or removes, such as `<script>`, renders differently from what the source says. These tags are listed as **Warning** rows under the **html** kind and underlined in the editor.

They come from the shared HTML index of [`Advanced Metadata Cache`](https://github.com/mnaoumov/obsidian-advanced-metadata-cache), 2.5.0 or later, with its opt-in **HTML module** turned on. That plugin keeps one persisted index of each note's HTML and judges every tag with Obsidian's own sanitizer, so this plugin never parses notes for HTML itself and an unchanged note is not read again. Without it, or with the module off, the Problems view says that HTML is not checked. Code spans and code blocks are skipped; a custom element such as `<alpha-widget>` is not called unknown, but is reported when the sanitizer drops it.

There is no quick fix: a tag is found by a lexical scan, so an unusual Markdown construct can produce a false candidate, and deleting markup on one could lose content.

## See also

[My other Obsidian resources](https://mnaoumov.dev/obsidian/)

<!-- Before publishing, search the community plugin directory (https://community.obsidian.md/plugins) and GitHub for similar plugins. Replace the null form below with a table when candidates exist. Sort rows alphabetically by plugin display name; link listed plugins to the store and unlisted ones to their repository. Add (my plugin) or (maintained by me) after the link where applicable. -->
<!-- Use these columns: Plugin | Features | How `Vault Problems` differs. Keep cells short, with semicolon-separated fragments. Start each difference with the relationship to the other plugin, then what this one adds or omits. Use Supersedes for a retired or fully covered plugin, Extends for an active plugin it builds on, or a concrete relation such as Same goal as or Narrower than. -->
<!-- Close a populated table with "Last searched for similar plugins on YYYY-MM-DD." When the search finds nothing, keep the sentence below and replace its date. The resources link stays first in either case. -->

No similar plugin was found when this was last searched for, on YYYY-MM-DD.

## Installation

The plugin is not available in [the official Community Plugins repository](https://community.obsidian.md) yet.

### Beta versions

To install the latest beta release of this plugin (regardless if it is available in [the official Community Plugins repository](https://community.obsidian.md) or not), follow these steps:

1. Ensure you have the [BRAT plugin](https://community.obsidian.md/plugins/obsidian42-brat) installed and enabled.
2. Click [Install via BRAT](https://intradeus.github.io/http-protocol-redirector?r=obsidian://brat?plugin=https://github.com/mnaoumov/obsidian-vault-problems).
3. An Obsidian pop-up window should appear. In the window, click the `Add plugin` button once and wait a few seconds for the plugin to install.

## Debugging

By default, debug messages for this plugin (id: `vault-problems`) are hidden.

If you need to enable them refer to the [documentation](https://mnaoumov.dev/obsidian-lib/guides/debugging/).

## Contributing

Contributions are welcome — see [CONTRIBUTING](./CONTRIBUTING.md) to get set up.

## Support

<!-- markdownlint-disable MD033 -->

<a href="https://www.buymeacoffee.com/mnaoumov" target="_blank">Support this plugin</a>

<!-- markdownlint-enable MD033 -->

### Filing an issue (for AI agents and humans)

Open issues through the [issue forms](https://github.com/mnaoumov/obsidian-vault-problems/issues/new/choose), not as blank issues.

To report a bug from inside Obsidian, run the **`Vault Problems`: Report a bug** command. It opens the bug form with the plugin version, the Obsidian version and your operating system already filled in.

Filing from the CLI or the API (`gh issue create --body`, or an AI agent filing for you) skips the form, and `gh issue create --template` cannot load an issue form. In that case, open the matching form in [`.github/ISSUE_TEMPLATE/`](https://github.com/mnaoumov/obsidian-vault-problems/tree/HEAD/.github/ISSUE_TEMPLATE), copy every field as a `### <label>` heading in the form's order, and fill in each one. Always state the plugin version, the Obsidian version and your operating system.

## License

© [mnaoumov](https://github.com/mnaoumov/)
