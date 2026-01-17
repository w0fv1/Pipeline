import { randomUUID } from "crypto";

/**
 * Pipeline 内部传递的消息结构。
 *
 * @remarks
 * - `time` 默认是产生消息时的 `Date.now()`，也可以通过 `dispatchAt()` 使用外部事件时间。
 * - `nodeName/nodeId` 表示“产生该消息的节点”，便于日志/追踪。
 */
export interface Message<D> {
  readonly id: string;
  readonly nodeName: string;
  readonly nodeId: string;
  readonly time: number;
  readonly data: D;
}

/**
 * 用于声明 “按 class 做依赖” 的构造器类型。
 *
 * @remarks
 * `Pipeline` 会在被其管理的节点集合中，为每个被引用的 ctor 找到唯一 provider 实例。
 */
export type NodeCtor<T extends Node<any, any> = Node<any, any>> = new (
  ...args: any[]
) => T;

/**
 * 节点依赖元信息（按 class 声明）。
 *
 * @example
 * ```ts
 * class DbNode extends Node<never, DbClient> { ... }
 * class QueryNode extends Node<Query, Result> {
 *   static dependency = { dependsOn: DbNode };
 * }
 * ```
 */
export interface NodeDependencyMeta {
  dependsOn?: NodeCtor;
  optional?: boolean;
}

/**
 * 编排系统的最小执行单元：有输入/输出、有生命周期、有可组合的连接关系。
 *
 * @remarks
 * **生命周期**
 * - `start()`：初始化资源（连接/定时器/缓存等）；start 成功后才能处理消息
 * - `receive()`：接收上游消息并处理（由框架调用）
 * - `dispose()`：释放资源；一旦 dispose，该节点不再可用
 *
 * **连接**
 * - `register()`：把某个下游 consumer 注册为本节点输出的接收者（fan-out）
 * - `dispatch()`：向所有下游发送消息（fire-and-forget，保证“尝试投递”，不保证下游完成）
 *
 * **缓冲语义**
 * - start 进行中收到的 inbound 消息会被缓冲，start 完成后再 flush
 * - start 进行中 dispatch 的 outbound 也会缓冲，start 完成后再 fanout
 */
export abstract class Node<TIn = any, TOut = any> {
  public readonly id: string;
  public readonly name: string;

  private readonly abortController = new AbortController();
  private readonly consumers: Node<TOut, unknown>[] = [];

  protected started = false;
  protected starting = false;
  protected disposed = false;

  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;

  private inboundBuffer: Message<TIn>[] = [];
  private outboundBuffer: Message<TOut>[] = [];

  protected get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * @param name 节点名称（用于日志/诊断）；默认使用 class 名
   */
  constructor(
    name: string = new.target.name,
  ) {
    this.name = name;
    this.id = randomUUID();
  }

  /**
   * class 级别依赖声明：用于 `Pipeline` 的拓扑编排（可选）。
   *
   * @remarks
   * - `dependsOn`：本节点依赖的 provider ctor
   * - `optional=true`：provider 缺失时不报错
   */
  public static dependency?: NodeDependencyMeta;

  /**
   * 读取当前节点（class）的依赖声明。
   */
  public getDependencyMeta(): NodeDependencyMeta | undefined {
    const ctor = this.constructor as typeof Node;
    return ctor.dependency;
  }

  /**
   * 接收上游消息（由框架/上游节点调用）。
   *
   * @remarks
   * - 未 start：如果正在 start，则缓冲；否则抛错
   * - 已 dispose/abort：抛错
   * - `onReceive()` 抛错会被捕获并记录日志，不会让上游崩溃
   */
  public async receive(msg: Message<TIn>): Promise<void> {
    if (this.disposed) {
      throw new Error(`Node '${this.name}' is disposed.`);
    }
    if (this.abortSignal.aborted) {
      throw new Error(`Node '${this.name}' has been aborted.`);
    }

    if (!this.started) {
      if (this.starting) {
        this.inboundBuffer.push(msg);
        return;
      }
      throw new Error(`Node '${this.name}' has not been started.`);
    }

    try {
      await this.onReceive(msg);
    } catch (error) {
      console.error(`[${this.name}] onReceive failed (msgId=${msg.id})`, {
        nodeId: this.id,
        msgId: msg.id,
        msgNodeName: msg.nodeName,
        msgNodeId: msg.nodeId,
        error,
      });
    }
  }

  protected abstract onReceive(msg: Message<TIn>): Promise<void>;

  /**
   * 向下游 fan-out（fire-and-forget）。
   *
   * @remarks
   * `dispatch()` 只保证“尝试投递到所有下游”，不保证下游处理完成。
   */
  protected async dispatch(data: TOut): Promise<void> {
    await this.dispatchInternal(data);
  }

  /**
   * 类似 `dispatch()`，但允许指定 `Message.time`。
   *
   * @remarks
   * 适用于上游事件自带事件时间（event time）而不是处理时间（process time）。
   */
  protected async dispatchAt(data: TOut, time: number): Promise<void> {
    await this.dispatchInternal(data, time);
  }

  private async dispatchInternal(data: TOut, time?: number): Promise<void> {
    if (this.disposed || this.abortSignal.aborted) return;

    const now = Date.now();
    const ts = typeof time === "number" && Number.isFinite(time) ? time : now;

    const msg: Message<TOut> = {
      id: randomUUID(),
      nodeId: this.id,
      nodeName: this.name,
      time: ts,
      data: data,
    };

    if (!this.started) {
      if (this.starting) {
        this.outboundBuffer.push(msg);
        return;
      }
      throw new Error(`Node '${this.name}' has not been started.`);
    }

    this.fanout(msg);
  }

  private fanout(msg: Message<TOut>): void {
    const snapshot = [...this.consumers];
    for (const c of snapshot) {
      void c.receive(msg).catch((err) => {
        console.error("[pipeline] dispatch failed", {
          fromName: this.name,
          fromId: this.id,
          toName: c.name,
          toId: c.id,
          msgId: msg.id,
          msgNodeName: msg.nodeName,
          msgNodeId: msg.nodeId,
          error: err,
        });
      });
    }
  }

  /**
   * 获取当前已注册的下游节点快照。
   *
   * @remarks
   * 主要用于 `Pipeline` 在 build 阶段读取 wiring 关系，从而推导安全的启动顺序：
   * `producer.register(consumer)` 意味着 consumer 必须先 start。
   */
  public getDownstreamNodes(): ReadonlyArray<Node<TOut, unknown>> {
    return [...this.consumers];
  }

  /**
   * 注册下游节点：本节点 dispatch 的输出会被投递给该 consumer。
   *
   * @remarks
   * 推荐只在 build-time（`Pipeline.start()` 之前）完成 wiring。
   */
  public register<TNext>(consumer: Node<TOut, TNext>): this {
    const c = consumer as unknown as Node<TOut, unknown>;
    if (!this.consumers.includes(c)) {
      this.consumers.push(c);
    }
    return this;
  }

  /**
   * 解除注册的下游节点。
   */
  public unregister(consumer: Node<TOut, unknown>): this {
    const idx = this.consumers.indexOf(consumer);
    if (idx >= 0) {
      this.consumers.splice(idx, 1);
    }
    return this;
  }

  /**
   * 启动节点（幂等）。
   *
   * @remarks
   * - start 成功后才允许 `receive()/dispatch()`
   * - start 进行中到达的 inbound/outbound 会缓冲，start 完成后 flush
   * - 如果 start 过程中发生 dispose/abort，start() 会确定性 reject
   */
  public async start(): Promise<void> {
    if (this.disposed || this.abortSignal.aborted) {
      throw new Error(
        `Node '${this.name}' cannot be started because it is disposed/aborted.`,
      );
    }
    if (this.startPromise) return await this.startPromise;

    this.startPromise = this.startInternal();
    return await this.startPromise;
  }

  /**
   * start() only reflects onStart() success; buffered message handling errors do not fail start().
   * Robustness: if dispose happens during start(), start() must reject deterministically.
   */
  private async startInternal(): Promise<void> {
    if (this.started) return;
    if (this.disposed || this.abortSignal.aborted) {
      throw new Error(
        `Node '${this.name}' cannot be started because it is disposed/aborted.`,
      );
    }

    this.starting = true;
    try {
      await this.onStart();

      // 如果 start 过程中被 dispose/abort，start() 必须失败（防止 “start resolve 但节点已不可用”）
      if (this.disposed || this.abortSignal.aborted) {
        throw new Error(`Node '${this.name}' disposed/aborted during start().`);
      }

      this.started = true;
    } catch (e) {
      this.inboundBuffer = [];
      this.outboundBuffer = [];
      throw e;
    } finally {
      this.starting = false;
    }

    await this.flushOutbound();
    await this.flushInbound();

    // 如果在 flush 阶段发生 dispose，也必须让 start() reject（确定性收敛）
    if (this.disposed || this.abortSignal.aborted) {
      throw new Error(`Node '${this.name}' disposed/aborted during start().`);
    }
  }

  protected abstract onStart(): Promise<void>;

  private async flushOutbound(): Promise<void> {
    if (this.disposed || this.abortSignal.aborted) {
      this.outboundBuffer = [];
      return;
    }
    if (this.outboundBuffer.length === 0) return;

    const batch = this.outboundBuffer;
    this.outboundBuffer = [];
    for (const msg of batch) {
      this.fanout(msg);
    }
  }

  private async flushInbound(): Promise<void> {
    if (this.disposed || this.abortSignal.aborted) {
      this.inboundBuffer = [];
      return;
    }
    if (this.inboundBuffer.length === 0) return;

    const batch = this.inboundBuffer;
    this.inboundBuffer = [];
    for (const msg of batch) {
      try {
        await this.receive(msg);
      } catch (error) {
        console.error(`[${this.name}] flushInbound failed`, {
          nodeId: this.id,
          msgId: msg.id,
          msgNodeName: msg.nodeName,
          msgNodeId: msg.nodeId,
          error,
        });
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposePromise) return await this.disposePromise;

    // 立刻切断可用性：后续 receive/dispatch 立即失败或 no-op
    this.disposed = true;
    try {
      this.abortController.abort(new Error(`Node '${this.name}' disposed.`));
    } catch {}

    this.inboundBuffer = [];
    this.outboundBuffer = [];

    this.disposePromise = this.disposeInternal();
    return await this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    // Ensure dispose waits for start to settle (resolve or reject) even if starting=true.
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // start failure is still acceptable; we just need deterministic ordering.
      }
    }

    await this.onDispose();
  }

  protected abstract onDispose(): Promise<void>;

  /**
   * build-time 断言：用于禁止在节点运行中修改结构（wiring/children 等）。
   *
   * @param op 用于报错提示的操作名
   */
  protected assertBuildTime(op: string): void {
    if (this.disposed || this.abortSignal.aborted) {
      throw new Error(
        `Pipeline '${this.name}' is disposed/aborted and cannot ${op}.`,
      );
    }
    if (this.started || this.starting) {
      throw new Error(
        `Pipeline '${this.name}' already started. '${op}' is build-time only.`,
      );
    }
  }

  /**
   * 返回该节点“希望被 Pipeline 管理”的子节点列表（默认空）。
   *
   * @remarks
   * 用于组合节点（Composite）场景：让 `Pipeline` 把拓扑/启动/销毁提升到
   * “ultimate anchor” 粒度，避免内部 bridge 节点干扰编排。
   */
  public getManagedNodes(): ReadonlyArray<Node<any, any>> {
    return [];
  }
}

/**
 * 生产者节点：无输入（`TIn=never`），只能主动 `dispatch()` 输出。
 */
export abstract class ProducerNode<TOut> extends Node<never, TOut> {
  protected async onReceive(_msg: Message<never>): Promise<void> {
    throw new Error(`ProducerNode '${this.name}' does not accept input.`);
  }
}

/**
 * 消费者节点：无输出（`TOut=never`），只接收并处理输入。
 */
export abstract class ConsumerNode<TIn> extends Node<TIn, never> {
  // no extra members
}

/**
 * 仅用于标注 “根级编排” 的节点类型（无输入/无输出）。
 *
 * @remarks
 * 如果你想把一整段编排封装成一个可被外部启动/销毁的模块，可以继承它。
 */
export abstract class RootPipeline extends Node<never, never> {
  protected async onReceive(_msg: Message<never>): Promise<void> {}
}
