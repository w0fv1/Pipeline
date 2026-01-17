// File: src/node/core/ParallelProductNode.ts

import { type Message, Node } from "./Node";
import { BaseParallelNode } from "./BaseParallelNode";

export class ParallelProductNode<TOut = unknown> extends BaseParallelNode<
    never,
    TOut
> {
    constructor(name?:string) {
        super(name);
    }

    public node<TIn>(child: Node<TIn, TOut>): this {
        this.addChildBuildTime(child as unknown as Node<any, TOut>);
        return this;
    }

    protected override async onReceive(_msg: Message<never>): Promise<void> {
        throw new Error(
            `ParallelProductNode '${this.name}' does not accept input.`,
        );
    }

    protected override async onStart(): Promise<void> {
        await this.startBase();
    }

    protected override async onDispose(): Promise<void> {
        await this.disposeBase();
    }
}
