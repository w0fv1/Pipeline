import { CallbackSinkNode } from "../ToolPipelineNode";
import { Message, Node } from "./Node";
import type { ParallelNode } from "./ParallelNode";

/**
 * ChainNode：将多个节点按顺序串联（pipeline/chain）。
 *
 * @remarks
 * - 通过 `node()/stage()/pipe()` 在 build-time 组装 children
 * - 运行时：输入从 head 进入，沿 wiring 依次流动；末端通过内部 bridge 回到本节点，再 `dispatch()` 给下游
 * - `Pipeline` 会把 ChainNode 视为一个 anchor（children 由 ChainNode 管理并在其 `onStart/onDispose` 中启动/销毁）
 */
export class ChainNode<TIn, TOut = TIn> extends Node<TIn, TOut> {
    private readonly children: Node<unknown, unknown>[] = [];
    private head: Node<TIn, unknown> | null = null;
    private tail: Node<unknown, TOut> | null = null;

    private readonly bridge: CallbackSinkNode<TOut>;

    /**
     * @param name 节点名称（用于日志/诊断）
     */
    constructor(name?: string) {
        super(name);
        this.bridge = new CallbackSinkNode<TOut>(
            async (data) => {
                await this.dispatch(data);
            },
        );
    }

    /**
     * 在 chain 末尾追加一个节点，并返回“类型更新后的 chain”。
     *
     * @remarks
     * build-time only：start 之后禁止改结构。
     */
    public node<TNext>(node: Node<TOut, TNext>): ChainNode<TIn, TNext> {
        this.assertBuildTime("add node via node()");
        this.addNodeInternal(node);
        return this as unknown as ChainNode<TIn, TNext>;
    }

    /**
     * 语义别名：追加一个并行 stage（ParallelNode）。
     */
    public stage<TNext>(
        stage: ParallelNode<TOut, TNext>,
    ): ChainNode<TIn, TNext> {
        return this.node(stage);
    }

    /**
     * 语义别名：把另一个 ChainNode 作为一个 stage 接到当前末尾。
     */
    public pipe<TNext>(
        pipeline: ChainNode<TOut, TNext>,
    ): ChainNode<TIn, TNext> {
        return this.node(pipeline);
    }

    private addNodeInternal(node: Node<unknown, unknown>): void {
        // build-time only：本方法只会在 node()/stage()/pipe() 中调用，外层已 assertBuildTime
        if (!this.head) {
            this.head = node as unknown as Node<TIn, unknown>;
            this.tail = node as unknown as Node<unknown, TOut>;
            this.children.push(node);

            // ✅ build-time：第一次就把 tail -> bridge 连好
            (this.tail as unknown as Node<any, any>).register(
                this.bridge as unknown as Node<any, any>,
            );
            return;
        }

        const prevTail = this.tail as unknown as Node<any, any>;

        // ✅ 先把 bridge 从旧 tail 上摘掉（避免桥接残留在中间节点）
        prevTail.unregister(this.bridge as unknown as Node<any, any>);

        // 旧 tail -> 新 node
        prevTail.register(node as unknown as Node<any, any>);

        // 更新 tail
        this.tail = node as unknown as Node<unknown, TOut>;
        this.children.push(node);

        // ✅ 新 tail -> bridge
        (this.tail as unknown as Node<any, any>).register(
            this.bridge as unknown as Node<any, any>,
        );
    }

    protected async onReceive(msg: Message<TIn>): Promise<void> {
        if (!this.head) {
            throw new Error(
                `Pipeline '${this.name}' is empty and cannot process data.`,
            );
        }
        await this.head.receive(msg);
    }

    /**
     * 启动顺序：downstream -> upstream。
     *
     * @remarks
     * 先启动 bridge，再逆序启动 children，确保消息投递时下游已 ready。
     */
    protected async onStart(): Promise<void> {
        if (!this.head || !this.tail) return;

        const startedNodes: Node<unknown, unknown>[] = [];
        let bridgeStarted = false;

        try {
            await this.bridge.start();
            bridgeStarted = true;

            // downstream -> upstream
            for (const n of [...this.children].reverse()) {
                await (n as Node<any, any>).start();
                startedNodes.push(n);
            }
        } catch (e) {
            for (const n of [...startedNodes].reverse()) {
                try {
                    await (n as Node<any, any>).dispose();
                } catch {}
            }

            if (bridgeStarted) {
                try {
                    await this.bridge.dispose();
                } catch {}
            }

            throw e;
        }
    }

    /**
     * 销毁所有 children 与 bridge（best-effort），并汇总输出错误日志。
     */
    protected async onDispose(): Promise<void> {
        const r1 = await Promise.allSettled(
            this.children.map((n) => (n as Node<any, any>).dispose()),
        );
        const r2 = await Promise.allSettled([this.bridge.dispose()]);

        const errors = [...r1, ...r2]
            .filter((r) => r.status === "rejected")
            .map((r) => (r as PromiseRejectedResult).reason);

        if (errors.length > 0) {
            console.error(
                `[${this.name}] dispose encountered errors`,
                errors,
            );
        }
    }

    /**
     * 组合节点声明：children 会被 Pipeline 作为 managed nodes 收集。
     *
     * @remarks
     * 注意：这里不返回 `bridge`（它是内部实现细节），避免干扰 Pipeline 的拓扑推导。
     */
    public getManagedNodes(): ReadonlyArray<Node<any, any>> {
        return [...this.children];
    }

}
