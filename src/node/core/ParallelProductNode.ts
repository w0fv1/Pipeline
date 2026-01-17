import { type Message, Node } from "./Node";
import { BaseParallelNode } from "./BaseParallelNode";

/**
 * ParallelProductNode：无输入的并行“生产者聚合器”。
 *
 * @remarks
 * - 本节点不接收任何上游输入（TIn=never）
 * - 仅负责启动/销毁一组会主动产生输出的 children，并通过 bridge fan-in 后向下游 dispatch
 *
 * 适用于：多个定时器/多个 producer 同时产出同一类型输出时的汇聚。
 */
export class ParallelProductNode<TOut = unknown> extends BaseParallelNode<
    never,
    TOut
> {
    /**
     * @param name 节点名称（用于日志/诊断）
     */
    constructor(name?: string) {
        super(name);
    }

    /**
     * 添加一个会产出 `TOut` 的 child。
     *
     * @remarks
     * build-time only：start 之后禁止改结构。
     */
    public node<TIn>(child: Node<TIn, TOut>): this {
        this.addChildBuildTime(child as unknown as Node<any, TOut>);
        return this;
    }

    protected override async onReceive(_msg: Message<never>): Promise<void> {
        throw new Error(
            `ParallelProductNode '${this.name}' does not accept input.`,
        );
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
