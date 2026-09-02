# File preview & link detection

## Click anything that looks like a path

Every path and URL in terminal output is clickable: `http(s)://`, `www.`,
`localhost:port`, `file://`, absolute paths, `~/…`, relative paths, bare
filenames, CJK filenames, label-prefixed paths (`at src/foo.ts:128`) and
`:line` references. Soft-wrapped lines are merged before detection, and when a
token could be either a web URL or a file you get a chooser.

`Ctrl/Cmd+Shift+O` opens the path currently in the tmux paste buffer — handy
when a tool prints a path you already yanked.

## Modal first, dock on demand

Files always open in a modal. The dock action in the preview header moves the
current preview into the right-side workspace. Each different path is kept as
its own tab; an existing path is activated instead of duplicated.

The dock can be hidden without closing its tabs — a compact restore button at
the right edge expands it again. Drag the divider on the dock's left edge to
resize between 320 px and 70% of the available width; the chosen width is
restored on expand. Closing the last tab removes the dock. Dock state is scoped
per machine and per terminal window.

## Renderers

| Type | What you get |
|------|--------------|
| Source code | Syntax highlighting with `:line` jump |
| Markdown | markdown-it + KaTeX, plus Obsidian flavor: `[[wikilinks]]` (file and heading targets, clickable), `![[embeds]]`, `> [!note]` callouts, YAML frontmatter property cards |
| Mermaid | Theme-synced diagrams, scrollable embeds, zoom dialog, PNG export and copy-to-clipboard |
| Archives | Entry tree for zip/jar/apk/epub/docx/pptx and tar/tgz/bz2/xz/zst |
| Tables | CSV and XLSX rendered as tables |
| Others | Images, PDF, directory listings |

Previews auto-refresh when the file's mtime or size changes (1.5 s poll), and
links inside a preview stay inside the panel instead of escaping to a new tab.

## Sharing

The share action snapshots the rendered document into a self-contained HTML
page served at `/s/:id` with an unguessable id and a TTL you choose (up to 90
days) — useful for sending a rendered report to a colleague who has no access
to the machine.

Sensitive paths (`.ssh/`, `.gnupg/`, `.env`, `*.pem`, `id_rsa`, `/etc/shadow`, …)
are refused by the preview API.
