#!/usr/bin/env python3
"""持续学习闭环的一键入口：刷新 → 造样本 → 评测 → 存基线 → 报变化。

这条命令是「这套经验模型能不能自己变好」的落点。它不训练模型权重，
做的是三件能持续累积的事：

1. **把每次真实出单变成一条带标签样本**（`order_labels.py`），不需要人工标注；
2. **用历史样本给检索层打分**（`eval_funnel.py`），分数存在 `tools/learn_state.json`；
3. **报告这次比上次好还是坏**——改词典/改权重/改时间窗，跑这一条就知道。

为什么不能只靠 learning/：小印自己的对话记录目前只有 7 轮（`python
tools/learning_report.py --json` 可复核），不构成统计信号。真正的 ground truth
在打印机日志里——每一次出纸天然带「谁、何时、打了哪些文件」。

用法：
    python tools/learn_loop.py                    # 只跑评测，跟上次比
    python tools/learn_loop.py --refresh          # 先刷新台账（需要微信后端在跑）
    python tools/learn_loop.py --rebuild-samples  # 重新从日志造样本
    python tools/learn_loop.py --history          # 看历次成绩
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from local_env import describe_missing, path_from  # noqa: E402

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
STATE_PATH = TOOLS / 'learn_state.json'
SAMPLES_PATH = REPO / '.tmp-analysis' / 'order-samples.jsonl'
LEDGER = path_from('WECHAT_LEDGER', 'LEDGER_DB')
PYTHON = sys.executable


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {'history': []}
    try:
        data = json.loads(STATE_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {'history': []}
    data.setdefault('history', [])
    return data


def save_state(state: dict) -> None:
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def run_tool(script: str, *args: str) -> tuple[int, str]:
    proc = subprocess.run(
        [PYTHON, str(TOOLS / script), *args],
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        cwd=str(REPO),
    )
    return proc.returncode, (proc.stdout or '') + (proc.stderr or '')


def refresh_ledger(depth: int = 200) -> tuple[bool, str]:
    """刷新台账。需要 WeChatDataAnalysis 后端在跑（GET 127.0.0.1:10392/api/health）。"""
    bridge = path_from('WECHAT_BRIDGE_DIR', 'WECHAT_BRIDGE_DIR')
    if bridge is None:
        return False, describe_missing('WECHAT_BRIDGE_DIR', 'WECHAT_BRIDGE_DIR')
    if LEDGER is None:
        return False, describe_missing('WECHAT_LEDGER', 'LEDGER_DB')
    sys.path.insert(0, str(bridge))
    try:
        import ledger  # type: ignore
    except Exception as exc:
        return False, f'导不进 ledger.py：{exc}'
    try:
        eng = ledger.Ledger(str(LEDGER))
        stats = eng.refresh(depth=depth)
    except Exception as exc:
        return False, str(exc)
    if not stats.get('ok'):
        return False, f'刷新失败：{stats.get("errors")}'
    return True, (f'刷新完成：会话 {stats.get("sessions")}、'
                  f'文件 {stats.get("files_seen")}、耗时 {stats.get("elapsed_s")}s')


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='持续学习闭环：刷新→造样本→评测→报变化')
    parser.add_argument('--refresh', action='store_true', help='先刷新台账（需要微信后端）')
    parser.add_argument('--depth', type=int, default=200)
    parser.add_argument('--rebuild-samples', action='store_true', help='重新从日志造样本')
    parser.add_argument('--topk', type=int, default=3)
    parser.add_argument('--days', type=int, default=7)
    parser.add_argument('--history', action='store_true', help='只看历史记录')
    args = parser.parse_args(argv)

    state = load_state()

    if args.history:
        rows = state.get('history', [])
        if not rows:
            print('还没有历史记录，先跑一次 learn_loop.py')
            return 0
        print(f'{"时间":<20}{"样本":>5}{"top1":>8}{"topK":>8}{"召回":>8}  说明')
        for row in rows:
            print(f'{row["at"]:<20}{row["total"]:>5}{row["top1Rate"]:>7.1%}'
                  f'{row["topkRate"]:>8.1%}{row["batchRate"]:>8.1%}  {row.get("note", "")}')
        return 0

    steps: list[str] = []

    if args.refresh:
        ok, message = refresh_ledger(args.depth)
        print(f'[刷新] {message}')
        steps.append(message)
        if not ok:
            print('  ↳ 台账没刷新成功，后面用的是旧数据（样本里的「数据缺口」会变多）')

    if args.rebuild_samples:
        code, output = run_tool('order_labels.py', '--jsonl', str(SAMPLES_PATH))
        print('[造样本] ' + (output.strip().splitlines()[-1] if output.strip() else '无输出'))
        steps.append(f'order_labels exit={code}')
        if code != 0:
            print(output)
            return 1

    if not SAMPLES_PATH.exists():
        print(f'没有样本文件 {SAMPLES_PATH}，先跑 --rebuild-samples')
        return 1

    code, output = run_tool('eval_funnel.py', '--topk', str(args.topk), '--days', str(args.days))
    print('[评测]')
    print(output.rstrip())
    if code != 0:
        return 1

    # 从评测输出里取指标（比再跑一遍 evaluate 省一次全表加载）
    import re

    metrics: dict = {}
    for line in output.splitlines():
        line = line.strip()
        if line.startswith('可评测样本'):
            metrics['total'] = int(line.split()[1])
        elif line.startswith('单文件口径'):
            found = re.findall(r'(\d+\.\d+)%', line)
            if len(found) >= 2:
                metrics['top1Rate'] = float(found[0]) / 100
                metrics['topkRate'] = float(found[1]) / 100
        elif line.startswith('整批口径'):
            found = re.findall(r'(\d+\.\d+)%', line)
            if found:
                metrics['batchRate'] = float(found[-1]) / 100
        elif line.startswith('数据缺口'):
            metrics['gap'] = line
    if 'top1Rate' not in metrics:
        print('没解析出指标，评测输出格式变了？')
        return 1

    previous = state['history'][-1] if state['history'] else None
    print('[对比上次]')
    if previous:
        for key, label in (('top1Rate', 'top1'), ('topkRate', f'top{args.topk}'), ('batchRate', '整批召回')):
            old, new = previous.get(key, 0), metrics.get(key, 0)
            delta = new - old
            arrow = '→' if abs(delta) < 0.0005 else ('↑' if delta > 0 else '↓')
            print(f'  {label:<8} {old:.1%} → {new:.1%}  {arrow} {delta:+.1%}')
        if previous.get('total') != metrics.get('total'):
            print(f'  样本数 {previous.get("total")} → {metrics.get("total")}'
                  '（样本变了，分数不能直接比）')
    else:
        print('  首次运行，这次就是基线。')

    state['history'].append({
        'at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        **metrics,
        'note': '；'.join(steps)[:120],
    })
    state['history'] = state['history'][-60:]
    save_state(state)
    print(f'\n已记入 {STATE_PATH}（共 {len(state["history"])} 次）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
