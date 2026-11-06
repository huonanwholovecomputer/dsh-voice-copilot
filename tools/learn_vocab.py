#!/usr/bin/env python3
"""从真实出单样本里「学词」：顾客怎么称呼材料 → 实际文件名里长什么样。

这是持续学习闭环里的**词表自动扩充**那一步。它做的事很窄但很关键：
在「顾客原话」和「最后真打出来的文件名」之间找**字面重叠的片段**，
挑出还没被 `funnel.VOCAB` 覆盖的，作为候选新词。

为什么只认字面重叠：这是唯一不需要人工判断、也不会学错的做法。
「他说的词真的出现在文件名里」= 硬证据；靠语义猜出来的词（比如把
「那个霍尔的报告」映射到「第二次线下作业」）没有任何字面依据，
自动学就一定会学歪——那种只能靠人写进 EXPERIENCE.md。

用法：
    python tools/learn_vocab.py                       # 看候选
    python tools/learn_vocab.py --write               # 合并进 tools/vocab_learned.json
    python tools/learn_vocab.py --split 0.5           # 只用前 50% 样本学（后 50% 留作评测）

学到的词写进 `tools/vocab_learned.json`，`funnel.py` 启动时自动加载。
内置 VOCAB 优先级更高（学到的词不能覆盖人的判断）。
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import funnel as funnel_mod  # noqa: E402
from order_labels import norm_name  # noqa: E402
from local_env import describe_missing, path_from  # noqa: E402

DEFAULT_SAMPLES = Path('.tmp-analysis/order-samples.jsonl')
LEARNED_PATH = Path(__file__).resolve().parent / 'vocab_learned.json'
# 台账默认路径来自本机配置（环境变量 > tools/local_config.py），没有就是 None
DEFAULT_LEDGER = path_from('WECHAT_LEDGER', 'LEDGER_DB')

# 学词时要剥掉的东西：呼语、数量、参数、客套、指示代词（跟 funnel.FILLER 同源，
# 但更狠——这些词出现在文件名里纯属巧合，学进去只会污染检索）
NOISE_WORDS = (
    '那个', '这个', '这些', '那些', '群里', '群', '昨天', '前天', '今天', '刚刚', '刚才',
    '学长', '哥', '兄弟', '哥们', '老师', '师傅', '老板', '麻烦', '帮我', '给我', '帮忙',
    '打印', '打一下', '打一份', '打份', '印一下', '出来', '一下', '一份', '两份', '几份',
    '双面', '单面', '正反', '正反面', '各一份', '谢谢', '辛苦', '可以', '能不能', '多少钱',
    '多少', '怎么', '什么', '那个的', '我的', '你的', '还有', '以及', '然后', '在吗',
)

PUNCT = re.compile(r'[\s，。、！？!?,.~～:：；;"\'“”‘’()（）\[\]【】]+')
CJK = re.compile(r'[\u4e00-\u9fff]')

MIN_LEN, MAX_LEN = 2, 6
MIN_SUPPORT = 2          # 至少被 2 条不同的样本支持，才认为是稳定说法


def is_useful_term(term: str) -> bool:
    """纯数字/纯字母/年份这类「字面上重合但没有任何检索价值」的片段，一律不要。

    实测踩过：台账上下文里挖出的头号候选是「2026」（因为一堆文件名叫
    「2026陕西省…申请表」）。把它当词加进去，只会让每条查询都命中一大堆无关文件。
    """
    if not CJK.search(term):
        return False
    if term.isdigit():
        return False
    return True


def clean(text: str) -> str:
    text = PUNCT.sub('', text or '')
    for word in sorted(NOISE_WORDS, key=len, reverse=True):
        text = text.replace(word, '\u0001')
    return text


def longest_common(text: str, target: str) -> str:
    """两串的最长公共子串（字符级）。只认字面重叠，是唯一不会学歪的证据。"""
    if not text or not target:
        return ''
    best_len = 0
    best_end = 0
    prev = [0] * (len(target) + 1)
    for i in range(1, len(text) + 1):
        cur = [0] * (len(target) + 1)
        for j in range(1, len(target) + 1):
            if text[i - 1] == target[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best_len:
                    best_len = cur[j]
                    best_end = i
        prev = cur
    return text[best_end - best_len:best_end]


def trim_connectors(term: str) -> str:
    """削掉两端把两个词连起来的虚字：「霍尔效应及」→「霍尔效应」。"""
    edges = '及的和与等在于对为'
    while term and term[-1] in edges:
        term = term[:-1]
    while term and term[0] in edges:
        term = term[1:]
    return term


def ngrams(text: str, low: int = MIN_LEN, high: int = MAX_LEN) -> set[str]:
    out: set[str] = set()
    for chunk in text.split('\u0001'):
        for size in range(low, min(high, len(chunk)) + 1):
            for start in range(0, len(chunk) - size + 1):
                out.add(chunk[start:start + size])
    return out


def mine(samples: list[dict], min_support: int = MIN_SUPPORT) -> tuple[list[dict], dict]:
    """返回 (候选词列表, 统计)。

    做法：每条样本取「顾客原话」与「实际文件名」的最长公共子串，削掉连接虚字；
    然后**按原话文本去重**统计支持数——同一句话被重复抽到 10 次，也只算 1 条证据。
    最后把「是更长候选的子串、且支持数不更高」的碎片丢掉（只留最长的那层）。
    """
    covered = set()
    for keys in funnel_mod.VOCAB.values():
        covered.update(keys)
    covered.update(funnel_mod.VOCAB)

    support: dict[str, set[str]] = collections.defaultdict(set)   # 词 → 出现它的原话集合
    total_with_utterance = 0

    for sample in samples:
        utterance = sample.get('utterance') or ''
        expect = sample.get('expectFile') or ''
        if not utterance or not expect:
            continue
        total_with_utterance += 1
        target = norm_name(expect).lower()
        if not target:
            continue
        for chunk in clean(utterance).lower().split('\u0001'):
            term = trim_connectors(longest_common(chunk, target))
            if len(term) < MIN_LEN or len(term) > MAX_LEN:
                continue
            if not is_useful_term(term):
                continue
            if term in covered:
                continue
            support[term].add(utterance.strip())

    candidates = []
    for term, utterances in support.items():
        if len(utterances) < min_support:
            continue
        candidates.append({'term': term, 'support': len(utterances)})

    # 只留最长的那个：若 A 是 B 的子串且 B 支持数不低，A 就是碎片
    kept = []
    for item in candidates:
        redundant = any(
            item is not other
            and item['term'] in other['term']
            and other['support'] >= item['support']
            and len(other['term']) > len(item['term'])
            for other in candidates
        )
        if not redundant:
            kept.append(item)

    kept.sort(key=lambda c: (-c['support'], -len(c['term']), c['term']))
    stats = {
        'samples': len(samples),
        'withUtterance': total_with_utterance,
        'vocabSize': len(funnel_mod.VOCAB),
        'candidates': len(kept),
    }
    return kept, stats


def mine_context(
    ledger_path: str | Path,
    min_support: int = MIN_SUPPORT,
    days: int = 90,
) -> tuple[list[dict], dict]:
    """从台账自带的「聊天上下文 → 文件名」里学词（比出单样本多两个数量级的数据）。

    为什么需要这条：真实下单原话里 84% 根本不含内容词（EXPERIENCE.md 第 2 章），
    靠出单样本学词几乎没有信号——实测 50 条训练样本只挖出 0 个支持度≥2 的词。
    但台账每行 file_msgs 都带 context（群公告、同学讨论），那里才有真正的材料说法。

    证据强度弱于出单样本：上下文里提到某个词，不等于顾客就是这么说才打它的。
    所以这里学到的词只当**召回扩展**（多搜一路），不当排序依据。
    """
    import sqlite3

    conn = sqlite3.connect(str(ledger_path))
    conn.row_factory = sqlite3.Row
    cutoff = None
    if days:
        newest = conn.execute('SELECT MAX(create_time) AS t FROM file_msgs').fetchone()
        if newest and newest['t']:
            cutoff = int(newest['t']) - days * 86400
    sql = 'SELECT filename, context, create_time FROM file_msgs WHERE context IS NOT NULL AND context != ""'
    rows = [dict(r) for r in conn.execute(sql)]
    conn.close()

    covered = set()
    for keys in funnel_mod.VOCAB.values():
        covered.update(keys)
    covered.update(funnel_mod.VOCAB)

    support: dict[str, set[str]] = collections.defaultdict(set)
    scanned = 0
    for row in rows:
        if cutoff and (row.get('create_time') or 0) < cutoff:
            continue
        target = norm_name(row.get('filename') or '').lower()
        if not target:
            continue
        context = funnel_mod.clean_context(row.get('context') or '')
        if not context:
            continue
        for raw in re.split(r'\s*｜\s*', context):
            segment = raw.strip()
            if len(segment) < 2:
                continue
            scanned += 1
            for chunk in clean(segment).lower().split('\u0001'):
                term = trim_connectors(longest_common(chunk, target))
                if len(term) < 3 or len(term) > MAX_LEN:
                    continue
                if not is_useful_term(term):
                    continue
                if term in covered:
                    continue
                support[term].add(segment)

    candidates = [{'term': t, 'support': len(s)} for t, s in support.items() if len(s) >= min_support]
    kept = []
    for item in candidates:
        redundant = any(
            item is not other
            and item['term'] in other['term']
            and other['support'] >= item['support']
            and len(other['term']) > len(item['term'])
            for other in candidates
        )
        if not redundant:
            kept.append(item)
    kept.sort(key=lambda c: (-c['support'], -len(c['term']), c['term']))
    stats = {
        'samples': len(rows),
        'segments': scanned,
        'vocabSize': len(funnel_mod.VOCAB),
        'candidates': len(kept),
    }
    return kept, stats


def load_learned(path: Path = LEARNED_PATH) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def save_learned(mapping: dict, path: Path = LEARNED_PATH) -> None:
    path.write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='从真实业务数据里学新词')
    parser.add_argument('--samples', default=str(DEFAULT_SAMPLES))
    parser.add_argument('--ledger', default=str(DEFAULT_LEDGER or ''))
    parser.add_argument('--source', choices=('orders', 'context', 'both'), default='both',
                        help='orders=出单原话（强证据、太少）；context=台账上下文（弱证据、量大）')
    parser.add_argument('--split', type=float, default=0.0,
                        help='只用前 N 比例的样本学词（其余留作评测，避免自欺）')
    parser.add_argument('--min-support', type=int, default=MIN_SUPPORT)
    parser.add_argument('--top', type=int, default=30)
    parser.add_argument('--write', action='store_true', help='写进 tools/vocab_learned.json')
    args = parser.parse_args(argv)

    from eval_funnel import load_samples

    candidates: list[dict] = []
    stats: dict = {}

    if args.source in ('orders', 'both'):
        samples = [s for s in load_samples(Path(args.samples)) if s.get('utterance')]
        samples.sort(key=lambda s: s['orderTs'])
        if args.split and 0 < args.split < 1:
            cut = max(1, int(len(samples) * args.split))
            train, holdout = samples[:cut], samples[cut:]
        else:
            train, holdout = samples, []
        order_candidates, order_stats = mine(train, min_support=args.min_support)
        print(f'[出单原话] 学习集 {len(train)} 条（留出 {len(holdout)} 条用于评测）'
              f' → 候选 {order_stats["candidates"]} 个')
        for item in order_candidates[:args.top]:
            print(f'  {item["support"]:3d} 条支持 | {item["term"]}')
        candidates.extend(order_candidates)
        stats['orders'] = order_stats

    if args.source in ('context', 'both'):
        ctx_candidates, ctx_stats = mine_context(
            args.ledger, min_support=max(3, args.min_support))
        print(f'[台账上下文] 扫描 {ctx_stats["samples"]} 行 / {ctx_stats["segments"]} 段'
              f' → 候选 {ctx_stats["candidates"]} 个')
        for item in ctx_candidates[:args.top]:
            print(f'  {item["support"]:3d} 段支持 | {item["term"]}')
        candidates.extend(ctx_candidates)
        stats['context'] = ctx_stats

    print(f'当前词典 {len(funnel_mod.VOCAB)} 条说法')

    if args.write and candidates:
        mapping = load_learned()
        added = 0
        for item in candidates:
            term = item['term']
            if term in mapping:
                continue
            mapping[term] = [term]
            added += 1
        save_learned(mapping)
        print(f'已写入 {LEARNED_PATH}：新增 {added} 条，累计 {len(mapping)} 条')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
