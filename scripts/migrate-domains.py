"""
迁移脚本：给存量记忆自动打 domain 标签（schema v14 之后运行）。

前置：DSH 已重启，插件已完成 v14 迁移（nodes 表有 domain 列）。
安全：写操作前自动备份；只改 domain 列，不动内容/状态/复习排期。
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

# 领域判定规则：(domain, 关键词)。按顺序匹配，先命中者胜。
# 顺序很重要：专有名词强的在前，泛化的在后。
RULES = [
    ("ue5", ["UE5", "UE 5", "虚幻", "Unreal", "uproject", "PythonScriptPlugin",
             "remote_execution", "K2Node", "蓝图", "BlueprintEditorUtils", "L4Builder",
             "SetStaticMesh", "FKismetEditorUtilities", "SCS 双根", "Actor 变换",
             "关卡", "RemoteControlAPI", "编辑器世界"]),
    ("uml", ["Enterprise Architect", "活动图", "顺序图", "用例图", "UML", ".qea",
             "SequenceNo", "PDATA", "组合片段", "教材订购系统", "t_connectorconstraint"]),
    ("datamining", ["数据挖掘", "爬虫", "PyMuPDF", "scrapy", "selenium",
                    "BeautifulSoup", "特征工程", "sklearn"]),
    ("ml", ["机器学习", "神经网络", "embedding 模型", "向量检索", "fine-tune",
            "transformers", "Hindsight", "Mem0", "记忆系统"]),
    ("dsh", ["dsh-", "DSH", "cordis", "engram_", "harness", "插件配置", "profile"]),
]

# 跨领域通用：工作方式偏好、工具选型铁律、记忆维护纪律
GENERAL_HINTS = [
    "用户要求", "用户偏好", "用户工作方式", "用户选装", "偏好：",
    "只装真实增量", "重大操作", "回答尽量简洁", "先联网", "winget",
    "披露偏好", "记忆维护", "闭环", "人机分工",
]


def classify(content):
    for hint in GENERAL_HINTS:
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

    # 备份
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
    for fname, scope in sorted(targets.items()):
        path = os.path.join(BASE, fname)
        if not os.path.exists(path):
            continue
        c = sqlite3.connect(path)
        cols = [r[1] for r in c.execute("PRAGMA table_info(nodes)")]
        if "domain" not in cols:
            print(f"[{fname}] 尚无 domain 列 —— 请先重启 DSH 让插件跑 v14 迁移")
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
    if apply:
        print(f"\n已写入 {changed} 条")
    else:
        print("\n[只读预览] 加 --apply 实际写入")


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
