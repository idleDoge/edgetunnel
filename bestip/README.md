# bestip — 实测优选 IP（probe → score → select）

> 2026-10-10 复核：本目录保留为实验代码，已撤除 `_worker.js` 中的接入和 Cron。
> 当前探测器仅判断 TCP 建连，不能证明 TLS、协议认证或实际转发成功；其评分不能作为节点 alive 的验收依据。
> Workers 内部测速不能代表客户端运营商线路，入口与反代也不能共用 CF 入口候选池。
> 真实请求回写尚未接入。下文描述此前实验设计，生产订阅使用上游原生 `ADD.txt` / 外部优选机制。

为 edgetunnel 增加"**测量 → 评分 → 优选 → 刷新**"闭环，取代上游仅靠"CIDR 内随机散列"的伪优选。目标：**低延迟 + 稳定优先**。

## 与上游的区别

| | 上游 edgetunnel | 本 fork bestip |
| --- | --- | --- |
| 节点来源 | CIDR 内随机散列 + 聚合外部列表 | 同样的候选池，但**主动拨测后按质量排序** |
| 质量信号 | 无；建连竞速结果用完即弃 | RTT / 失败率 / 抖动 / colo，历史**指数衰减**评分 |
| 刷新 | 无定时 | Cron 每 20 分钟再优选 |
| 真实请求 | 成败被浪费 | 被动回写评分（零额外拨测成本） |

## 架构（依赖全部注入，核心可独立单测）

```
bestip/src/
  core.js          评分模型：summarize/scoreNode/rankNodes/mergeObservations（纯逻辑）
  prober.js        主动拨测：probeOne/probeBatch + candidatesFromCIDR
  store-kv.js      KV 持久化（entry/proxy 隔离）
  orchestrator.js  闭环编排：CIDR→拨测→合并→评分→写 KV；selectBest/reportOutcome
  worker-bridge.js Worker 运行时适配：fetchCIDRs、connect 注入、scheduledRun
```

入口/反代两类链路分别存储：`bestip.observations.json`（entry）与 `bestip.proxy.observations.json`（proxy）。

## 评分

- 延迟分（RTT 越低越高）、稳定分（失败惩罚权重最重 2.5）、抖动分、亚洲 colo 加分。
- 历史观测按 **6 小时半衰期**指数衰减；样本少或全失败时置信度压分，避免一次侥幸拿高分。

## Worker 接入（最小侵入）

- `_worker.js` 默认导出新增 `scheduled` handler；`wrangler.toml` 加 `[triggers] crons=["*/20 * * * *"]`。
- 订阅本地生成时前置实测节点；反代解析 `解析地址端口` 前置实测反代。
- 手动触发（需登录面板）：`GET /admin/bestip-run?isp=cf|cmcc&kind=entry|proxy`。

## 配置（环境变量，均可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BESTIP_USE_MEASURED` | 开 | 置 `0` 关闭订阅实测前置，回到纯随机 |
| `BESTIP_MIN_SCORE` | 20 | 入选门槛 |
| `BESTIP_CMCC` | 关 | 置 `1` 定时按移动 CIDR 文件探测 |

## 部署注意

- Cron 仅 **Workers** 支持；Pages Functions 无 scheduled，需要把本 worker 部署为 Worker（绑定同一 KV）。
- 需绑定 `env.KV`，否则定时任务报缺绑定。

## 测试

```bash
cd bestip && node --test test/
```
