import { Message } from "./core/Node";
import { TimeEmitterNode } from "./TimeEmitterNode";
import { TimerProducerNode } from "./TimerProducerNode";

/**
 * TimeDualNode：双定时器/双节奏节点基类。
 *
 * @remarks
 * 该节点同时具备：
 * - 一个“内部定时器”（`internalTimer`）：用于高频采样/刷新内部状态（不直接对外 emit）
 * - 一个“对外 emit 定时器”（继承自 `TimeEmitterNode`）：用于较低频率地对外输出
 *
 * 适用于：
 * - 内部需要高频更新，但对外只需低频输出（如：聚合统计、缓存刷新 + 结果发布）
 */
export abstract class TimeDualNode<
  TIn = unknown,
  TOut = unknown,
> extends TimeEmitterNode<TIn, TOut> {
  private readonly internalTimer: InternalTimer<TIn>;

  /**
   * @param internalIntervalMs 内部定时器间隔（ms）
   * @param emitIntervalMs 对外 emit 定时器间隔（ms）
   * @param name 节点名称（用于日志/诊断）
   */
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

  /**
   * 内部定时器启动前的初始化（只会在 start 时执行一次）。
   */
  protected abstract onInternalTimerStart(): Promise<void>;

  /**
   * 内部定时器每次 tick 的处理逻辑（通常用于刷新内部状态）。
   */
  protected abstract onInternalTickProduce(): Promise<void>;

  protected abstract override onReceive(
    msg: Message<TIn>,
  ): Promise<void>;

  /**
   * 外部 emit 定时器启动时，同时启动 internalTimer。
   */
  protected override async onTimerStart(): Promise<void> {
    await this.internalTimer.start();
    await this.onDualStart();
  }

  /**
   * 外部 emit 定时器销毁时，同时销毁 internalTimer。
   */
  protected override async onTimerDispose(): Promise<void> {
    await this.internalTimer.dispose();
    await this.onDualDispose();
  }

  /**
   * 双定时器启动后的额外 hook（可选）。
   */
  protected async onDualStart(): Promise<void> {}

  /**
   * 双定时器销毁后的额外 hook（可选）。
   */
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
