# CHANGELOG

## 1.1.0

This release has 2 new features, 2 fixes and 6 documentation changes. 8 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- report enabled community plugins that are not installed
- report path-compatibility and misplaced-attachment problems

### Fixed

- **auto-repair:** repair a cut pasted through an Android keyboard clipboard chip
- **repair:** keep cut and paste evidence across unrelated file renames and deletes

### Documentation

- **readme:** say the plugin is in the community directory
- **readme:** show the Buy Me a Coffee button in the Support section
- demo vault note for the path and attachment checks
- **changelog:** regroup the raw release notes for readers
- **readme:** add mobile screenshots of the Problems view and quick fixes
- **readme:** link the changelog after the first release

## 1.0.0

This release has 9 new features and 4 documentation changes. 9 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **problems:** collapsible note groups, grouping by kind and paged rendering
- report HTML that Obsidian does not know or removes when it renders a note
- hold the link snapshot across rename handler bulk operations
- report frontmatter and Markdown syntax problems
- underline editor problems and offer quick fixes
- add live problems view and guarded quick fixes
- repair heading and block links with grouped undo
- analyze vault link problems as metadata changes
- scaffold `Vault Problems`

### Documentation

- **readme:** add store screenshots and the See also comparison
- make issue attachments optional and strongly encouraged
- link to the Obsidian resources page
- record the design in AGENTS.md
