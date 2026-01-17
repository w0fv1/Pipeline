import { Message } from "./core/Node";
import { TimeEmitterNode } from "./TimeEmitterNode";
import { TimerProducerNode } from "./TimerProducerNode";

export abstract class TimeDualNode<
  TIn = unknown,
  TOut = unknown,
> extends TimeEmitterNode<TIn, TOut> {
  private readonly internalTimer: InternalTimer<TIn>;

  constructor(
    internalIntervalMs: number,
    emitIntervalMs: number,
    name?: string,
  ) {
    super(emitIntervalMs, name);

    this.internalTimer = new InternalTimer(
      internalIntervalMs,
      this.onInternalTimerStart.bind(this),
      this.onInternalTickProduce.bind(this),
    );
  }
  protected abstract onInternalTimerStart(): Promise<void>;

  protected abstract onInternalTickProduce(): Promise<void>;

  protected abstract override onReceive(
    msg: Message<TIn>,
  ): Promise<void>;

  protected override async onTimerStart(): Promise<void> {
    await this.internalTimer.start();
    await this.onDualStart();
  }

  protected override async onTimerDispose(): Promise<void> {
    await this.internalTimer.dispose();
    await this.onDualDispose();
  }

  protected async onDualStart(): Promise<void> {}
  protected async onDualDispose(): Promise<void> {}
}

class InternalTimer<T> extends TimerProducerNode<T> {
  constructor(
    intervalMs: number,
    private readonly onInternalTimerStart: () => Promise<void>,
    private readonly onInternalTickProduce: () => Promise<void>,
    name?: string,
  ) {
    super(intervalMs, name);
  }

  protected async onTimerStart(): Promise<void> {
    await this.onInternalTimerStart();
  }

  protected async onTickProduce(): Promise<void> {
    await this.onInternalTickProduce();
  }

  protected async onTimerDispose(): Promise<void> {}
}
