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
| Video | Native player with playback controls, seeking and fullscreen for MP4/M4V, WebM, Ogg/OGV and MOV (codec support depends on the browser) |
| Others | Images, PDF, directory listings |

Markdown images support `![Description](images/example.png)` and image tags such
as `<img src="images/example.png" width="200" alt="Description">`. Tags retain
`src`, `alt`, `title` and integer `width`/`height` values from 1 to 4096 pixels.
Local image paths resolve relative to the document; HTTP(S) images also work.
Event handlers and other attributes are discarded.

Markdown video embeds use `![Demo](clips/demo.mp4)` or Obsidian syntax
`![[clips/demo.mp4]]`. Video links such as `[Demo](clips/demo.mp4)` also show an
inline player and keep the original link. Relative paths resolve from the
Markdown file; absolute paths and HTTP(S) video URLs also work. Links to local
videos open in the file preview. Other raw HTML remains disabled. Local videos stream
with byte-range support
without the text preview size limit. Closing or hiding a preview, or switching
dock tabs, pauses playback. Standalone HTML exports and shares keep a label for
local videos instead of embedding the video data or live authentication URL.

Previews auto-refresh when the file's mtime or size changes (1.5 s poll), and
links inside a preview stay inside the panel instead of escaping to a new tab.

## Sharing

The share action snapshots the rendered document into a self-contained HTML
page served at `/s/:id` with an unguessable id and a TTL you choose (up to 90
days) — useful for sending a rendered report to a colleague who has no access
to the machine.

Sensitive paths (`.ssh/`, `.gnupg/`, `.env`, `*.pem`, `id_rsa`, `/etc/shadow`, …)
are refused by the preview API.
