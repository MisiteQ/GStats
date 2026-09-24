# -*- coding: utf-8 -*-
"""二分定位 fnpack 对 wizard 文件校验失败的元素。

方法：逐个把原 wizard/install 的 items 拆成单步/单项变体，
在临时目录构建，观察 fnpack 输出。
"""
import json
import os
import shutil
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FNPACK = os.path.join(ROOT, ".tools", "fnpack.exe")
SRC = os.path.join(ROOT, "fnos")

original = json.load(open(os.path.join(SRC, "wizard", "install"), encoding="utf-8"))


def build_ok(wizard_obj):
    tmp = tempfile.mkdtemp(prefix="fpkwiz-")
    try:
        dest = os.path.join(tmp, "fnos")
        shutil.copytree(SRC, dest)
        with open(os.path.join(dest, "wizard", "install"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(wizard_obj, f, ensure_ascii=False, indent=2)
        r = subprocess.run(
            [FNPACK, "build", "--directory", dest],
            cwd=tmp, capture_output=True, text=True, timeout=120,
        )
        out = (r.stdout or "") + (r.stderr or "")
        return "Packing successfully" in out, out.replace("\r", " ").strip()[:200]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


print("== 原始文件 ==", "PASS" if build_ok(original)[0] else "FAIL")

print("\n== 单步（原样复制某一步）==")
for i, step in enumerate(original):
    ok, out = build_ok([step])
    print(f"step{i} '{step.get('stepTitle')}' -> {'PASS' if ok else 'FAIL ' + out}")

print("\n== 单项（每项单独成步）==")
for i, step in enumerate(original):
    for j, item in enumerate(step["items"]):
        ok, out = build_ok([{"stepTitle": "S", "items": [item]}])
        tag = item.get("type") + ":" + str(item.get("field", item.get("helpText", "?"))[:30])
        print(f"step{i}.{j} {tag} -> {'PASS' if ok else 'FAIL ' + out}")
