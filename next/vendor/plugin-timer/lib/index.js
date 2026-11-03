var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { Service } from "cordis";
var TimerService = class extends Service {
  static {
    __name(this, "TimerService");
  }
  constructor(ctx) {
    super(ctx, "timer");
    ctx.mixin("timer", ["timeout", "interval", "throttle", "debounce", "setTimeout", "setInterval"]);
  }
  /** @deprecated use `ctx.timeout()` instead */
  setTimeout(callback, delay) {
    return this.timeout(callback, delay);
  }
  /** @deprecated use `ctx.interval()` instead */
  setInterval(callback, delay) {
    return this.interval(callback, delay);
  }
  timeout(...args) {
    const callback = typeof args[0] === "function" ? args.shift() : void 0;
    const delay = args[0];
    if (callback) {
      const dispose = this.ctx.effect(() => {
        const timer = setTimeout(() => {
          dispose();
          callback();
        }, delay);
        return () => clearTimeout(timer);
      }, "ctx.timeout()");
      return dispose;
    } else {
      const { promise, resolve, reject } = Promise.withResolvers();
      const dispose = this.ctx.effect(() => {
        const timer = setTimeout(resolve, delay);
        return () => {
          clearTimeout(timer);
          reject(new Error("Context has been disposed"));
        };
      }, "ctx.timeout()");
      return promise.finally(dispose);
    }
  }
  interval(...args) {
    const callback = typeof args[0] === "function" ? args.shift() : void 0;
    const delay = args[0];
    if (callback) {
      return this.ctx.effect(() => {
        const timer = setInterval(callback, delay);
        return () => clearInterval(timer);
      }, "ctx.interval()");
    } else {
      let done;
      const nextTasks = [];
      const dispose = this.ctx.effect(() => {
        const timer = setInterval(() => {
          nextTasks.shift()?.resolve({ done: false, value: void 0 });
        }, delay);
        return () => {
          clearInterval(timer);
          if (done) return;
          done = { kind: "throw", reason: new Error("Context has been disposed") };
          for (const task of nextTasks.splice(0)) task.reject(done.reason);
        };
      }, "ctx.interval()");
      return {
        next: /* @__PURE__ */ __name(() => {
          if (!done) {
            const task = Promise.withResolvers();
            nextTasks.push(task);
            return task.promise;
          }
          if (done.kind === "return") return Promise.resolve({ done: true, value: done.value });
          return Promise.reject(done.reason);
        }, "next"),
        return: /* @__PURE__ */ __name((value) => {
          if (!done) done = { kind: "return", value };
          for (const task of nextTasks.splice(0)) task.resolve({ done: true, value });
          dispose();
          return Promise.resolve({ done: true, value });
        }, "return"),
        throw: /* @__PURE__ */ __name((reason) => {
          if (!done) done = { kind: "throw", reason };
          for (const task of nextTasks.splice(0)) task.reject(reason);
          dispose();
          return Promise.resolve({ done: true, value: void 0 });
        }, "throw"),
        [Symbol.asyncIterator]() {
          return this;
        }
      };
    }
  }
  _schedule(label, trigger) {
    let timer;
    let isDisposed = false;
    const dispose = this.ctx.effect(() => () => {
      isDisposed = true;
      clearTimeout(timer);
      timer = void 0;
    }, label);
    const wrapper = /* @__PURE__ */ __name((...args) => {
      if (isDisposed) return;
      clearTimeout(timer);
      timer = trigger(args);
    }, "wrapper");
    wrapper.dispose = dispose;
    return wrapper;
  }
  throttle(callback, delay, noTrailing) {
    let lastCall = -Infinity;
    const execute = /* @__PURE__ */ __name((...args) => {
      lastCall = Date.now();
      callback(...args);
    }, "execute");
    return this._schedule("ctx.throttle()", (args) => {
      const now = Date.now();
      const remaining = delay - now + lastCall;
      if (remaining <= 0) {
        execute(...args);
      } else if (!noTrailing) {
        return setTimeout(execute, remaining, ...args);
      }
    });
  }
  debounce(callback, delay) {
    return this._schedule("ctx.debounce()", (args) => {
      return setTimeout(callback, delay, ...args);
    });
  }
};
var index_default = TimerService;
export {
  TimerService,
  index_default as default
};
