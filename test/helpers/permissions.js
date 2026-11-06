// Windows has no POSIX permission bits: fs.stat reports 0o666 (0o444 when the
// read-only attribute is set) whatever the file's ACL allows, so assertions
// about mode bits only hold on the other platforms.
export const POSIX_MODES = process.platform !== 'win32';
