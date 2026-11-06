#!/usr/bin/env python3
"""找文件用的检索层（可复用，不依赖 MCP 进程）。

来源：`.tmp-analysis/funnel_v3.py` 里验证过的那套逻辑，抽成正式模块。
三处修正都是实测踩出来的，改之前请先读 EXPERIENCE.md 第 4 章：

1. **整串先搜，0 命中才拆词**。`示波器的`、`第二次线下作业` 整串本来就能命中，
   一律先拆词反而丢精度。
2. **先剔订单回执**。context 里混着「计费明细 / 订单号: HN… / 💰合计」，
   回执会把同一单打过的别的文件名抄进来，让无关文件被顶到第一。
3. **列加权**。文件名命中（6.0）远重于仅上下文命中（2.0）。

另外实现 EXPERIENCE.md 的 **Step 0 分流**：话里没有可检索内容词时（实测占 84%），
去同一会话的时间窗里取最近的文件，而不是拿「这个」去全库搜。

**身份闸（Step 5.5）**：顾客身份已知时，专业限定型材料（`计科2401第十一周日综测`、
`2025-2026学年数学专业成绩排名`）会按 `identity.check_scope()` 判定匹配度——
专业不符的候选被压到末尾，全部不符时 `stage='scoped_out'` 让人去问，而不是硬推一份看着像的。
实测依据：同一句「综测和成绩」，计科 2401 的人要的是计科成绩汇总+计科综测排名，
电子/智能/数学的人要的是完全不同的表；推错了比找不到更糟。

用法：
    from funnel import Funnel
    f = Funnel(r'D:/path/to/ledger.db')
    r = f.lookup('综测和成绩给我打一份', days=3)
    print(r.stage, r.tokens, [i.row['filename'] for i in r.candidates[:3]])
"""
from __future__ import annotations

import collections
import json
import re
import sqlite3
from pathlib import Path

try:  # 同目录的兄弟模块；缺失时功能自动降级，不影响关键词检索
    import identity as _identity
except Exception:  # pragma: no cover - 只在文件被单独搬走时触发
    _identity = None

# 列权重：文件名/别名里命中比上下文里命中可信得多
WEIGHTS = {
    'filename': 6.0,
    'alias': 6.0,
    'memo': 4.0,
    'msg_note': 4.0,
    'context': 2.0,
    'chat_name': 1.5,
    'sender': 1.5,
}

# 订单回执识别：含这些片段的 context 段整段剔除
RECEIPT = re.compile(r'(计费明细|订单号:\s*HN\d{8}-L?\d{4}|💰合计|张×|已同步|任务待处理)')

# 业务词典：顾客的说法 → 文件里真实可能出现的词（一个说法可以扩成多个检索词）
VOCAB = {
    '霍尔': ['霍尔'],
    '示波器': ['示波器'],
    '实验报告': ['实验报告'],
    '报告': ['报告'],
    '综测': ['综测'],
    '成绩': ['成绩'],
    '认定为': ['认定'],
    '认定': ['认定'],
    '贫困表': ['困难', '认定'],
    '困难表': ['困难', '认定'],
    '资助表': ['资助'],
    '助学金': ['助学金'],
    '励志': ['励志'],
    '奖学金': ['奖学金'],
    '申请书': ['申请书'],
    '附件2': ['附件2'],
    '附件3': ['附件3'],
    '附件5': ['附件5'],
    '医保': ['医保', '参保'],
    '参保': ['参保'],
    '签到': ['签到'],
    '作业': ['作业'],
    '物理': ['物理'],
    '实训': ['实训'],
    '高数': ['高等数学'],
    '高等数学': ['高等数学'],
    '论文': ['论文'],
    '第二次线下作业': ['第二次线下作业'],
    '第一次线下作业': ['第一次线下作业'],
    '静电场': ['静电场'],
    '预习': ['预习'],
}

# 学到的词（tools/learn_vocab.py 写，自动扩充）。内置 VOCAB 优先：
# 人的判断比统计更可靠，学到的词只是补充，不覆盖。
LEARNED_PATH = Path(__file__).resolve().parent / 'vocab_learned.json'


def _load_learned() -> dict:
    if not LEARNED_PATH.exists():
        return {}
    try:
        data = json.loads(LEARNED_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(key): list(value) if isinstance(value, list) else [str(value)]
        for key, value in data.items()
        if key and key not in VOCAB
    }


try:
    VOCAB = {**_load_learned(), **VOCAB}
except Exception:  # 词典坏了不能让检索整个挂掉
    pass

# 并列词断点：这些词前后是两个可以分别检索的主题
SPLITTERS = ('和', '跟', '还有', '以及', '、')

# 无信息词：剥掉这些之后还剩什么，决定走哪条分支
FILLER = re.compile(
    r'(那个|这个|这些|那些|那|这|的|了|吧|呢|嘛|吗|呀|啊|'
    r'帮我|给我|麻烦|一下|一份|两份|几份|打|打印|印|一份|份|'
    r'群里|群里头|昨天|前天|刚才|刚刚|上次|上次的|'
    r'学长|哥|兄弟|哥们|老师|师傅|老板)'
)

INTENT = re.compile(r'(打印|打一份|打一下|要交|上交|各一份|几份|收|印)')


class Hit:
    """一条候选：台账行 + 得分 + （可选）身份匹配判定。"""

    __slots__ = ('row', 'score', 'scope')

    def __init__(self, row: dict, score: float):
        self.row = row
        self.score = score
        self.scope: dict | None = None

    @property
    def filename(self) -> str:
        return self.row.get('filename') or ''

    def __repr__(self) -> str:
        return f'<Hit {self.score:.1f} {self.filename}>'


class Result:
    """一次检索的结果。stage 说明走的哪条分支，便于复盘。"""

    __slots__ = ('query', 'stage', 'tokens', 'candidates', 'total', 'tried', 'person', 'scope_note')

    def __init__(self, query, stage, tokens, candidates, total, tried,
                 person=None, scope_note=''):
        self.query = query
        self.stage = stage
        self.tokens = tokens
        self.candidates = candidates
        self.total = total
        self.tried = tried
        self.person = person
        self.scope_note = scope_note

    def __repr__(self) -> str:
        return f'<Result stage={self.stage} tokens={self.tokens} n={self.total}>'


def clean_context(context: str) -> str:
    """剔掉订单回执段——不剔的话回执里的文件名会把无关文件顶上来。"""
    if not context:
        return ''
    parts = [p for p in re.split(r'\s*｜\s*', context) if p]
    return ' '.join(p for p in parts if not RECEIPT.search(p))


def tokenize(query: str) -> list[str]:
    """业务词典最长匹配 + 并列词断开。返回去重后的检索词。"""
    text = (query or '').strip()
    for sep in SPLITTERS:
        text = text.replace(sep, '\u0001')
    keys = sorted(VOCAB, key=len, reverse=True)
    out: list[str] = []
    index = 0
    while index < len(text):
        if text[index] == '\u0001':
            index += 1
            continue
        matched = next((k for k in keys if text.startswith(k, index)), None)
        if matched:
            out.extend(VOCAB[matched])
            index += len(matched)
        else:
            index += 1
    seen: set[str] = set()
    unique: list[str] = []
    for token in out:
        if token not in seen:
            seen.add(token)
            unique.append(token)
    return unique


def has_content(query: str) -> bool:
    """Step 0 的分流闸：剥掉呼语/数量/参数/指示代词后，还剩不剩能搜的东西。"""
    if not query:
        return False
    return bool(tokenize(query))


class Funnel:
    def __init__(self, db_path: str):
        self.db_path = db_path
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        self.rows = [dict(r) for r in conn.execute('SELECT * FROM file_msgs')]
        conn.close()
        for row in self.rows:
            row['_ctx'] = clean_context(row.get('context') or '')
        self.now = max((r['create_time'] for r in self.rows), default=0)
        # 身份表：只算一次（按「谁在下单」聚合行后解析）
        self._people: dict[str, dict] = {}
        self._id_name_map: dict[str, dict] = {}
        if _identity is not None:
            try:
                self._id_name_map = _identity.build_id_name_map(self.rows)
                grouped: dict[str, list[dict]] = collections.defaultdict(list)
                for row in self.rows:
                    grouped[self._who(row)].append(row)
                for who, rs in grouped.items():
                    self._people[who] = _identity.resolve_person(who, rs, self._id_name_map)
            except Exception:  # 身份层坏了不影响检索
                self._people = {}

    @staticmethod
    def _who(row: dict) -> str:
        """谁在下单：私聊的 chat_name 就是对方本人，群聊的 sender 是发言人。"""
        return (row.get('chat_name') if not row.get('is_group') else row.get('sender')) or ''

    # ---------- 底层 ----------

    def _column_value(self, row: dict, column: str) -> str:
        if column == 'context':
            return row['_ctx']
        return row.get(column) or ''

    def _score_row(self, row: dict, token: str) -> float:
        best = 0.0
        for column, weight in WEIGHTS.items():
            if token in self._column_value(row, column):
                best = max(best, weight)
        return best

    def search_token(
        self,
        token: str,
        days: int | None = None,
        group_only: bool = False,
        until: int | None = None,
    ) -> list[Hit]:
        """单 token 检索。注意：台账 SQL 的多 token 是 AND，这里按 token 分别搜再合并。

        `until` 给的是「只能看到这个时刻之前的数据」，评测时必须传，
        否则会把下单之后才到的文件也算进候选，分数虚高。
        """
        hits: list[Hit] = []
        cutoff = (self.now - days * 86400) if days else None
        for row in self.rows:
            if group_only and not row.get('is_group'):
                continue
            if cutoff is not None and row['create_time'] < cutoff:
                continue
            if until is not None and row['create_time'] > until:
                continue
            score = self._score_row(row, token)
            if score > 0:
                hits.append(Hit(row, score))
        return hits

    def _recent_in_chat(self, chat_name: str, before: int, hours: int = 24, limit: int = 12) -> list[Hit]:
        """Step 0b：同一会话里、下单时间之前 N 小时内的文件，取「最后一波」。

        两个实测细节：
        1. 顾客「帮我们组打印一下」时一波发 6 个文件，时间戳常常在同一分钟。
           只回最近 3 条会把同批文件截掉，让人以为「他只要了这 3 个」。
        2. 一波的边界按 60 分钟算，不是按 60 秒。曾用 1 分钟试过，
           top3 只有 77.8%；放宽到 60 分钟升到 85.7%（再多就掉，会混进上一次的批）。
        3. 同一波内按 message_id 升序，跟顾客实际发的先后一致。
        """
        window = hours * 3600
        candidates = [
            row for row in self.rows
            if row.get('chat_name') == chat_name and before - window <= row['create_time'] <= before
        ]
        if not candidates:
            return []
        candidates.sort(key=lambda r: (r['create_time'], r.get('message_id') or 0), reverse=True)
        newest = candidates[0]['create_time']
        wave = [row for row in candidates if newest - row['create_time'] <= 3600]
        wave.sort(key=lambda r: r.get('message_id') or 0)
        picked = wave if len(wave) <= limit else wave[:limit]
        return [Hit(row, 10.0 - i) for i, row in enumerate(picked)]

    # ---------- 主入口 ----------

    def lookup(
        self,
        query: str,
        days: int | None = None,
        group_only: bool = False,
        chat_name: str | None = None,
        before: int | None = None,
        limit: int = 5,
        who: str | None = None,
    ) -> Result:
        """一句话 → 候选文件。

        `chat_name` + `before` 给了才可能走 Step 0b（会话内时间近邻）。
        `who` 是「谁在下单」，给了才做身份闸（Step 5.5）；不给就用 chat_name 兜底
        （私聊的会话名就是对方本人）。
        """
        before = before or self.now
        who = who or chat_name
        tried = []

        # Step 0 分流：话里没有可检索内容词 → 会话内时间近邻，不做全库关键词搜
        if not has_content(query):
            if chat_name:
                # 先看 24 小时内的；没有就放宽到 72 小时（实测有 30 小时才出单的情况），
                # 但要靠 stage 标出来，好让人知道这不是「刚发的那个」。
                for hours, stage in ((24, 'recent'), (72, 'recent72')):
                    recent = self._recent_in_chat(chat_name, before, hours=hours)
                    if recent:
                        return self._finish(Result(query, stage, [], recent, len(recent), tried), who, limit)
            return self._finish(Result(query, 'empty', [], [], 0, tried), who, limit)

        # Step 0.5 会话里刚好有一波文件 + 话里有两个以上主题词
        # → 这多半是在给那一整批「设参数 / 挑其中几份」
        # （实测原话：「申请书和贫困表都是双面打印，其他单面」→ 打的就是当时那批 4 个文件；
        #   「综测和成绩给我打一份」→ 打的就是他刚发的那两个）
        # 这时先看这波文件，谁对得上就排前面，别拿整句去全库搜。
        tokens = tokenize(query)
        if chat_name and len(tokens) >= 2:
            wave = self._recent_in_chat(chat_name, before, hours=1, limit=12)
            if len(wave) >= 2:
                scored = []
                for position, hit in enumerate(wave):
                    matched = sum(1 for token in tokens if self._score_row(hit.row, token) > 0)
                    if matched:
                        hit.score = matched * 10.0 + (len(wave) - position)
                        scored.append(hit)
                if scored:
                    scored.sort(key=lambda h: h.score, reverse=True)
                    return self._finish(Result(query, 'wave', tokens, scored, len(scored), tried), who, limit)

        # Step 1 整串先搜：很多原话整串本来就有命中，拆早了丢精度
        whole = self.search_token(query.strip(), days, group_only, until=before)
        tried.append((query.strip(), len(whole), 'whole'))
        if whole:
            return self._finish(
                Result(query, 'whole', [query.strip()], self._rank(whole, len(whole), before), len(whole), tried),
                who, limit,
            )

        # Step 2 0 命中才拆词，多路并发搜后合并
        tried.append((','.join(tokens), None, 'tokens'))
        merged: dict[str, Hit] = {}
        for token in tokens:
            for hit in self.search_token(token, days, group_only, until=before):
                key = hit.row['message_id']
                if key in merged:
                    merged[key].score += hit.score
                else:
                    merged[key] = Hit(hit.row, hit.score)
        combined = list(merged.values())
        if not combined and chat_name:
            recent = self._recent_in_chat(chat_name, before)
            if recent:
                return self._finish(Result(query, 'recent', tokens, recent, len(recent), tried), who, limit)
        return self._finish(
            Result(query, 'tokens', tokens, self._rank(combined, len(combined), before), len(combined), tried),
            who, limit,
        )

    def _finish(self, result: Result, who: str | None, limit: int) -> Result:
        """统一出口：过身份闸 → 截断 → 标注 scope 结论。

        身份闸放在所有分支之后，保证不管走哪条分支（whole/tokens/recent/wave）
        最后都会按「这个人是不是这个专业」重新排一次。
        """
        if not result.candidates:
            return result
        kept, info, note = self.apply_scope(list(result.candidates), who, limit)
        result.candidates = kept
        result.person = info.get('person')
        result.scope_note = note
        if kept and info.get('person') and info.get('mismatch') and not info.get('ok') and not info.get('unknown'):
            # 一个对得上的都没有：不硬推，让调用方去问
            result.stage = 'scoped_out'
        return result

    def _rank(self, hits: list[Hit], limit: int, now: int | None = None) -> list[Hit]:
        """加权排序 = 列权重 + 同一发送人扎堆加分 + 有下单意图加分 - 时间衰减。"""
        now = now or self.now
        sender_count = collections.Counter(hit.row.get('sender') for hit in hits)
        for hit in hits:
            hit.score += min(sender_count[hit.row.get('sender')], 6) * 1.5
            if INTENT.search(hit.row.get('_ctx') or ''):
                hit.score += 2.0
            hit.score -= max(0.0, (now - hit.row['create_time']) / 86400.0) * 0.6
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    # ---------- 身份闸 ----------

    def person_of(self, who: str | None) -> dict | None:
        """查一个人的身份；也接受会话名（私聊名 = 对方名）。"""
        if not who:
            return None
        if who in self._people:
            return self._people[who]
        # 允许模糊匹配（「小李」→「李晓明」）
        for name, person in self._people.items():
            if who and (who in name or name in who):
                return person
        return None

    def apply_scope(self, hits: list[Hit], who: str | None, limit: int) -> tuple[list[Hit], dict, str]:
        """身份闸：把专业不符的候选压下去。

        规则（对应 EXPERIENCE.md「身份」一节）：
          ok / generic  → 前移（+6 / +2）
          unknown       → 原位（材料限定但此人身份不明，只能提示，不能排除）
          mismatch      → 后移（-20）并在 scope 里标明原因
        全部 mismatch 且一个 ok 都没有时，返回 stage 提示用 `scoped_out`。

        为什么不直接过滤掉：顾客可能就是要帮外专业的人代打
        （实测有顾客替别的专业的同学打材料），硬删会把人拦住；
        压下 + 说明，让人一句话就能纠正，这是实测出来的分寸。
        """
        person = self.person_of(who)
        if person is None or _identity is None:
            return hits, {'person': None}, ''
        ok = mismatch = unknown = 0
        for hit in hits:
            verdict = _identity.check_scope(person, hit.filename)
            hit.scope = verdict
            v = verdict['verdict']
            if v == 'ok':
                hit.score += 6.0
                ok += 1
            elif v == 'generic':
                hit.score += 2.0
            elif v == 'unknown':
                unknown += 1
            else:  # mismatch
                hit.score -= 20.0
                mismatch += 1
        hits.sort(key=lambda h: h.score, reverse=True)
        info = {
            'person': {'name': person['name'], 'major': person['major'],
                       'klass': person['klass'], 'conf': person['conf']},
            'ok': ok, 'mismatch': mismatch, 'unknown': unknown,
        }
        note = ''
        if mismatch and not ok:
            note = '候选全跟你专业/班级对不上，多半不是你要的那份'
        elif mismatch:
            note = f'{mismatch} 份跟你专业对不上，已排到后面'
        elif unknown:
            note = '有材料限专业，但还没确认你的身份，请确认'
        return hits[:limit], info, note


def main(argv: list[str]) -> int:
    import argparse

    # 只给命令行用：本体被 MCP import 时不依赖本机配置。
    from local_env import describe_missing, path_from

    parser = argparse.ArgumentParser(description='按一句话找文件（调试用）')
    parser.add_argument('query', help='顾客原话')
    parser.add_argument('--db', default='', help='台账路径（默认取 WECHAT_LEDGER / local_config）')
    parser.add_argument('--days', type=int, default=0, help='只看最近 N 天')
    parser.add_argument('--chat', default='', help='限定会话名（走 Step 0b 时用）')
    parser.add_argument('--limit', type=int, default=5)
    args = parser.parse_args(argv)

    db = args.db or path_from('WECHAT_LEDGER', 'LEDGER_DB')
    if not db:
        parser.error(describe_missing('WECHAT_LEDGER', 'LEDGER_DB'))
    funnel = Funnel(str(db))
    result = funnel.lookup(args.query, days=args.days or None, chat_name=args.chat or None, limit=args.limit)
    print(f'stage={result.stage} tokens={result.tokens} total={result.total}')
    import datetime
    for hit in result.candidates:
        when = datetime.datetime.fromtimestamp(hit.row['create_time']).strftime('%m-%d %H:%M')
        print(f'  {hit.score:6.1f} | {when} | {hit.row["chat_name"][:18]:18s} | {hit.filename}')
    return 0


if __name__ == '__main__':
    import sys
    raise SystemExit(main(sys.argv[1:]))
