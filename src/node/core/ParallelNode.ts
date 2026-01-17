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
    /**
     * @param name 节点名称（用于日志/诊断）
     */
    constructor(name?: string) {
        super(name);
    }

    /**
     * 添加一个并行分支（child）。
     *
     * @remarks
     * build-time only：start 之后禁止改结构。
     */
    public node(child: Node<TIn, TOut>): this {
        this.addChildBuildTime(child as unknown as Node<any, TOut>);
        return this;
    }

    /**
     * 语义别名：把一个 ChainNode 作为并行分支接入。
     */
    public pipe(pipeline: ChainNode<TIn, TOut>): this {
        return this.node(pipeline);
    }

    /**
     * 语义别名：把另一个 ParallelNode 作为并行分支接入。
     */
    public stage(stage: ParallelNode<TIn, TOut>): this {
        return this.node(stage);
    }

    /**
     * fan-out：把同一条消息并发投递给所有 children。
     *
     * @remarks
     * - child 的处理是并发 fire-and-forget（不等待完成）
     * - child 报错会被 catch 并打印日志，不会影响其它分支
     */
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

    /**
     * 启动 base：bridge + children。
     */
    protected override async onStart(): Promise<void> {
        await this.startBase();
    }

    /**
     * 销毁 base：children + bridge。
     */
    protected override async onDispose(): Promise<void> {
        await this.disposeBase();
    }
}
