import { Node } from "./core/Node";

/**
 * TimeEmitterNode:
 * - 接受外部输入 (onReceive)
 * - 定时触发处理逻辑 (onTickProduce)
 * - 支持并发执行：每次定时器触发都会执行 onTickProduce，不等待上一次执行完成
 */
export abstract class TimeEmitterNode<TIn = unknown, TOut = unknown>
    extends Node<TIn, TOut> {
    private timer: NodeJS.Timeout | null = null;
    private intervalMs: number;

    public constructor(
        intervalMs: number,
        name?: string,
    ) {
        super(name);
        this.intervalMs = normalizeIntervalMs(intervalMs);
    }

    protected getTimerIntervalMs(): number {
        return this.intervalMs;
    }

    public updateIntervalMs(intervalMs: number): void {
        this.intervalMs = normalizeIntervalMs(intervalMs);

        // build-time / starting: interval will be picked up when onStart() creates the timer
        if (!this.started || this.starting) return;

        // disposed/aborted: nothing to restart
        if (this.disposed || this.abortSignal.aborted) return;

        this.restartTimer();
    }

    protected abstract onTickProduce(): Promise<void>;
    protected abstract onTimerStart(): Promise<void>;
    protected onTimerError?(error: unknown): void | Promise<void>;
    protected async onTimerDispose(): Promise<void> {}

    protected override async onStart(): Promise<void> {
        await this.onTimerStart();

        if (this.disposed || this.abortSignal.aborted) return;

        this.restartTimer();
    }

    private async tick(): Promise<void> {
        try {
            if (this.disposed || this.abortSignal.aborted) return;
            await this.onTickProduce();
        } catch (e) {
            try {
                await this.onTimerError?.(e);
            } catch (e2) {
                console.error(
                    `[${this.name}] onTimerError failed`,
                    {
                        nodeId: this.id,
                        intervalMs: this.getTimerIntervalMs(),
                        time: Date.now(),
                        error: e2,
                    },
                );
            }
        }
    }

    protected override async onDispose(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.onTimerDispose();
    }

    private restartTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        const intervalMs = this.getTimerIntervalMs();
        this.timer = setInterval(() => {
            if (this.disposed || this.abortSignal.aborted) return;
            void this.tick();
        }, intervalMs);
    }
}

function normalizeIntervalMs(intervalMs: number): number {
    if (!Number.isFinite(intervalMs)) return 1_000;
    return Math.max(1, Math.floor(intervalMs));
}
