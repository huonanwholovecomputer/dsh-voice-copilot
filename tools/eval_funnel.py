#!/usr/bin/env python3
"""用真实出单样本评测找文件能力（回归 + 后续调参的裁判）。

样本来自 `tools/order_labels.py`：每一行都是一次真实出单，
`utterance` 是顾客当时说的原话，`expectFile` 是最后真的打出来的文件。
这里让 `tools/funnel.py` 只看下单那一刻之前的数据去猜，猜中就算对。

用法：
    python tools/eval_funnel.py                       # 默认读 .tmp-analysis/order-samples.jsonl
    python tools/eval_funnel.py --samples x.jsonl --topk 3 --show 20

两个口径：
- `top1` 第一个就是期望文件（真机上顾客只看到第一个，最重要）
- `topK` 前 K 个里有（对应「念两三个让顾客选」的兜底）

一单打多个文件时（实测 34/72 的单是如此），期望文件只是那批里抽出来的一个，
所以额外统计 **整批命中**：前 K 个里出现该单任意一个文件就算这条原话被理解了。
这是更贴近业务的判定——顾客说「帮我们组打印一下」时，六个文件本来就是一整批。
另外按 stage 分组统计，用来判断是「分流」拖后腿还是「检索」拖后腿。

`evaluate()` 是给 `tools/learn_loop.py` 复用的函数入口，返回 dict 而不是打印。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import funnel as funnel_mod  # noqa: E402
from order_labels import norm_name  # noqa: E402
from local_env import describe_missing, path_from  # noqa: E402

DEFAULT_SAMPLES = Path('.tmp-analysis/order-samples.jsonl')
# 台账默认路径来自本机配置（环境变量 > tools/local_config.py），没有就是 None
DEFAULT_LEDGER = path_from('WECHAT_LEDGER', 'LEDGER_DB')


def load_samples(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def to_ts(text: str) -> int:
    return int(datetime.datetime.strptime(text, '%Y-%m-%d %H:%M:%S').timestamp())


def evaluate(
    samples: list[dict],
    ledger_path: str | Path = DEFAULT_LEDGER,
    topk: int = 3,
    days: int = 7,
    include_empty: bool = False,
) -> dict:
    """跑一遍评测，返回指标与明细。不打印任何东西。"""
    if not include_empty:
        samples = [s for s in samples if s.get('utterance')]
    if not samples:
        raise ValueError('没有可用样本')

    engine = funnel_mod.Funnel(str(ledger_path))
    known = {norm_name(row['filename'] or '') for row in engine.rows}

    # 两类数据缺口，不算模型能力问题，单独计数：
    #   1. 下单时间晚于台账最后一次刷新 → 那批文件根本没进台账
    #   2. 这批文件在台账里压根不存在（日志对齐上了，台账没索引到）
    stale = [s for s in samples if to_ts(s['orderTs']) > engine.now]
    samples = [s for s in samples if to_ts(s['orderTs']) <= engine.now]
    absent = [s for s in samples if norm_name(s.get('expectFile') or '') not in known]
    samples = [s for s in samples if norm_name(s.get('expectFile') or '') in known]

    top1 = topk_hit = batch_hit = batch_top1 = 0
    by_stage: collections.Counter = collections.Counter()
    by_stage_hit: collections.Counter = collections.Counter()
    details = []
    coverage_whole = coverage_part = coverage_n = 0

    for sample in samples:
        expect = sample.get('expectFile') or ''
        batch = set(sample.get('files') or []) or {expect}
        result = engine.lookup(
            sample['utterance'],
            days=days or None,
            chat_name=sample.get('chat'),
            before=to_ts(sample['orderTs']),
            limit=max(topk, 12),
            who=sample.get('sender') or sample.get('chat'),
        )
        names = [hit.filename for hit in result.candidates]
        norm_expect = norm_name(expect)
        norm_batch = {norm_name(name) for name in batch}
        rank = next((i for i, name in enumerate(names, 1) if norm_name(name) == norm_expect), None)
        batch_rank = next((i for i, name in enumerate(names, 1) if norm_name(name) in norm_batch), None)
        by_stage[result.stage] += 1
        if rank == 1:
            top1 += 1
        if rank and rank <= topk:
            topk_hit += 1
            by_stage_hit[result.stage] += 1
        if batch_rank == 1:
            batch_top1 += 1
        if batch_rank:
            batch_hit += 1

        # 「这一批文件有没有被整批端上来」——多文件单能否直接照单念出去
        if len(norm_batch) > 1:
            coverage_n += 1
            returned = {norm_name(name) for name in names}
            if norm_batch <= returned:
                coverage_whole += 1
            elif norm_batch & returned:
                coverage_part += 1

        details.append({
            'ok': bool(rank and rank <= topk),
            'rank': rank,
            'batchRank': batch_rank,
            'stage': result.stage,
            'tokens': list(result.tokens or []),
            'utterance': sample['utterance'],
            'chat': sample.get('chat'),
            'orderTs': sample['orderTs'],
            'expectFile': expect,
            'candidates': names,
            'batch': sorted(batch),
        })

    total = len(samples)
    return {
        'top1': top1,
        'topk': topk_hit,
        'batchTop1': batch_top1,
        'batchHit': batch_hit,
        'total': total,
        'topkK': topk,
        'days': days,
        'stale': len(stale),
        'absent': len(absent),
        'byStage': dict(by_stage),
        'byStageHit': dict(by_stage_hit),
        'coverageWhole': coverage_whole,
        'coveragePart': coverage_part,
        'coverageN': coverage_n,
        'details': details,
        'vocabSize': len(funnel_mod.VOCAB),
    }


def print_report(metrics: dict, show: int = 0, topk: int | None = None) -> None:
    topk = topk or metrics['topkK']
    total = metrics['total']
    days = metrics['days']
    print(f'时间窗 {"不限" if not days else f"{days} 天"}')
    print(f'数据缺口（不计入）：台账未刷新 {metrics["stale"]} 条、台账无此文件 {metrics["absent"]} 条')
    print(f'可评测样本 {total} 条')
    print(f'单文件口径  top1 {metrics["top1"]}/{total} = {metrics["top1"] / total:.1%}'
          f'   top{topk} {metrics["topk"]}/{total} = {metrics["topk"] / total:.1%}')
    print(f'整批口径    top1 {metrics["batchTop1"]}/{total} = {metrics["batchTop1"] / total:.1%}'
          f'   召回 {metrics["batchHit"]}/{total} = {metrics["batchHit"] / total:.1%}')
    cov_n = metrics['coverageN']
    if cov_n:
        whole, part = metrics['coverageWhole'], metrics['coveragePart']
        print(f'多文件单整批召回（批次>1 的 {cov_n} 条）：整批端上来 {whole}/{cov_n} = {whole / cov_n:.1%}，'
              f'至少含一个 {whole + part}/{cov_n} = {(whole + part) / cov_n:.1%}')
    print(f'-- 按 stage 分组（单文件口径 top{topk}）--')
    for stage, count in sorted(metrics['byStage'].items(), key=lambda kv: -kv[1]):
        hit = metrics['byStageHit'].get(stage, 0)
        print(f'  {stage:9s} 样本 {count:3d}  命中 {hit:3d} = {hit / count:.1%}')

    if show:
        print('-- 明细（fail 优先） --')
        ordered = sorted(metrics['details'], key=lambda d: (d['ok'], d['rank'] or 999))
        for detail in ordered[:show]:
            mark = 'OK  ' if detail['ok'] else 'MISS'
            print(f'[{mark}] rank={detail["rank"]} 批次内第{detail["batchRank"]}个 '
                  f'stage={detail["stage"]} 批次{len(detail["batch"])}个文件')
            print(f'       原话：{detail["utterance"]}')
            print(f'       期望：{detail["expectFile"]}')
            norm_expect = norm_name(detail['expectFile'])
            norm_batch = {norm_name(name) for name in detail['batch']}
            for i, name in enumerate(detail['candidates'][:12], 1):
                if norm_name(name) == norm_expect:
                    flag = '*'
                elif norm_name(name) in norm_batch:
                    flag = '~'
                else:
                    flag = ' '
                print(f'         {i}{flag} {name}')


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='评测 funnel 在真实出单上的命中率')
    parser.add_argument('--samples', default=str(DEFAULT_SAMPLES))
    parser.add_argument('--ledger', default=str(DEFAULT_LEDGER or ''))
    parser.add_argument('--topk', type=int, default=3)
    parser.add_argument('--days', type=int, default=7, help='检索时间窗（0 = 不限）')
    parser.add_argument('--show', type=int, default=0, help='打印前 N 条明细')
    parser.add_argument('--all', action='store_true', help='连没有原话的样本也算进来（多数会记为 empty）')
    args = parser.parse_args(argv)

    if not args.ledger:
        print(describe_missing('WECHAT_LEDGER', 'LEDGER_DB'), file=sys.stderr)
        return 2

    samples = load_samples(Path(args.samples))
    metrics = evaluate(
        samples,
        ledger_path=args.ledger,
        topk=args.topk,
        days=args.days,
        include_empty=args.all,
    )
    print_report(metrics, show=args.show, topk=args.topk)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
