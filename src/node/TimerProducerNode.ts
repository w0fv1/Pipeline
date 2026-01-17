import { ProducerNode } from "./core/Node";

export abstract class TimerProducerNode<TOut = unknown>
    extends ProducerNode<TOut> {
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

        if (!this.started || this.starting) return;

        if (this.disposed || this.abortSignal.aborted) return;

        this.restartTimer();
    }

    protected onTimerError?(error: unknown): void | Promise<void>;
    protected abstract onTimerStart(): Promise<void>;
    protected abstract onTickProduce(): Promise<void>;

    protected async onStart(): Promise<void> {
        await this.onTimerStart();

        if (this.disposed || this.abortSignal.aborted) return;

        this.restartTimer();
    }

    private async tick(): Promise<void> {
        try {
            if (this.abortSignal.aborted || this.disposed) return;
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

    protected async onTimerDispose(): Promise<void> {}

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
