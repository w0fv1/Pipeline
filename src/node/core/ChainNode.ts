import { CallbackSinkNode } from "../ToolPipelineNode";
import { Message, Node } from "./Node";
import type { ParallelNode } from "./ParallelNode";

export class ChainNode<TIn, TOut = TIn> extends Node<TIn, TOut> {
    private readonly children: Node<unknown, unknown>[] = [];
    private head: Node<TIn, unknown> | null = null;
    private tail: Node<unknown, TOut> | null = null;

    private readonly bridge: CallbackSinkNode<TOut>;

    constructor(name?: string) {
        super(name);
        this.bridge = new CallbackSinkNode<TOut>(
            async (data) => {
                await this.dispatch(data);
            },
        );
    }

    public node<TNext>(node: Node<TOut, TNext>): ChainNode<TIn, TNext> {
        this.assertBuildTime("add node via node()");
        this.addNodeInternal(node);
        return this as unknown as ChainNode<TIn, TNext>;
    }

    public stage<TNext>(
        stage: ParallelNode<TOut, TNext>,
    ): ChainNode<TIn, TNext> {
        return this.node(stage);
    }

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

    public getManagedNodes(): ReadonlyArray<Node<any, any>> {
        // Include bridge so Pipeline.strict can account for children -> bridge edges.
        return [...this.children];
    }

}
