# Tmux Panel workspace UI

## Product and constraints
A daily-use tmux workstation, shared web interface inside Swift WKWebView and browsers. Chinese interface. Terminal is the primary content; status, Agent usage, connections, settings and file preview are secondary work modes. Preserve all existing route/action contracts. Native titlebar keeps real traffic lights with80px safe clearance and dragging. Native transparency0–50 and glass intensity0–100 stay independent and saved; browsers stay opaque. All work and screenshots use the isolated17681 environment with synthetic sessions. Never upload live terminal/private files.

## Current baseline
Use actual context and reference screenshot for reproduction, including its limitations. Current Tokyo Night colors: base #1a1b26; rail #16161e; surface #24283b; hover #292e42; line #3b4261; subtle line #2f3450; primary #c0caf5; secondary #a9b1d6; muted #565f89; accent #7aa2f7; green #9ece6a; red #f7768e; yellow #e0af68. System sans, bundled Maple-based Tmux Panel Mono terminal. Browser header56 and framed; Swift44 integrated. Sidebar248, collapsed152, status304.

## Proposed direction: quiet native workspace
Keep theme identity; introduce semantic chrome tokens rather than replacing terminal palettes. Tokyo example: workspace #1a1b26, rail #16161e, raised #24283b, hover #292e42, text #e2e8ff, secondary #a9b1d6, readable-muted #919bbd, accent #7aa2f7, line #3b4261. Light counterpart: workspace #ffffff, rail #f6f8fa, raised #ffffff, hover #eef2f6, text #24292f, secondary #57606a, readable-muted #57606a, accent #0969da, line #d0d7de. These are examples mapped from selected theme, not new theme ids.
System sans13px chrome,12px secondary,14px prominent labels,20px page headings; preserve terminal font/size preferences. No new remote fonts or libraries.4px rhythm,32px desktop controls,44px touch targets,44px native/browser terminal bar; stable48px preview tab+toolbar bands. Radius6 controls,10 popovers,12 dialogs, no nested rounded frames around the workspace. Motion120ms hover,180ms overlay, disabled under reduced motion.

## Layout and interactions
Navigation: readable13px window names and12px metadata, flat sessions with subtle nesting lines instead of boxed groups. Selected window accent rail plus background; destructive controls in a visible overflow menu, keyboard accessible. Keep248px expanded rail; compact rail retains readable window names and native control clearance. Do not turn152px compact tree into an unexplained icon-only rail. Terminal heading left aligned, structured server/session/window breadcrumb. Refresh then grouped layout, font, split, files; less frequent actions overflow. One divider per major region.
Preview: dock tabs and terminal header align; file title truncates with tooltip; code/markdown readable at65–90ch with table horizontal scrolling within preview. Preserve modal-first then explicit dock, per-tab state and320–820 dock width; hide preserves tabs, close destroys only requested tab.
Status: one machine header, one primary action. Avoid repeated probe/open-terminal buttons in both header and hero. Metric typography and data availability consistent; never fabricate zero for unknown. Agent account/quota/error hierarchy separated, provider details disclosed when needed.
Settings: theme grid compact; native appearance has live preview, both sliders grouped in one surface with visible numeric outputs. Data-source settings separate. Native-only controls absent in browser.
Mobile: workspace trigger+pane strip,44px controls and scrollable sheet, respect keyboard/drawer mutual exclusion and safe areas. No whole-page horizontal overflow. Preview modal fills small screen.
Accessibility: normal text4.5:1, icon boundaries3:1, visible focus, all icon actions named, selected/expanded states semantic; keyboard and single-pointer resizing alternatives. Reduced motion. Do not claim compliance until measured across all themes.

## Design critique
Reject generated landing-page recommendations: no hero, CTA campaign, gradient wash, statistic card wall or decorative illustration. Adopt only flat utility styling, contrast, hierarchy and progressive disclosure. Main distinguishing element is the continuous terminal+preview workspace, with quiet chrome and precise navigation.
