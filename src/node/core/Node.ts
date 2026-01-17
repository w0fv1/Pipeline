import { randomUUID } from "crypto";

export interface Message<D> {
  readonly id: string;
  readonly nodeName: string;
  readonly nodeId: string;
  readonly time: number;
  readonly data: D;
}

export type NodeCtor<T extends Node<any, any> = Node<any, any>> = new (
  ...args: any[]
) => T;
export interface NodeDependencyMeta {
  dependsOn?: NodeCtor;
  optional?: boolean;
}

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

  constructor(
    name: string = new.target.name,
  ) {
    this.name = name;
    this.id = randomUUID();
  }
  public static dependency?: NodeDependencyMeta;

  public getDependencyMeta(): NodeDependencyMeta | undefined {
    const ctor = this.constructor as typeof Node;
    return ctor.dependency;
  }

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
   * fire-and-forget: dispatch only guarantees fanout attempt, not downstream completion.
   */
  protected async dispatch(data: TOut): Promise<void> {
    await this.dispatchInternal(data);
  }

  /**
   * Like dispatch(), but uses a caller-supplied timestamp for Message.time.
   * Useful when upstream events already carry their own event time.
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
   * Returns a snapshot of downstream nodes registered via register().
   * Intended for orchestration/build-time introspection.
   */
  public getDownstreamNodes(): ReadonlyArray<Node<TOut, unknown>> {
    return [...this.consumers];
  }

  public register<TNext>(consumer: Node<TOut, TNext>): this {
    const c = consumer as unknown as Node<TOut, unknown>;
    if (!this.consumers.includes(c)) {
      this.consumers.push(c);
    }
    return this;
  }

  public unregister(consumer: Node<TOut, unknown>): this {
    const idx = this.consumers.indexOf(consumer);
    if (idx >= 0) {
      this.consumers.splice(idx, 1);
    }
    return this;
  }

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
  public getManagedNodes(): ReadonlyArray<Node<any, any>> {
    return [];
  }
}

export abstract class ProducerNode<TOut> extends Node<never, TOut> {
  protected async onReceive(_msg: Message<never>): Promise<void> {
    throw new Error(`ProducerNode '${this.name}' does not accept input.`);
  }
}

export abstract class ConsumerNode<TIn> extends Node<TIn, never> {
  // no extra members
}

export abstract class RootPipeline extends Node<never, never> {
  protected async onReceive(_msg: Message<never>): Promise<void> {}
}
