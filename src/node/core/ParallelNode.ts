// File: src/node/core/ParallelNode.ts

import { Message, Node } from "./Node";
import type { ChainNode } from "./ChainNode";
import { BaseParallelNode } from "./BaseParallelNode";

/**
 * ParallelNode<TIn, TOut>
 * - 接收输入并 fan-out 给 children（并行执行）
 * - children 的输出统一通过 bridge fan-in，再由本节点 dispatch 给下游
 *
 * 约束：
 * - 不支持热插拔：children 只能在 start 前通过 node()/pipe()/stage() 添加。
 */
export class ParallelNode<TIn, TOut> extends BaseParallelNode<TIn, TOut> {
    constructor(name?: string) {
        super(name);
    }

    public node(child: Node<TIn, TOut>): this {
        this.addChildBuildTime(child as unknown as Node<any, TOut>);
        return this;
    }

    public pipe(pipeline: ChainNode<TIn, TOut>): this {
        return this.node(pipeline);
    }

    public stage(stage: ParallelNode<TIn, TOut>): this {
        return this.node(stage);
    }

    protected override async onReceive(msg: Message<TIn>): Promise<void> {
        const snapshot = [...this.children] as unknown as Node<TIn, TOut>[];
        for (const child of snapshot) {
            void child.receive(msg).catch((err) => {
                console.error(`[${this.name}] child receive failed`, {
                    parentId: this.id,
                    childName: child.name,
                    childId: child.id,
                    msgId: msg.id,
                    msgNodeName: msg.nodeName,
                    msgNodeId: msg.nodeId,
                    error: err,
                });
            });
        }
    }

    protected override async onStart(): Promise<void> {
        await this.startBase();
    }

    protected override async onDispose(): Promise<void> {
        await this.disposeBase();
    }
}
