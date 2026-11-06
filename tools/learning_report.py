#!/usr/bin/env python3
"""把小印的学习记录（learning/）汇总成一份可读的复盘摘要。

用法：
    python tools/learning_report.py                 # 默认读仓库根目录 learning/
    python tools/learning_report.py --dir D:/x/learning --days 7
    python tools/learning_report.py --json          # 输出 JSON，便于别的脚本消费

设计原则：只读，不修改记录；不联网；只用标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    with path.open('r', encoding='utf-8', errors='replace') as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def load_records(root: Path, since: datetime | None) -> tuple[list[dict], list[dict]]:
    turns, notes = [], []
    for folder, sink in (('turns', turns), ('notes', notes)):
        directory = root / folder
        if not directory.exists():
            continue
        for path in sorted(directory.glob('*.jsonl')):
            try:
                day = datetime.strptime(path.stem, '%Y-%m-%d')
            except ValueError:
                continue
            if since and day < since:
                continue
            sink.extend(read_jsonl(path))
    turns.sort(key=lambda row: row.get('startedAt') or 0)
    notes.sort(key=lambda row: row.get('at') or 0)
    return turns, notes


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * ratio))))
    return ordered[index]


def summarize(turns: list[dict], notes: list[dict]) -> dict:
    tool_stats: dict[str, dict] = defaultdict(lambda: {'calls': 0, 'failures': 0, 'ms': []})
    durations, thinking_chars, answer_chars = [], [], []
    interrupted = 0
    per_day = Counter()

    for turn in turns:
        if turn.get('durationMs'):
            durations.append(turn['durationMs'])
        thinking_chars.append(sum(item.get('chars') or len(item.get('text') or '') for item in turn.get('thinking') or []))
        answer_chars.append(turn.get('answerChars') or len(turn.get('answer') or ''))
        if turn.get('interrupted'):
            interrupted += 1
        started = turn.get('startedAt')
        if started:
            per_day[datetime.fromtimestamp(started / 1000).strftime('%Y-%m-%d')] += 1
        for tool in turn.get('tools') or []:
            name = tool.get('name') or '?'
            stat = tool_stats[name]
            stat['calls'] += 1
            if tool.get('ok') is False:
                stat['failures'] += 1
            if isinstance(tool.get('ms'), (int, float)):
                stat['ms'].append(tool['ms'])

    # 连续两次以上用同一个工具且后一次失败，算一次「重试仍失败」的痕迹
    retry_failures = 0
    for turn in turns:
        tools = [tool for tool in turn.get('tools') or [] if tool.get('name')]
        for previous, current in zip(tools, tools[1:]):
            if previous['name'] == current['name'] and current.get('ok') is False:
                retry_failures += 1

    tools = []
    for name, stat in sorted(tool_stats.items(), key=lambda item: -item[1]['calls']):
        calls = stat['calls']
        tools.append({
            'name': name,
            'calls': calls,
            'failures': stat['failures'],
            'failureRate': round(stat['failures'] / calls, 3) if calls else 0.0,
            'p50ms': int(percentile(stat['ms'], 0.5)),
            'p95ms': int(percentile(stat['ms'], 0.95)),
        })

    kinds = Counter(note.get('kind') for note in notes)
    severities = Counter(note.get('severity') for note in notes)

    return {
        'turns': len(turns),
        'sessions': len({turn.get('sessionId') for turn in turns if turn.get('sessionId')}),
        'tools': sum(stat['calls'] for stat in tool_stats.values()),
        'toolFailures': sum(stat['failures'] for stat in tool_stats.values()),
        'interrupted': interrupted,
        'retryFailures': retry_failures,
        'durationMs': {
            'p50': int(percentile(durations, 0.5)),
            'p95': int(percentile(durations, 0.95)),
            'max': int(max(durations)) if durations else 0,
        },
        'thinkingChars': {'total': sum(thinking_chars), 'avg': int(sum(thinking_chars) / len(thinking_chars)) if thinking_chars else 0},
        'answerChars': {'total': sum(answer_chars), 'avg': int(sum(answer_chars) / len(answer_chars)) if answer_chars else 0},
        'perDay': dict(sorted(per_day.items())),
        'toolTable': tools,
        'notes': {'total': len(notes), 'kinds': dict(kinds), 'severities': dict(severities)},
        'noteList': notes[-20:],
        'slowTurns': [
            {
                'turn': turn.get('turn'),
                'sessionId': turn.get('sessionId'),
                'startedAt': turn.get('startedAt'),
                'durationMs': turn.get('durationMs'),
                'steps': turn.get('steps'),
                'tools': len(turn.get('tools') or []),
                'user': (turn.get('user') or '')[:60],
            }
            for turn in sorted(turns, key=lambda row: -(row.get('durationMs') or 0))[:5]
        ],
        'hints': build_hints(turns, tools, notes),
    }


def build_hints(turns: list[dict], tools: list[dict], notes: list[dict]) -> list[str]:
    hints = []
    for tool in tools:
        if tool['calls'] >= 5 and tool['failureRate'] >= 0.25:
            hints.append(f"{tool['name']} 失败率 {tool['failureRate']:.0%}（{tool['failures']}/{tool['calls']}）：先看参数约定和错误文案，再考虑换实现。")
        if tool['calls'] >= 3 and tool['p95ms'] >= 20000:
            hints.append(f"{tool['name']} p95 耗时 {tool['p95ms']} ms：考虑加超时、改成后台 job、或减少一次调用的工作量。")
    long_thinking = [turn for turn in turns if sum(len(item.get('text') or '') for item in turn.get('thinking') or []) > 6000]
    if len(long_thinking) >= 3:
        hints.append(f'{len(long_thinking)} 轮思考超过 6000 字：检查系统提示词是否塞了太多流程，或把长任务拆成脚本。')
    repeated = Counter((note.get('kind'), note.get('title')) for note in notes)
    for (kind, title), count in repeated.items():
        if count >= 3:
            hints.append(f'「{title}」（{kind}）已记 {count} 次：这个问题没被真正解决，值得改提示词或工具。')
    if not hints:
        hints.append('没有明显异常；继续积累样本再看。')
    return hints


def abbreviate_names(names: list[str]) -> dict[str, str]:
    """压掉一组长名字的共同前缀（如 `mcp__某个服务__`），否则表格里全被截成同一个名字。"""
    if not names:
        return {}
    unique = sorted(set(names))
    labels = {}
    for name in unique:
        # 只在「有兄弟」的名字上压：跟最像的那个比，取公共前缀里最后一个 __ 之后
        shared = max(
            (len(os.path.commonprefix([name, other])) for other in unique if other != name),
            default=0,
        )
        boundary = name.rfind('__', 0, shared) if shared else -1
        cut = boundary + 2 if boundary >= 0 else 0
        if cut < 8:  # 共同前缀太短，压掉也不省地方
            cut = 0
        labels[name] = f'…{name[cut:]}' if cut else name
    return labels


def format_report(summary: dict, since: datetime | None) -> str:
    lines = []
    scope = f'自 {since:%Y-%m-%d}' if since else '全部记录'
    lines.append(f'小印学习复盘（{scope}）')
    lines.append('=' * 46)
    lines.append(f"会话 {summary['sessions']} 个 / 轮次 {summary['turns']} / 工具调用 {summary['tools']} 次（失败 {summary['toolFailures']}）")
    lines.append(f"中途中断 {summary['interrupted']} 轮 / 重试后仍失败 {summary['retryFailures']} 次")
    duration = summary['durationMs']
    lines.append(f"每轮耗时 p50 {duration['p50'] / 1000:.1f}s / p95 {duration['p95'] / 1000:.1f}s / 最长 {duration['max'] / 1000:.1f}s")
    lines.append(f"思考字数 共 {summary['thinkingChars']['total']} / 平均 {summary['thinkingChars']['avg']}；回复字数 平均 {summary['answerChars']['avg']}")
    if summary['perDay']:
        lines.append('每天轮次：' + '，'.join(f'{day} {count}' for day, count in summary['perDay'].items()))

    lines.append('')
    lines.append('工具表现')
    lines.append('-' * 46)
    if summary['toolTable']:
        labels = abbreviate_names([tool['name'] for tool in summary['toolTable']])
        lines.append(f"{'工具':<22}{'调用':>5}{'失败':>6}{'失败率':>8}{'p50':>9}{'p95':>9}")
        for tool in summary['toolTable']:
            lines.append(
                f"{labels[tool['name']][:21]:<22}{tool['calls']:>5}{tool['failures']:>6}"
                f"{tool['failureRate'] * 100:>7.0f}%{tool['p50ms']:>9}{tool['p95ms']:>9}"
            )
    else:
        lines.append('（还没有工具调用记录）')

    lines.append('')
    lines.append('最慢的几轮')
    lines.append('-' * 46)
    for turn in summary['slowTurns']:
        when = datetime.fromtimestamp(turn['startedAt'] / 1000).strftime('%m-%d %H:%M') if turn.get('startedAt') else '?'
        lines.append(f"{when} 第 {turn['turn']} 轮 {turn['durationMs'] / 1000:.1f}s / {turn['steps']} 步 / {turn['tools']} 次工具 / {turn['user']}")

    lines.append('')
    lines.append(f"小印自记的问题（{summary['notes']['total']} 条）")
    lines.append('-' * 46)
    if summary['noteList']:
        for note in summary['noteList']:
            when = datetime.fromtimestamp(note['at'] / 1000).strftime('%m-%d %H:%M') if note.get('at') else '?'
            lines.append(f"{when} [{note.get('severity')}/{note.get('kind')}] {note.get('title')}")
            detail = (note.get('detail') or '').replace('\n', ' ')
            if detail:
                lines.append(f'    {detail[:160]}')
    else:
        lines.append('（还没有）')

    lines.append('')
    lines.append('值得动手的地方')
    lines.append('-' * 46)
    for hint in summary['hints']:
        lines.append(f'- {hint}')
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='汇总小印的学习记录')
    parser.add_argument('--dir', default=os.environ.get('LEARNING_DIR', str(REPO_ROOT / 'learning')), help='learning 目录')
    parser.add_argument('--days', type=int, default=0, help='只看最近 N 天（默认全部）')
    parser.add_argument('--json', action='store_true', help='输出 JSON')
    args = parser.parse_args(argv)

    root = Path(args.dir).expanduser().resolve()
    if not root.exists():
        print(f'没有找到学习记录目录：{root}', file=sys.stderr)
        return 2

    since = datetime.now() - timedelta(days=args.days) if args.days > 0 else None
    if since:
        since = since.replace(hour=0, minute=0, second=0, microsecond=0)
    turns, notes = load_records(root, since)
    summary = summarize(turns, notes)

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(format_report(summary, since))
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main(sys.argv[1:]))
