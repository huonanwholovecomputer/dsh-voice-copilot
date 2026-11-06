# -*- coding: utf-8 -*-
"""顾客身份解析 + 专业归属判定。

为什么需要这一层
----------------
同样一句「综测和成绩给我打一份」，对计科 2401 的人指向
`2024—2025学年计算机科学与技术专业成绩汇总表.xlsx` + `24级计科大一日综测排名表.xlsx`；
对电子 2402 的人指向完全不同的表。若小印不看身份就把计科的表推过去，
结果是「文件找到了、看着也对、但根本不是他要的那份」——比找不到更糟，因为顾客要重新解释一遍。

证据分级（只有 T1/T2 能定专业，T3 只作辅助）
------------------------------------------
（下列人名、学号、班号均为虚构示例，别当成真实台账。）

T1 显示名自带      计科2401张三 / 电子2402李四 / 数学2403王五
T1 班级群          计科2401班级群 / 计科2401助学金 / 计科2401团员群（只有本班能进）
T2 学号第 7 位     2499001xx → 2401 班；2499003xx → 2403 班
T2 文件名归属      计科2401张三-日志.doc / 李四-计科2403综合实训报告.docx
T3 社团群          智能机器人社 / E505睿抗 / 数学建模1队 → 全校混编，**禁止用来推专业**
T3 课程名          模拟电子技术实验 → 电子和计科都上，**禁止用来推专业**
"""
from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------- 词表

# (匹配词, 规范名)；长的放前面，避免「智能」抢走「人工智能」
MAJOR_WORDS: tuple[tuple[str, str], ...] = (
    ('计算机科学与技术', '计科'), ('计算机', '计科'), ('计科', '计科'),
    ('人工智能', '智能'), ('智能', '智能'),
    ('电子信息', '电子'), ('电子', '电子'),
    ('物联网', '物联'), ('物联', '物联'),
    ('数据科学', '数科'), ('数科', '数科'),
    ('软件工程', '软件'), ('软件', '软件'),
    ('通信工程', '通信'), ('通信', '通信'),
    ('轻化工程', '轻化'), ('轻化', '轻化'),
    ('数学', '数学'),
    ('机械', '机械'), ('自动化', '自动化'),
    ('网络工程', '网工'), ('网工', '网工'),
)

# 群名这两张表是**本机业务数据**（真实的群名会随人、随学期变），所以挪进了
# `tools/local_config.py`（不进仓库，模板见 `local_config.example.py`）。
# 缺失时退化成空表：班级群证据拿不到、混编群不复述，其余判定照常工作。
try:
    from local_config import CLASS_GROUPS, NEUTRAL_GROUPS, OWNER_NAMES
except Exception:  # pragma: no cover - 只在本机配置没建时触发
    CLASS_GROUPS: dict[str, tuple[str | None, str | None]] = {}
    NEUTRAL_GROUPS: frozenset[str] = frozenset()
    OWNER_NAMES: frozenset[str] = frozenset({
        '学长', '哥', '兄弟', '哥们', '帅哥', '老师', '老板',
    })

CLASS_RE = re.compile(r'(2[4-6])(\d{2})(?!\d)')
# 10 位学号：2499001017 = 24(年级) 9900(专业批次块) 1(班号末位) 017(班内序号)
# 第 7 位是班号末位——已用 3 条硬证据验证（示例学号为虚构值）：
#   2499001017 张三 → 文件名「计科2401张三-日志.doc」→ 2401
#   2499003044 李四 → 打印列表目录「计科2403李四」→ 2403
#   2499003033 王五 → 文件名「王五-计科2403综合实训报告.docx」→ 2403
SID_FULL_RE = re.compile(r'(2[4-6])(\d{4})(\d)(\d{3})')
# 文件名里「学号-姓名 / 学号姓名」
SID_NAME_RE = re.compile(r'(?<!\d)(2[4-6]\d{8})[\-\s_]?\s*([\u4e00-\u9fa5]{2,4})')

# 专业限定型材料的特征词（出现在文件名里就说明这份材料只属于某个专业/班级）
SCOPED_HINTS: tuple[str, ...] = (
    '计科', '智能', '电子', '物联', '数科', '数学', '软件', '通信', '轻化',
    '计算机科学与技术', '人工智能', '自动化', '机械', '网工',
)

# 「含专业词但其实不是专业」的陷阱词：课程名、竞赛名、社团名、学院名。
# 实测误判：`数学建模签到表（周一）.pdf`→数学、`模拟电子技术实验报告.docx`→电子、
# `数科院2025成绩`→数科（数科院是学院名，不是专业名）。这些一旦被判成专业限定，
# 身份闸会把全校人都挡在外面，所以先抹掉再解析。
TRAP_WORDS: tuple[str, ...] = (
    '数学建模',                      # 竞赛，全校都参加
    '模拟电子', '电子技术', '数字电子', '电子工艺', '电子设计',
    '电工电子', '电子电路', '模拟电路',
    '智能机器人', '智能车', '智能制造',
    '数科院',                        # 学院名（数据科学与工程学院），不是「数科」专业
    '计算机基础', '计算机应用基础',  # 公共课
)

# 班级周表（计科2401第八周日综测）——带班号就只属于那个班
WEEKLY_RE = re.compile(r'第[一二三四五六七八九十]+周')

# 「25级」「26级」这类年级标记：25 级表对 26 级的人同样不适用（同专业跨年级也会拿错表）
GRADE_RE = re.compile(r'(2[4-7])\s*级')


# ---------------------------------------------------------------- 解析

def _strip_traps(text: str) -> str:
    """抹掉「含专业词但不是专业」的陷阱片段，避免把课程/竞赛/学院名当专业。"""
    out = text
    for word in TRAP_WORDS:
        if word in out:
            out = out.replace(word, '\u0001')
    return out


def parse_major(text: str | None) -> tuple[str | None, str | None, list[str]]:
    """从任意字符串里抽 (专业, 班级, 证据)。班级来自 2[4-6]\\d{2} 形态的班号。"""
    if not text:
        return None, None, []
    major = None
    ev: list[str] = []
    probe = _strip_traps(text)
    for word, canon in MAJOR_WORDS:
        if word in probe:
            major = canon
            ev.append(f'含「{word}」')
            break
    klass = None
    m = CLASS_RE.search(text)
    if m:
        klass = m.group(1) + m.group(2)
        ev.append(f'班号 {klass}')
    return major, klass, ev


def parse_student_id(sid: str) -> dict[str, Any] | None:
    """学号 → 年级/班号。第 7 位是班号末位（2499001xx→2401，2499003xx→2403）。"""
    m = SID_FULL_RE.fullmatch(sid or '')
    if not m:
        return None
    grade, block, batch, seq = m.groups()
    return {
        'grade': grade,
        'block': grade + block,           # 249900
        'klass': f'{grade}{block[2]}{batch}',  # 24 + 0（专业块第 3 位）+ 1 → 2401
        'seq': seq,
    }


def build_id_name_map(rows: list[dict]) -> dict[str, dict]:
    """从文件名里的「学号-姓名」反推 学号→(姓名, 班号)。台账里学号是学校发的，比昵称可靠。"""
    out: dict[str, dict] = {}
    for row in rows:
        for sid, name in SID_NAME_RE.findall(row.get('filename') or ''):
            info = parse_student_id(sid)
            if info:
                out[sid] = {'name': name, **info}
    return out


def resolve_person(
    name: str,
    rows: list[dict],
    id_name_map: dict[str, dict] | None = None,
) -> dict[str, Any]:
    """解析一个人（会话名/发送人名）的身份，返回 major/klass/grade/conf/evidence。

    证据优先级：显示名(T1) > 班级群(T1) > 学号(T2) > 同名学号记录(T2)。
    社团群(T3) 刻意不参与 major 判定，只在 evidence 里留痕。
    """
    id_name_map = id_name_map or {}
    major, klass, ev = parse_major(name)
    conf = 2 if (major and klass) else (1 if (major or klass) else 0)
    grade = klass[:2] if klass else None

    groups: dict[str, int] = {}
    if rows:
        for row in rows:
            if row.get('is_group') and row.get('chat_name'):
                groups[row['chat_name']] = groups.get(row['chat_name'], 0) + 1

    # T1 班级群
    for gname, cnt in sorted(groups.items(), key=lambda x: -x[1]):
        info = CLASS_GROUPS.get(gname)
        if not info:
            continue
        gm, gk = info
        if gm and not major:
            major, conf = gm, max(conf, 1)
            ev.append(f'在班级群「{gname}」{cnt} 个文件')
        if gk and not klass:
            klass, conf = gk, max(conf, 1)
            grade = klass[:2]
            ev.append(f'在班级群「{gname}」{cnt} 个文件')

    # T2 学号：先看这个人发出的文件名里有没有学号；再看同名学号记录
    sids: set[str] = set()
    for row in rows or []:
        for sid in re.findall(r'(?<!\d)(2[4-6]\d{8})(?!\d)', row.get('filename') or ''):
            sids.add(sid)
    if not sids and name:
        for sid, info in id_name_map.items():
            if info.get('name') == name:
                sids.add(sid)
    if sids:
        sid = sorted(sids)[0]
        info = parse_student_id(sid)
        if info:
            if not klass:
                klass, grade = info['klass'], info['grade']
                conf = max(conf, 1)
                ev.append(f'学号 {sid}（班号 {info["klass"]}）')
            else:
                ev.append(f'学号 {sid}')

    # T3 留痕但不采信
    for gname, cnt in sorted(groups.items(), key=lambda x: -x[1]):
        if gname in NEUTRAL_GROUPS and cnt:
            ev.append(f'（不采信）在混编群「{gname}」')
            break

    return {
        'name': name, 'major': major, 'klass': klass, 'grade': grade,
        'conf': ['low', 'mid', 'high'][conf], 'evidence': ev,
    }


# ---------------------------------------------------------------- 文件专业归属

_PREFIX_RE = re.compile(r'^(\[[^\]]*\]|\d+_)')


def strip_prefix(filename: str | None) -> str:
    """去掉店主打过的加工前缀：`[处理好的]`、`[去高亮]`、`8_`。

    实测这批前缀会让「姓名-综测」这类个人专属识别失效
    （`[去高亮]张三-综测-横向-所有.pdf` 曾被判成「材料不限专业」）。
    """
    name = (filename or '').strip()
    while True:
        new = _PREFIX_RE.sub('', name)
        if new == name:
            return name
        name = new


def file_scope(filename: str | None) -> dict[str, Any]:
    """判断一份材料是否「专业/班级限定」。

    返回 {'scoped': bool, 'major': str|None, 'klass': str|None, 'reason': str}。
    scoped=True 表示这份材料只对某专业/某班的人有意义，跨专业不该推荐。
    """
    fn = strip_prefix(filename)
    # 个人专属优先判：`张三-综测-横向-所有.pdf` 这种带专业词也会被误判成专业限定，
    # 但它的第一约束是「这是张三个人的」，比专业更严。
    m = re.match(r'^([\u4e00-\u9fa5]{2,4})[\-\s_]+(?:日?综测|成绩)', fn)
    if m:
        return {'scoped': True, 'major': None, 'klass': None,
                'owner': m.group(1), 'reason': f'个人专属（{m.group(1)} 的综测/成绩）'}
    major, klass, ev = parse_major(fn)
    grade = None
    gm = GRADE_RE.search(fn)
    if gm:
        grade = gm.group(1)
    reason = ''
    if major:
        reason = f'文件名含专业「{major}」'
    elif klass:
        reason = f'文件名含班号「{klass}」'
    elif grade:
        reason = f'文件名限定 {grade} 级'
    elif WEEKLY_RE.search(fn):
        reason = '班级周报（周综测/周排名）'
    return {'scoped': bool(reason), 'major': major, 'klass': klass,
            'grade': grade, 'reason': reason}


def check_scope(person: dict, filename: str | None) -> dict[str, Any]:
    """判定「这个人要这份文件」是否专业匹配。

    返回 {'verdict': 'ok'|'mismatch'|'unknown'|'generic', 'note': str}
    - generic  ：文件不限定专业，谁都能要
    - ok       ：专业/班级一致
    - mismatch ：专业/班级/表主人明确不一致 → 必须追问，不许直接推
    - unknown  ：文件限定但这个人身份不明 → 允许候选，但要说明「不确定是不是你要的」
    """
    scope = file_scope(filename)
    if not scope.get('scoped'):
        return {'verdict': 'generic', 'note': '材料不限专业'}
    owner = scope.get('owner')
    if owner:
        me = person.get('name') or ''
        if owner in me or me in owner:
            return {'verdict': 'ok', 'note': f'是 {owner} 个人的表'}
        # 别人的个人表：不是「不确定」，是确定不是他的（真代打会自己说）
        return {'verdict': 'mismatch', 'note': f'这是 {owner} 个人的表，不是你的'}
    pm, pk = person.get('major'), person.get('klass')
    pg = person.get('grade')
    fm, fk = scope.get('major'), scope.get('klass')
    fg = scope.get('grade')
    if fm and pm and fm != pm:
        return {'verdict': 'mismatch',
                'note': f'这份是 {fm} 的，你是 {pm}，多半不是你要的'}
    if fk and pk and fk != pk and not fk.endswith('x'):
        return {'verdict': 'mismatch',
                'note': f'这份是 {fk} 班的，你是 {pk} 班'}
    if fg and pg and fg != pg:
        return {'verdict': 'mismatch',
                'note': f'这份是 {fg} 级的，你是 {pg} 级'}
    if (fm or fk or fg) and not (pm or pk or pg):
        what = fm or fk or (f'{fg} 级' if fg else '某个专业')
        return {'verdict': 'unknown',
                'note': f'这份看起来是 {what} 的，但还没确认你的专业'}
    return {'verdict': 'ok', 'note': '专业/班级一致'}


def is_owner_call(name: str) -> bool:
    """顾客是在叫店主（真实姓名与通用称呼都在 local_config.OWNER_NAMES 里），不是在指文件主人。"""
    n = (name or '').strip()
    return any(w in n for w in OWNER_NAMES)
