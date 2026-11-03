import { Context, Service } from 'cordis';
declare module 'cordis' {
    interface Context extends Pick<TimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
        timer: TimerService;
    }
}
type Scheduled<F extends (...args: any[]) => any> = ((...args: Parameters<F>) => void) & {
    dispose: () => void;
};
export declare class TimerService extends Service {
    constructor(ctx: Context);
    /** @deprecated use `ctx.timeout()` instead */
    setTimeout(callback: () => void, delay: number): () => void;
    /** @deprecated use `ctx.interval()` instead */
    setInterval(callback: () => void, delay: number): () => void;
    timeout(callback: () => void, delay: number): () => void;
    timeout(delay: number): Promise<void>;
    interval(callback: () => void, delay: number): () => void;
    interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>;
    private _schedule;
    throttle<F extends (...args: any[]) => any>(callback: F, delay: number, noTrailing?: boolean): Scheduled<F>;
    debounce<F extends (...args: any[]) => any>(callback: F, delay: number): Scheduled<F>;
}
export default TimerService;
