# Pipeline

一个轻量的编排（DAG）工具库，用来把一组可组合的异步 `Node` 串/并联起来，并通过 `Pipeline` 负责启动/销毁顺序与依赖拓扑。

适用场景（你可能正在遇到这些痛点）：

- 你有很多异步处理步骤，想用“搭积木”的方式拼出串联/并联的处理图
- 你希望统一管理资源生命周期（启动连接/启动定时器/释放资源），避免遗漏
- 你希望自动推导安全启动顺序，避免 “上游 `dispatch` 时下游还没 `start`” 的竞态
- 你希望把一段复杂编排封装为一个组合节点，对外只暴露一个入口

## 特性

- `Node`：统一生命周期（`start/receive/dispose`）+ fan-out 分发（`register/dispatch`）
- `ChainNode`：串联多个节点（stage-by-stage）
- `ParallelNode`：并联分支（fan-out + fan-in）
- `ParallelProductNode`：无输入的并联聚合（多个 producer 汇聚）
- `Pipeline`：根据依赖拓扑自动启动/销毁（支持 `keepAlive`）
- `LogMiddlewareNode`：日志/统计/节流中间件（可运行时改配置）
- `ManualTriggerNode` / `CallbackSinkNode`：便捷触发源与终端 sink
- `TimerProducerNode` / `TimeEmitterNode` / `TimeDualNode`：定时类节点基类

## 安装（从 GitHub 引入）

把 `<owner>/<repo>` 替换成你的仓库地址：

```bash
# npm
npm i git+https://github.com/<owner>/<repo>.git

# pnpm
pnpm add github:<owner>/<repo>
```

从 GitHub 安装时会执行 `prepare`，自动构建 `dist/`（便于在业务项目中直接使用）。

## 本仓库开发/运行示例

```bash
npm i
npm run dev:example
```

## 快速开始（最小可用）

最小示例见 `examples/basic.ts`。下面是一个“手动触发 -> 串联 -> 并联 -> 输出”的例子：

```ts
import {
  CallbackSinkNode,
  ChainNode,
  ManualTriggerNode,
  Node,
  ParallelNode,
  Pipeline,
  type Message,
} from "@wofbi/pipeline";

class MapNode<TIn, TOut> extends Node<TIn, TOut> {
  constructor(
    private readonly map: (data: TIn, msg: Message<TIn>) => TOut | Promise<TOut>,
    name?: string,
  ) {
    super(name);
  }
  protected async onStart() {}
  protected async onReceive(msg: Message<TIn>) {
    await this.dispatch(await this.map(msg.data, msg));
  }
  protected async onDispose() {}
}

const trigger = new ManualTriggerNode<number>("trigger");

const chain = new ChainNode<number, number>("main")
  .node(new MapNode((n) => n * 2, "double"))
  .stage(
    new ParallelNode<number, string>("branches")
      .node(new MapNode((n) => `double=${n}`, "asText"))
      .node(new MapNode((n) => `square=${n * n}`, "square")),
  )
  .node(new CallbackSinkNode((s) => console.log("[out]", s), "print"));

// wiring：trigger -> chain
trigger.register(chain);

// 关键：把“参与 wiring 的上下游双方”都 add() 进 Pipeline（都由 Pipeline 负责 start/dispose）
const pipeline = new Pipeline().add(chain).add(trigger);

await pipeline.start();
await trigger.trigger(3);
await trigger.trigger(7);
await pipeline.dispose();
```

## 核心概念（建议先读）

### Node / Message / wiring

- **Node**：有生命周期（`start/receive/dispose`）的异步单元。
- **Message**：节点间传递的数据包装，包含 `time/nodeName/nodeId` 等 meta。
- **wiring（连线）**：通过 `producer.register(consumer)` 形成的数据流边。之后 producer `dispatch()` 会 fan-out 给所有 consumer。

约定：wiring 建议只在 build-time（`Pipeline.start()` 之前）完成。运行中动态改结构很难保证一致性。

### build-time vs run-time

- build-time：搭图阶段（创建节点、`register()`、`ChainNode.node()`、`ParallelNode.node()` 等）
- run-time：运行阶段（已 `Pipeline.start()`，开始 `receive/dispatch`）

库会尽量在 run-time 阻止结构修改（例如 `ChainNode.node()` 会 `assertBuildTime`）。

### managed nodes / Composite / anchor

`Pipeline` 只会管理（start/dispose）它“知道”的节点：

- `Pipeline.add(node)` 把 node 作为 root 纳入管理
- `Pipeline` 会递归调用 root 的 `getManagedNodes()` 把组合节点内部 children 纳入管理
- 组合节点（如 `ChainNode` / `ParallelNode`）会返回内部 children，表示“这些节点由我管理”

为了让拓扑更稳定，`Pipeline` 会把组合节点内部子图折叠成 **anchor**（ultimate owner）：

- 子节点的 ultimate anchor 是最外层组合节点
- 拓扑排序、启动/销毁顺序按 anchor 粒度执行

这样做可以避免内部 bridge 等实现细节污染整体依赖图。

## Pipeline 怎么用（推荐工作流）

### 1）创建节点并连线（wiring）

- 用 `register()` 把上游接到下游
- 用 `ChainNode/ParallelNode` 组织结构（它们内部也会做 wiring）

### 2）把“需要被管理的节点” add 到 Pipeline

推荐：**把参与 wiring 的上下游双方都 add()**，尤其是下游 consumer。

```ts
const pipeline = new Pipeline().add(consumer).add(producer);
```

`Pipeline` 会把 wiring 纳入拓扑：`producer.register(consumer)` 意味着 **consumer 必须先 start**。

### 3）start / dispose

```ts
await pipeline.start();
// ... run ...
await pipeline.dispose();
```

- `start()`：按拓扑顺序启动；中途失败会按已启动顺序逆序回滚 `dispose()`
- `dispose()`：按拓扑逆序销毁（dependents 先、providers 后），best-effort 释放资源

## Node 怎么写（业务侧最常写）

实现三个 hook：

- `onStart()`：初始化资源（连接/定时器/缓存等）
- `onReceive(msg)`：处理输入；必要时 `dispatch()` 输出
- `onDispose()`：释放资源

常用技巧：

- 用 `dispatchAt(data, time)` 让消息带上 event time（而不是处理时间）
- 如果你需要观测流量，在中间插入 `LogMiddlewareNode`

## 组合节点怎么用（串/并联）

### ChainNode（串联）

- `chain.node(a).node(b).node(c)` 形成顺序链
- 输入从 head 进入，输出在 tail 处通过内部 bridge 汇聚回 chain，再由 chain `dispatch` 给下游

### ParallelNode（并联分支）

- `parallel.node(branch1).node(branch2)` 并发投递同一输入
- 分支输出通过 bridge 汇聚，再由 parallel `dispatch` 给下游
- 默认 fire-and-forget：分支报错只会记录日志，不会中断其它分支

### ParallelProductNode（无输入并联聚合）

适用于多个 producer（如多个定时器）同时产出同一类型输出时的汇聚：

- 本节点不接收输入（`TIn=never`）
- 只负责启动/销毁 children，并将它们输出汇聚后向下游 `dispatch`

## 依赖编排（可选：按 class 声明）

当你希望 “某个节点必须在另一个节点之后启动 / 之前销毁” 时，可以在 class 上声明静态依赖（provider 先启动）：

```ts
class DbNode extends Node<never, DbClient> {
  protected async onStart() { /* connect */ }
  protected async onReceive() { throw new Error("no input"); }
  protected async onDispose() { /* close */ }
}

class QueryNode extends Node<Query, Result> {
  static dependency = { dependsOn: DbNode };
  protected async onStart() {}
  protected async onReceive(msg: Message<Query>) { /* ... */ }
  protected async onDispose() {}
}
```

- `static dependency = { dependsOn: SomeCtor }`
- `optional: true`：缺失 provider 时不报错

`Pipeline` 会在“被它管理的节点集合”中，为每个被引用的 ctor 找到 **唯一** provider 实例（同 ctor 出现多个实例会报错）。

## keepAlive（可选）

如果一个节点在依赖图中是“孤立的”（既没有 wiring 边，也没有被别人依赖），`Pipeline` 默认不会启动它。

你可以在 `add()` 时指定 `keepAlive: true` 强制启动其 anchor：

```ts
pipeline.add(someRoot, { keepAlive: true });
```

典型场景：独立定时器、metrics 上报、后台心跳等。

## 常见坑

- **只 add 了 producer 没 add consumer**：consumer 可能不会被 `Pipeline` 管理/启动。推荐把 wiring 两端都 `add()`。
- **运行时改结构**：例如 start 后再 `ChainNode.node()`；会被 `assertBuildTime` 阻止。
- **并行分支背压**：默认 fire-and-forget，没有内建背压；高吞吐场景建议自行做队列/限流/并发控制。

## API 速查（从包入口导入）

```ts
import {
  Node,
  Pipeline,
  ChainNode,
  ParallelNode,
  ParallelProductNode,
  ManualTriggerNode,
  CallbackSinkNode,
  LogMiddlewareNode,
  TimerProducerNode,
  TimeEmitterNode,
  TimeDualNode,
  type Message,
} from "@wofbi/pipeline";
```

## 运行环境

- Node.js `>=18`
