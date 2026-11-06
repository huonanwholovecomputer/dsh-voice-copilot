#!/usr/bin/env python3
"""把「打印机日志里的每一次出单」变成一条带标签的训练/评测样本。

为什么需要它：`learning/` 只记小印自己的对话，轮次极少，几乎不构成信号。
真正的 ground truth 在打印机日志里——每一单都天然带着「谁、什么时候、打了哪些文件」，
而台账（ledger.db）里同一批文件又带着「他当时说了什么」。两边按文件名 + 时间窗对齐，
就得到一条 `(顾客原话) → (正确文件)` 的样本，不需要人工标注。

用法：
    python tools/order_labels.py                     # 打统计 + 抽样
    python tools/order_labels.py --jsonl out.jsonl   # 同时落一份样本集
    python tools/order_labels.py --show 20           # 多看几条

设计原则：只读日志与台账，不写任何业务库；只用标准库；不联网。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from local_env import describe_missing, path_from  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
# 默认路径来自本机配置（环境变量 > tools/local_config.py），没有就是 None
DEFAULT_LOG_DIR = path_from('PRINTER_LOG_DIR', 'PRINTER_LOG_DIR')
DEFAULT_LEDGER = path_from('WECHAT_LEDGER', 'LEDGER_DB')

# 顾客在下单时真的会说的那几种句式（用于从 context 里挑出"请求句"）
REQUEST = re.compile(r'打印|打一下|打份|印一下|打出来|帮我打|打这个|打这|各\s*\d+\s*份|几份|双面|单面|正反')
# 台账里混进来的、不属于顾客请求的句子
NOISE = re.compile(r'计费明细|订单号:\s*HN|💰合计|张×|已同步|任务待处理')
# 寒暄/应答/系统提示：即使出现在 context 里也不是「这一单要什么」
ACK = re.compile(r'^(好的?|好|嗯+|哦+|OK|ok|行|收到|可以|在吗|稍等|谢谢|辛苦了?|'
                 r'\[表情\]|\[语音|我是群聊|吃饭ing|恭喜发财|发文件还是要先改呢)[。，,.!！?？~～]*$')

TS = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
BATCH_START = re.compile(r'共 (\d+) 个任务待处理')
BATCH_FILE = re.compile(r'\[\d+/(\d+)\]\s*(.+?)\s*$')

EXT = re.compile(r'\.(docx?|pdf|xlsx?|pptx?|zip|rar|7z|md|wps|jpg|jpeg|png|txt)$', re.I)


def norm_name(name: str) -> str:
    """去掉店主加工痕迹后用于比对：扩展名、[处理好的]、8_、下载计数 (1)、空白。"""
    text = EXT.sub('', name.strip())
    text = re.sub(r'^\[[^\]]*\]', '', text)
    text = re.sub(r'^\d+_', '', text)
    text = re.sub(r'\s*\(\d+\)', '', text)
    return re.sub(r'[\s\u3000]+', '', text)


def parse_logs(log_dir: Path) -> list[dict]:
    """一个批次 = 「共 N 个任务待处理」到下一个批次开始之间的文件清单。"""
    batches: list[dict] = []
    current: dict | None = None
    for path in sorted(glob.glob(str(log_dir / '2026-*.log'))):
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            for line in handle:
                stamp = TS.match(line)
                if not stamp:
                    continue
                when = stamp.group(1)
                if BATCH_START.search(line):
                    current = {'ts': when, 'files': [], 'faces': None, 'mode': None}
                    batches.append(current)
                    continue
                if current is None:
                    continue
                hit = BATCH_FILE.search(line)
                if hit:
                    current['files'].append(hit.group(2).strip())
                    continue
                if '手动双面批次' in line and current['mode'] is None:
                    current['mode'] = 'duplex'
                elif '单面' in line and current['mode'] is None and '批次' in line:
                    current['mode'] = 'simplex'
                if current['faces'] is None:
                    paper = re.search(r'→\s*(\d+)\s*张纸', line)
                    if paper:
                        current['faces'] = int(paper.group(1))
    return [b for b in batches if b['files']]


def epoch(text: str) -> int:
    return int(datetime.strptime(text, '%Y-%m-%d %H:%M:%S').timestamp())


def load_ledger(db: Path) -> tuple[dict, list[dict]]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        'SELECT chat_username, chat_name, sender, filename, create_time, context, msg_note, disk_state'
        ' FROM file_msgs')]
    conn.close()
    index: dict[str, list[dict]] = {}
    for row in rows:
        index.setdefault(norm_name(row['filename']), []).append(row)
    return index, rows


def pick_utterance(context: str, filename: str) -> str:
    """从 context 里挑出最像"这次下单时说的一句话"的那一段。

    context 是按时间排的 `A ｜ B ｜ C`，越靠后越接近实际下单时刻；但结尾常跟着计费回执，
    中间常夹着「好的」「嗯」这种应答——两者都不算请求。只认带打印动词的句子；
    一条都没有就返回空字符串（宁可没有样本，也不要造一条假样本）。
    """
    if not context:
        return ''
    segments = [seg.strip() for seg in context.split(' ｜ ') if seg.strip()]
    stem = norm_name(filename)[:6]
    best = ''
    for seg in segments:
        if NOISE.search(seg) or ACK.match(seg):
            continue
        if stem and stem in norm_name(seg):
            continue  # 这段就是文件名本身/回执
        if REQUEST.search(seg):
            best = seg  # 取最后一条：越靠后越接近实际下单时刻
    return best


def join_batch(batch: dict, index: dict, rows: list[dict]) -> tuple[dict | None, str]:
    """返回 (命中的台账行, 命中方式)。先精确文件名，再归一化文件名。"""
    start = epoch(batch['ts']) - 2 * 86400
    end = epoch(batch['ts']) + 3600
    for name in batch['files']:
        for row in rows:
            if row['filename'] == name and start <= row['create_time'] <= end:
                return row, 'exact'
    for name in batch['files']:
        for row in index.get(norm_name(name), []):
            if start <= row['create_time'] <= end:
                return row, 'normalized'
    return None, ''


def build(log_dir: Path, ledger: Path) -> tuple[list[dict], dict]:
    batches = parse_logs(log_dir)
    index, rows = load_ledger(ledger)
    samples: list[dict] = []
    stats = {'batches': len(batches), 'exact': 0, 'normalized': 0, 'unmatched': 0, 'with_utterance': 0}
    for batch in batches:
        row, how = join_batch(batch, index, rows)
        if row is None:
            stats['unmatched'] += 1
            continue
        stats[how] += 1
        utterance = pick_utterance(row['context'], row['filename'])
        if utterance:
            stats['with_utterance'] += 1
        samples.append({
            'orderTs': batch['ts'],
            'chat': row['chat_name'],
            'sender': row['sender'],
            'utterance': utterance,
            'files': batch['files'],
            'expectFile': row['filename'],
            'paper': batch['faces'],
            'join': how,
        })
    return samples, stats


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='把打印机日志对齐成 (原话 → 正确文件) 样本')
    parser.add_argument('--logs', default=str(DEFAULT_LOG_DIR or ''), help='打印机日志目录')
    parser.add_argument('--ledger', default=str(DEFAULT_LEDGER or ''), help='台账 ledger.db')
    parser.add_argument('--jsonl', default='', help='把样本集写到这个文件')
    parser.add_argument('--show', type=int, default=8, help='抽样打印几条')
    parser.add_argument('--json', action='store_true', help='统计以 JSON 输出')
    args = parser.parse_args(argv)

    if not args.logs:
        print(describe_missing('PRINTER_LOG_DIR', 'PRINTER_LOG_DIR'), file=sys.stderr)
        return 2
    if not args.ledger:
        print(describe_missing('WECHAT_LEDGER', 'LEDGER_DB'), file=sys.stderr)
        return 2

    log_dir = Path(args.logs)
    ledger = Path(args.ledger)
    if not log_dir.exists():
        print(f'找不到日志目录：{log_dir}', file=sys.stderr)
        return 2
    if not ledger.exists():
        print(f'找不到台账：{ledger}', file=sys.stderr)
        return 2

    samples, stats = build(log_dir, ledger)
    matched = stats['exact'] + stats['normalized']
    stats['matchRate'] = round(matched / stats['batches'], 3) if stats['batches'] else 0.0
    stats['utteranceRate'] = round(stats['with_utterance'] / matched, 3) if matched else 0.0

    if args.jsonl:
        out = Path(args.jsonl)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open('w', encoding='utf-8') as handle:
            for sample in samples:
                handle.write(json.dumps(sample, ensure_ascii=False) + '\n')
        stats['written'] = str(out)

    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 0

    print(f"日志批次 {stats['batches']} 个 → 对齐台账 {matched} 个（{stats['matchRate'] * 100:.1f}%）")
    print(f"  精确文件名 {stats['exact']} · 归一化 {stats['normalized']} · 未对上 {stats['unmatched']}")
    print(f"  其中能抽出顾客原话 {stats['with_utterance']} 条（{stats['utteranceRate'] * 100:.1f}%）")
    if args.jsonl:
        print(f"  样本集写入 {args.jsonl}")
    if samples and args.show:
        print(f'\n抽样（前 {args.show} 条）：')
        for sample in samples[:args.show]:
            said = sample['utterance'] or '（没留下原话）'
            print(f"  {sample['orderTs']} | {sample['chat']} | 「{said}」 → {sample['expectFile']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
