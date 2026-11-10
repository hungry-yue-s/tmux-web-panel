// The marks the panel leaves in the meta of CC Switch provider rows it writes,
// so it only ever changes or reports rows of its own. Rows written before the
// rename carry the tmux-web-panel marks (tmuxPanelEnterprise / tmuxPanelRelay);
// they still count as ours and get the new mark the next time they are written.

export const ENTERPRISE_OWNER = 'anymux-token-switch-v1';
export const RELAY_OWNER = 'token-switch-claude-relay-v1';
const LEGACY_ENTERPRISE_OWNER = 'tmux-panel-token-switch-v1';

export function ownsEnterprise(meta) {
  return meta?.anymuxEnterprise === ENTERPRISE_OWNER || meta?.tmuxPanelEnterprise === LEGACY_ENTERPRISE_OWNER;
}

export function ownsRelay(meta) {
  return meta?.anymuxRelay === RELAY_OWNER || meta?.tmuxPanelRelay === RELAY_OWNER;
}

/** The same rules as SQL conditions on a providers row's meta column. */
export const ENTERPRISE_OWNED_SQL = 'case when json_valid(meta) then ('
  + `json_extract(meta,'$.anymuxEnterprise')='${ENTERPRISE_OWNER}' `
  + `or json_extract(meta,'$.tmuxPanelEnterprise')='${LEGACY_ENTERPRISE_OWNER}') end`;
export const RELAY_OWNED_SQL = 'case when json_valid(meta) then ('
  + `json_extract(meta,'$.anymuxRelay')='${RELAY_OWNER}' `
  + `or json_extract(meta,'$.tmuxPanelRelay')='${RELAY_OWNER}') end`;
