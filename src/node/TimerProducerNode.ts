import { ProducerNode } from "./core/Node";

/**
 * TimerProducerNode：定时触发的 producer 基类。
 *
 * @remarks
 * - `onTimerStart()`：启动前的初始化（只会在 `start()` 时执行一次）
 * - `onTickProduce()`：每次 tick 时产出数据（内部通常调用 `dispatch()`）
 * - `updateIntervalMs()`：运行中动态调整 interval
 */
export abstract class TimerProducerNode<TOut = unknown>
    extends ProducerNode<TOut> {
    private timer: NodeJS.Timeout | null = null;
    private intervalMs: number;

    /**
     * @param intervalMs 定时器间隔（ms）
     * @param name 节点名称（用于日志/诊断）
     */
    public constructor(
        intervalMs: number,
        name?: string,
    ) {
        super(name);
        this.intervalMs = normalizeIntervalMs(intervalMs);
    }

    /**
     * 当前定时器间隔（ms）。
     *
     * @remarks
     * 子类可以 override 来实现更复杂的动态间隔策略。
     */
    protected getTimerIntervalMs(): number {
        return this.intervalMs;
    }

    /**
     * 动态更新 interval（运行时生效）。
     *
     * @remarks
     * - build-time / starting 阶段调用只会更新字段，定时器会在 onStart 时按新值创建
     * - disposed/aborted 时调用无效
     */
    public updateIntervalMs(intervalMs: number): void {
        this.intervalMs = normalizeIntervalMs(intervalMs);

        if (!this.started || this.starting) return;

        if (this.disposed || this.abortSignal.aborted) return;

        this.restartTimer();
    }

    protected onTimerError?(error: unknown): void | Promise<void>;
    protected abstract onTimerStart(): Promise<void>;
    protected abstract onTickProduce(): Promise<void>;

    /**
     * 启动：先执行 `onTimerStart()`，再创建定时器。
     */
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

    /**
     * 定时器销毁时的 hook（可选）。
     */
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
