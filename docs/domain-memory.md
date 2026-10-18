# 领域记忆（Domain Memory）设计说明

> 本 fork（`shanshuifeng/dsh-engram-memory`）在上游 `kenz1117/dsh-engram` 0.9.0 基础上，
> 增加了 **知识领域维度（schema v14）** 与 **会话注入的领域门控**，用于个人多方向专业知识库。

## 一、解决什么问题

上游 engram 只有两个正交维度：

- `scope`：存在哪个宫殿（user / project / shared）
- `kind`：是什么类型（fact / preference / decision / episode / skill）

当记忆开始覆盖多个**知识方向**（UE5、数据挖掘、ML……）时，缺一个维度会导致两个具体后果：

1. **检索无法按方向收窄**——搜「配置」会同时命中引擎配置和数据管道配置。
2. **注入无法按方向门控**——所有高 importance 条目在每个会话都会被注入，
   不相干方向持续挤占上下文（长上下文的注意力会被稀释，这是记忆系统准确率下降的主因之一）。

`domain` 就是补上的第三个维度。

## 二、核心语义

| 值 | 含义 | 是否参与门控 |
|---|---|---|
| `general`（或 NULL / 空串） | 跨方向通用知识（用户工作方式、跨域铁律） | **否**，始终注入 |
| 任意方向名（`ue5` / `datamining` / `ml` …） | 该方向的专业知识 | 是，仅命中时注入 |

**关键设计决定：`general` 永远不会被领域过滤掉。** 如果把它也过滤掉，
「用户要求先联网核实」这类跨域偏好会在任何领域检索里消失——那是比上下文浪费更严重的问题。

## 三、三级门控

```
L0 常驻   general 领域条目 + curated profile + 复习提示     ~2KB   每会话
L1 目录   各领域 INDEX（名称 + 条目数 + mission）           一行/域  每会话
L2 内容   命中领域的记忆正文                                按需    命中时
```

- **L0**：跨域通用，规模受 `profileTopN` 与 `injectTokenBudget` 约束。
- **L1**：只告知「存在哪些方向」，不注入内容——模型据此知道自己可以深入。
- **L2**：只有触发词命中时才进上下文。

### 门控判定

`src/domain-gate.ts` 的 `gateDomains()` 做**确定性关键词匹配**（不调用额外 LLM）：

- 大小写不敏感；
- **全 ASCII 且长度 < 3 的触发词要求词边界**（避免 `ml` 命中 `html`、`ue` 命中 `queue`）；
- 中文触发词按子串匹配（中文无词边界）；
- 命中任一触发词即激活该领域，并记录命中依据（可解释性）。

判定失败时的降级：不激活任何领域 → 只注入 general + 目录行；
模型仍可用 `engram_search` 的 `domains` 参数显式拉取任意方向。

## 四、领域注册表

`<dbDir>/domains.json`，人工可编辑、随库备份、可被 git 管理：

```json
{
  "version": 1,
  "domains": [
    {
      "name": "ue5",
      "mission": "虚幻引擎：编辑器自动化、蓝图、Python 通道",
      "triggers": ["ue5", "虚幻", "蓝图", "uproject", "PythonScriptPlugin"]
    }
  ]
}
```

- 文件缺失/损坏 → 返回空注册表，功能降级但不阻塞（目录行仍靠实库统计展示）。
- 注册表只提供 mission 与触发词；条目数由实库 `domainCounts()` 实时聚合。

## 五、配置

```yaml
- id: dsh-engram
  name: '@kenz1117/dsh-engram'
  config:
    domainGating: true   # 默认 false = 与升级前行为完全一致
```

`domainGating: false` 时：注入走 `topActive()` 全量按 importance 取，
不附加目录行，注入文本 hash 与升级前一致。**默认关闭是为了升级零风险。**

## 六、工具变化

| 工具 | 变化 |
|---|---|
| `engram_save` | 新增 `domain` 参数（缺省 = general） |
| `engram_search` | 新增 `domains` 数组参数（general 条目始终返回） |
| `engram_update` | `domain` 缺省继承旧条目 |
| `engram_domain` | **新增**：`stats` 清点 / `register` 登记方向 / `retag` 单条改方向 |

## 七、数据库迁移（v13 → v14）

```sql
ALTER TABLE nodes ADD COLUMN domain TEXT;
CREATE INDEX IF NOT EXISTS nodes_domain ON nodes (domain, status);
```

**存量条目一律置 NULL（= general），迁移不猜测分类。**
含义：升级后注入行为与升级前完全一致，分类是显式的、可审计的动作
（人工 retag 或保存时带 domain），不存在「升级悄悄改了你的记忆组织」的情况。

## 八、实现清单

| 文件 | 作用 |
|---|---|
| `src/types.ts` | `EngramDomain`、`GENERAL_DOMAIN`、`isGeneralDomain`；`MemoryRecord`/`WriteInput`/`SearchQuery`/`ListFilter`/`UpdateInput` 加 domain |
| `src/domain-gate.ts` | 触发词匹配、门控判定、L1 目录渲染 |
| `src/domain-registry.ts` | domains.json 读写、注册表与实库统计合并 |
| `src/store/sqlite.ts` | v14 迁移、插入/读回、`domainCond()` 检索收窄、`topActiveByDomain`、`setDomain`、`domainCounts` |
| `src/config.ts` | `domainGating` 配置 |
| `src/index.ts` | preStep 门控分支 + 目录行注入 |
| `src/tools/create.ts` | save/search 的 domain 参数、`engram_domain` 工具 |
| `tests/domain.spec.ts` | 21 个测试覆盖写入/门控/收窄/注册表 |

## 九、验证状态

- 构建：`pnpm run bundle` 通过
- 测试：`445 passed`（与改动前基线一致）+ `21 passed`（新增 domain 测试）
- 已知环境性失败（与本改动无关）：`migration-policy.spec.ts` 2 条 Windows 路径断言、
  `composition.spec.ts` 1 个 suite 需完整 harness 挂载
