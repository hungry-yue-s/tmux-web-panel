// The shell's slots (plugins/ui/client/js/slots.js) and the plugins' real
// registrations into them, for tests that build the shell in jsdom. The
// components the registrations call (PerfPanel, AgentHub, …) stay stubbed by
// each test, looked up when a section renders or mounts.

import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

export const SLOTS_SRC = read('plugins/ui/client/js/slots.js');

export const SECTION_SRCS = [
  'plugins/metrics/client/js/perf-section.js',
  'plugins/agent-hub/client/js/agent-section.js',
  'plugins/session-protection/client/js/session-section.js',
  // The management centre (ui) and the panels plugins put in it.
  'plugins/ui/client/js/management-page.js',
  'plugins/managed-resources/client/js/managed-resources.js',
  'plugins/panel-plugins/client/js/panel-plugins.js',
].map(read);

/** Evaluates the slots, then (unless `sections` is false) every plugin's registration, in `win`. */
export function loadSlots(win, { sections = true } = {}) {
  win.eval(SLOTS_SRC);
  if (sections) for (const source of SECTION_SRCS) win.eval(source);
}
