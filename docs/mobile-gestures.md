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
- Horizontal swipes move to the adjacent pane with first/last wrap; they do not navigate back.

## Sessions and windows

Tap the title at the top of the screen to open the workspace menu.

- Tap **+** beside **Sessions** to create a session, including when the workspace is empty.
- Tap **+** beside a session to add a window to that session.
- Tap **⋯** beside a session or window to rename or close it. Closing requires confirmation;
  closing a session ends all of its windows.

These actions use the selected server and its current workspace capabilities.

## The key drawer

The bottom input deck keeps **Tools**, **Esc**, **Tab** and **Input** within
thumb reach without covering terminal output. **Input** opens the system keyboard
synchronously from the tap. **Tools** opens a scene-aware key drawer and dismisses
the keyboard; focusing the terminal input closes the drawer. Sending a key keeps
the drawer open so repeated navigation does not require reopening it. The drawer
replaces the global navigation while open and reserves visible terminal space above
it. Its header keeps scene selection, keyboard input and close controls separate
from the shortcut categories.

Phones in landscape keep this interface when a coarse pointer is detected up to
1023px wide and 560px high. Viewport resizing measures the terminal's actual top
edge and input deck rather than assuming a fixed header size. Leaving the terminal
releases the drawer, focus sentinel and pending fit timer. **Open in new window**
opens the complete phone workbench for the current server and pane; desktop
pop-out windows keep their dedicated terminal view.

Built-in scenes — **Terminal**, **Claude**, **Codex**, **Vim**, **Lazygit** — are
auto-detected from the command running in the active pane. Each scene ships a
fixture pad (arrows with long-press repeat, Esc, Tab, C-c, …) plus tabs of keys,
commands, slash-commands and templates.

The **Codex** scene follows the default shortcuts in the
[official OpenAI CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [CLI customization guide](https://learn.chatgpt.com/docs/cli-customization):

| Button | Action |
|--------|--------|
| Tab | Complete input; queue a follow-up while Codex is working |
| C-r | Search prompt history |
| C-o | Copy the latest completed Codex response on the host |
| C-g | Open the host's `VISUAL` or `EDITOR` prompt editor |
| Shift+← | Send a Shift-modified left arrow key to the TUI |
| C-l | Clear the terminal view while keeping the chat |
| Esc | Cancel; tap twice with an empty composer to edit the previous message |
| @ / ! / / | Insert a file mention, shell command prefix, or command-menu prefix |

The Slash tab includes `/model`, `/plan`, `/permissions`, `/status`, `/compact`,
`/diff`, `/review`, `/resume`, `/new`, `/copy`, `/mcp`, `/skills`, `/agent`, `/ps`
and `/keymap`. Command buttons send the command followed by Enter; prefix buttons
only insert text. If you have remapped Codex with `/keymap`, customize the drawer
to match. Tap the scene badge to switch to Codex manually when process detection
is unavailable. The terminal scene also includes a `codex` launch button.

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
