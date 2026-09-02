# Mobile interaction guide

## Text selection

Long-press on the terminal to select and copy text on mobile devices.

| Gesture | Action |
|---------|--------|
| Long-press (500ms) | Select the word under your finger, vibration feedback |
| Hold + drag | Extend selection character-by-character (works across lines) |
| Release | Selection stays, editable preview panel appears at top |
| Edit preview | Tap the preview panel to modify text before copying |
| Copy button | Copies the (edited) preview content to clipboard |
| Tap terminal | Dismiss selection and preview |

The preview panel auto-scrolls to match drag direction: dragging down shows the
tail, dragging up shows the head.

## Scrolling and navigation

- Vertical drag on the terminal scrolls tmux copy-mode with inertial fling
  (decay matched to UIScrollView).
- Horizontal swipe from the left edge goes back to the window list, with a
  progress indicator.

## The key drawer

The floating button opens a scene-aware key drawer. It is mutually exclusive
with the soft keyboard: focusing the terminal input closes the drawer, and
opening the drawer does not steal focus from a running TUI.

Built-in scenes — **Terminal**, **Claude**, **Vim**, **Lazygit** — are
auto-detected from the command running in the active pane. Each scene ships a
fixture pad (arrows with long-press repeat, Esc, Tab, C-c, …) plus tabs of keys,
commands, slash-commands and templates.

You can add your own scenes: a name, an emoji, the process names that trigger
it, and custom keys written with `\x03`-style escapes. Buttons are ranked by
usage with a 14-day half-life, and the top 8 are mixed into the first tab. On
first run the drawer seeds itself from your real environment — top shell
history commands (secrets filtered), `~/.claude/commands` slash commands and
your Vim leader mappings.

## Uploads

The drawer's upload action sends a file from the phone to the panel host
(20 MB cap) and copies the resulting path to the clipboard, ready to paste into
any command.
