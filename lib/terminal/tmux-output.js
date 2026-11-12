// xterm-256color's rmkx followed by clear is emitted only by tty_stop_tty.
// Stop before that clear so a detached client leaves its last screen intact.
const STOP = Buffer.from('\x1b[?1l\x1b>\x1b[H\x1b[2J');
const RESUME = Buffer.from('\x1b[?1049h');

export class TmuxOutput {
  pending = Buffer.alloc(0);
  trailer = Buffer.alloc(0);
  stopped = false;

  push(bytes) {
    let data = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    this.pending = Buffer.alloc(0);
    const visible = [];
    for (;;) {
      if (this.stopped) {
        const resumed = Buffer.concat([this.trailer, data]);
        const resume = resumed.indexOf(RESUME);
        if (resume < 0) { this.trailer = Buffer.from(resumed.subarray(-4096)); return Buffer.concat(visible); }
        data = resumed.subarray(resume);
        this.trailer = Buffer.alloc(0);
        this.stopped = false;
      }
      const stop = data.indexOf(STOP);
      if (stop >= 0) {
        visible.push(data.subarray(0, stop));
        data = data.subarray(stop);
        this.stopped = true;
        continue;
      }
      // Retain only a possible partial sentinel; ordinary output has no delay.
      for (let n = Math.min(data.length, STOP.length - 1); n > 0; n--) {
        if (data.subarray(-n).equals(STOP.subarray(0, n))) {
          this.pending = data.subarray(-n);
          data = data.subarray(0, -n);
          break;
        }
      }
      if (!visible.length) return data;
      visible.push(data);
      return Buffer.concat(visible);
    }
  }

  get reason() {
    const text = this.trailer.toString();
    if (/\[(?:server )?exited\]/.test(text)) return 'session_ended';
    if (/\[detached(?: |\])/.test(text)) return 'detached';
    return 'tmux_client_exit';
  }
}
