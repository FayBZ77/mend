# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON — and mend reads each one the way its specification (SPEC.md) says, then changes every file
or nothing.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- All four formats, with line matching at three tiers (exact, trailing-whitespace-insensitive, and
  indentation-insensitive with re-indentation of the replacement at the loosest tier).
- Unified hunks are placed by content, nearest the line number the patch claims, so wrong line numbers in a
  model's diff do not matter.
- All-or-nothing: when any edit fails, every failure is reported and no file is written.
- Node 22, standard library alone.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty.
