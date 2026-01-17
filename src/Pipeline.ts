import { Node, type NodeCtor } from "./node/core/Node";

type AnyNode = Node<unknown, unknown>;

export interface AddOptions {
    /**
     * keepAlive=true：即使该节点（最终 anchor）没有参与任何依赖关系，也会被启动。
     * keepAlive 在 add 时指定；不会从 Node 静态/实例字段读取，避免 Node 层被 Pipeline 侵入。
     */
    keepAlive?: boolean;
}

export class Pipeline {
    private readonly roots = new Set<AnyNode>();

    private built = false;
    private started = false;

    private allNodes = new Set<AnyNode>();
    private ownerOf = new Map<AnyNode, AnyNode>();

    private anchors: AnyNode[] = [];
    private activeTopo: AnyNode[] = [];
    private rootAnchors = new Set<AnyNode>();

    // keepAlive 由 add() 指定；build 时映射到 ultimate anchor
    private readonly keepAliveRoots = new Set<AnyNode>();
    private keepAliveAnchors = new Set<AnyNode>();

    public add(node: AnyNode, options: AddOptions = {}): this {
        if (this.started) {
            throw new Error(
                `Pipeline already started; add() is build-time only.`,
            );
        }
        if (options.keepAlive) {
            this.keepAliveRoots.add(node);
        }

        this.roots.add(node);
        this.built = false;
        return this;
    }

    public async start(): Promise<void> {
        if (this.started) return;

        this.build();

        // 依赖驱动：providers(入度=0) -> dependents
        const startedAnchors: AnyNode[] = [];
        try {
            for (const a of this.activeTopo) {
                await a.start();
                startedAnchors.push(a);
            }
            this.started = true;
        } catch (e) {
            // 回滚：逆序 dispose
            for (const a of [...startedAnchors].reverse()) {
                try {
                    await a.dispose();
                } catch {}
            }
            throw e;
        }
    }

    public async dispose(): Promise<void> {
        if (!this.built) {
            await Promise.allSettled([...this.roots].map((r) => r.dispose()));
            this.started = false;
            return;
        }

        // 依赖驱动：dependents 先 dispose，providers 后 dispose
        for (const a of [...this.activeTopo].reverse()) {
            try {
                await a.dispose();
            } catch {}
        }
        this.started = false;
    }

    private build(): void {
        if (this.built) return;

        // 1) collect managed nodes：roots + composite.getManagedNodes()
        this.allNodes = new Set();
        this.ownerOf = new Map();
        for (const r of this.roots) {
            this.collect(r, undefined);
        }

        // 2) anchors：ultimate owners
        const anchorSet = new Set<AnyNode>();
        for (const n of this.allNodes) {
            anchorSet.add(this.getUltimateAnchor(n));
        }
        this.anchors = [...anchorSet];

        // roots -> ultimate anchors (explicitly added nodes must be started)
        this.rootAnchors = new Set(
            [...this.roots].map((n) => this.getUltimateAnchor(n)),
        );

        // 3) keepAlive anchors：由 add(root, {keepAlive:true}) 指定并映射到 anchor
        this.keepAliveAnchors = new Set(
            [...this.keepAliveRoots].map((n) => this.getUltimateAnchor(n)),
        );

        // 4) 构建依赖图（anchor 级，表达 “必须先 start 的约束”）
        const { edges, indeg, outdeg } = this.buildDependencyGraph();

        // 5) 拓扑排序（依赖有环 => 直接报错）
        const topo = this.kahnTopoSort(this.anchors, edges, new Map(indeg));

        // 6) active：显式 roots / 参与依赖 / keepAlive
        const isIsolatedByDependency = (a: AnyNode): boolean => {
            return (indeg.get(a) ?? 0) + (outdeg.get(a) ?? 0) === 0;
        };

        this.activeTopo = topo.filter(
            (a) =>
                this.rootAnchors.has(a) ||
                this.keepAliveAnchors.has(a) ||
                !isIsolatedByDependency(a),
        );

        this.built = true;
    }

    /**
     * 收集 managed nodes：
     * - roots 全纳入
     * - composite.getManagedNodes() 返回的功能节点纳入，并记录 owner 关系
     *
     * 注意：Composite 完全决定哪些 children 被 Pipeline 管理（bridge/internal 节点不返回即可）。
     */
    private collect(node: AnyNode, owner?: AnyNode): void {
        if (owner) {
            const existedOwner = this.ownerOf.get(node);
            if (existedOwner && existedOwner !== owner) {
                throw new Error(
                    `Node '${node.name}' is managed by multiple composites: ` +
                        `[${existedOwner.name}, ${owner.name}].`,
                );
            }
            this.ownerOf.set(node, owner);
        }

        if (this.allNodes.has(node)) return;
        this.allNodes.add(node);

        for (const c of node.getManagedNodes()) {
            this.collect(c as AnyNode, node);
        }
    }

    private getUltimateAnchor(node: AnyNode): AnyNode {
        let cur: AnyNode = node;
        for (;;) {
            const owner = this.ownerOf.get(cur);
            if (!owner) return cur;
            cur = owner;
        }
    }

    /**
     * 构建依赖图（anchor 级）：
     * - 静态依赖：consumer.dependsOn(ProviderCtor) => providerAnchor -> consumerAnchor（provider 先启动）
     * - 数据流 wiring：producer.register(consumer) => consumerAnchor -> producerAnchor（consumer 先启动）
     */
    private buildDependencyGraph(): {
        edges: Map<AnyNode, Set<AnyNode>>;
        indeg: Map<AnyNode, number>;
        outdeg: Map<AnyNode, number>;
    } {
        const edges = new Map<AnyNode, Set<AnyNode>>();
        const indeg = new Map<AnyNode, number>();
        const outdeg = new Map<AnyNode, number>();

        for (const a of this.anchors) {
            edges.set(a, new Set());
            indeg.set(a, 0);
            outdeg.set(a, 0);
        }

        // 收集所有被引用的 provider ctor（只有被 dependsOn 引用的 ctor 才需要唯一 provider）
        const providerCtors = new Set<NodeCtor>();
        for (const n of this.allNodes) {
            const meta = n.getDependencyMeta();
            if (meta?.dependsOn) providerCtors.add(meta.dependsOn);
        }

        // ctor -> provider instance（唯一）
        const ctorIndex = new Map<NodeCtor, AnyNode>();
        for (const n of this.allNodes) {
            const ctor = n.constructor as NodeCtor;
            if (!providerCtors.has(ctor)) continue;

            const existed = ctorIndex.get(ctor);
            if (existed && existed !== n) {
                throw new Error(
                    `Pipeline has multiple providers for dependency-by-class: ` +
                        `${ctor.name} => [${existed.name}, ${n.name}]. ` +
                        `This ctor is referenced by dependsOn and must be unique.`,
                );
            }
            ctorIndex.set(ctor, n);
        }

        // 依赖边：providerAnchor -> consumerAnchor
        for (const consumer of this.allNodes) {
            const meta = consumer.getDependencyMeta();
            const depCtor = meta?.dependsOn;
            if (!depCtor) continue;

            const provider = ctorIndex.get(depCtor);
            if (!provider) {
                if (meta?.optional) continue;
                throw new Error(
                    `Pipeline  missing provider: ` +
                        `${depCtor.name} (required by ${consumer.name}).`,
                );
            }
            if (provider === consumer) {
                throw new Error(
                    `Pipeline invalid dependency: Node '${consumer.name}' depends on itself.`,
                );
            }

            const from = this.getUltimateAnchor(provider);
            const to = this.getUltimateAnchor(consumer);
            if (from === to) continue;

            const outs = edges.get(from)!;
            if (!outs.has(to)) {
                outs.add(to);
                indeg.set(to, (indeg.get(to) ?? 0) + 1);
                outdeg.set(from, (outdeg.get(from) ?? 0) + 1);
            }
        }

        // wiring 边：consumerAnchor -> producerAnchor（只考虑被 Pipeline 管理的节点；忽略内部 bridge 等未纳入 allNodes 的节点）
        for (const producer of this.allNodes) {
            for (const consumer of producer.getDownstreamNodes()) {
                const c = consumer as unknown as AnyNode;
                if (!this.allNodes.has(c)) continue;

                const producerAnchor = this.getUltimateAnchor(producer);
                const consumerAnchor = this.getUltimateAnchor(c);
                if (producerAnchor === consumerAnchor) continue;

                const outs = edges.get(consumerAnchor)!;
                if (!outs.has(producerAnchor)) {
                    outs.add(producerAnchor);
                    indeg.set(
                        producerAnchor,
                        (indeg.get(producerAnchor) ?? 0) + 1,
                    );
                    outdeg.set(
                        consumerAnchor,
                        (outdeg.get(consumerAnchor) ?? 0) + 1,
                    );
                }
            }
        }

        return { edges, indeg, outdeg };
    }

    private kahnTopoSort(
        nodes: AnyNode[],
        edges: Map<AnyNode, Set<AnyNode>>,
        indeg: Map<AnyNode, number>,
    ): AnyNode[] {
        const q: AnyNode[] = [];
        for (const n of nodes) {
            if ((indeg.get(n) ?? 0) === 0) q.push(n);
        }

        const out: AnyNode[] = [];
        while (q.length) {
            const n = q.shift()!;
            out.push(n);

            const outs = edges.get(n);
            if (!outs) continue;
            for (const v of outs) {
                const d = (indeg.get(v) ?? 0) - 1;
                indeg.set(v, d);
                if (d === 0) q.push(v);
            }
        }

        if (out.length !== nodes.length) {
            const stuck = nodes
                .filter((n) => !out.includes(n))
                .map((n) => n.name);
            throw new Error(
                `Pipeline dependency cycle detected among anchors: ${
                    stuck.join(", ")
                }`,
            );
        }

        return out;
    }
}
