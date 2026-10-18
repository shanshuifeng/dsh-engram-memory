"""
迁移脚本：给存量记忆自动打 domain 标签（schema v14 之后运行）。

前置：DSH 已重启，插件已完成 v14 迁移（nodes 表有 domain 列）。
安全：写操作前自动备份；只改 domain 列，不动内容/状态/复习排期。

分类策略（两阶段，避免泛化线索吞掉明确领域）：
1. 强通用信号：工作方式类偏好（跨域适用）——优先级最高，因为这类内容
   常含「插件」「记忆」等会把它们拖进某个方向的词。
2. 领域规则：专有名词/技术术语命中。
3. 兜底 general：宁可留在常驻层，也不误分到不会激活的方向。
"""
import sqlite3
import os
import glob
import sys
import io
import shutil
from datetime import datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = r"C:\Users\Administrator\.dsh\engram"

# 强通用信号：出现即判 general，且优先于领域规则。
# 只收「明确是跨域工作方式」的短语，不收「用户要求」「用户偏好」这类泛化开头。
STRONG_GENERAL = [
    "用户工作方式", "用户选装", "只装真实增量", "重大操作（装插件",
    "回答尽量简洁", "先联网查询", "不允许凭记忆瞎猜",
    "winget 安装", "披露偏好", "记忆维护节奏", "人机分工",
    "浏览器时区", "所在时区", "未标明时区",
]

# 领域规则：(domain, 关键词)。术语越专有越靠前。
RULES = [
    ("ue5", ["UE5", "UE 5", "虚幻", "Unreal", "uproject", "PythonScriptPlugin",
             "remote_execution", "K2Node", "蓝图", "BlueprintEditorUtils", "L4Builder",
             "SetStaticMesh", "FKismetEditorUtilities", "SCS 双根", "Actor 变换",
             "RemoteControlAPI", "编辑器世界", "关卡"]),
    ("uml", ["Enterprise Architect", "活动图", "顺序图", "用例图", "UML", ".qea",
             "SequenceNo", "PDATA", "组合片段", "教材订购系统", "t_connectorconstraint"]),
    ("datamining", ["爬虫", "scrapy", "selenium", "BeautifulSoup", "特征工程",
                    "sklearn", "数据清洗", "数据集移入", "PyMuPDF"]),
    ("ml", ["机器学习", "神经网络", "向量检索", "embedding 模型", "fine-tune",
            "transformers", "Hindsight", "Mem0", "记忆系统"]),
    ("dsh", ["DSH", "dsh-", "cordis", "engram_", "harness", "profile 安装",
             "插件安装", "MCP", "workbuddy"]),
]


def classify(content):
    for hint in STRONG_GENERAL:
        if hint in content:
            return "general", f"通用:{hint}"
    low = content.lower()
    for domain, kws in RULES:
        for kw in kws:
            if kw.lower() in low:
                return domain, kw
    return "general", "未命中"


def main(apply=False):
    targets = {"user.db": "user", "shared.db": "shared"}
    for p in glob.glob(os.path.join(BASE, "project-*.db")):
        targets[os.path.basename(p)] = "project"

    if apply:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        bak = os.path.join(BASE, f"pre-domain-migration-{ts}")
        os.makedirs(bak, exist_ok=True)
        for f in glob.glob(os.path.join(BASE, "*.db")):
            shutil.copy2(f, bak)
        print(f"已备份数据库到 {bak}\n")

    total = 0
    changed = 0
    dist = {}
    skipped = []
    for fname, scope in sorted(targets.items()):
        path = os.path.join(BASE, fname)
        if not os.path.exists(path):
            continue
        c = sqlite3.connect(path)
        cols = [r[1] for r in c.execute("PRAGMA table_info(nodes)")]
        if "domain" not in cols:
            skipped.append(fname)
            c.close()
            continue
        rows = c.execute(
            "SELECT id, kind, content FROM nodes WHERE status='active'").fetchall()
        if not rows:
            c.close()
            continue
        print("=" * 70)
        print(f"[{fname}] scope={scope} active={len(rows)}")
        for nid, kind, content in rows:
            d, why = classify(content)
            dist[d] = dist.get(d, 0) + 1
            total += 1
            mark = ""
            if apply:
                c.execute("UPDATE nodes SET domain=? WHERE id=?", (d, nid))
                changed += 1
                mark = " [已写]"
            print(f"  {d:12s} <- {why:20s} | {kind:9s} | {content[:52]!r}{mark}")
        if apply:
            c.commit()
        c.close()

    print("=" * 70)
    print("领域分布：")
    for d, n in sorted(dist.items(), key=lambda kv: -kv[1]):
        print(f"  {d:12s} {n}")
    print(f"  合计 {total}")
    if skipped:
        print(f"\n未迁移（仍是 v13，将在首次访问时自动升级）：{', '.join(skipped)}")
    if apply:
        print(f"\n已写入 {changed} 条")
    else:
        print("\n[只读预览] 加 --apply 实际写入")


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
