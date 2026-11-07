# -*- coding: utf-8 -*-
"""DSH 配方库（v0.8.2）—— 把「参数组合」变成可保存、可套用、可分发的资产。

灵感来自 lurenjia-l/dsh-blender-stylized-shading 的「配方化」优点：它把自然语言风格词翻译成节点组参数组合并写成手册；
本模块把它通用化为**与领域无关**的机制：任意 JSON 配方（材质参数 / 对象属性 / 场景设置 / 自定义）都能存、列、取、套用、导出、导入。

API 挂 K.dsh_preset_api；工具入口 blender_rt_preset。
    配方文件：<K.out_dir>/presets/<name>.json   （自包含：name/kind/tags/note/data/mapping/version/created）
    data 用**点路径**表达：{"data": {"inputs.Base Color": [1,0,0,1], "Base Color": [1,0,0,1]}}
    apply(name, targets) 支持 target 形如：
        "MAT:材质名"       → 套到材质节点（点路径写法见下）
        "OBJ:对象名"       → 套到对象属性
        "SCENE"            → 套到 scene 属性
        省略 targets         → 只返回 dry_run 预览（不写）
    MAT 目标支持的点路径（v2.6.3 起全部可用）：
        inputs.<插槽名>            → Principled BSDF 的同名输入（大小写不敏感）
        nodes.<节点名>.inputs.<名>  → 指定节点的输入
        nodes.<节点名>.<属性>       → 指定节点的属性
        <属性>                      → 材质自身属性（diffuse_color…）；没有则回落到
                                    Principled 的同名输入（base_color → "Base Color"）
        defaults.<属性>             → 同上（历史写法）
"""
import bpy
import json
import os
import time

PRESET_VERSION = 1


import sys as _sys_kit
_KIT = getattr(_sys_kit.modules.get("dsh_rt_kernel"), "dsh_kit", None)
if _KIT is None:
    raise RuntimeError("presets 需要共享内核 K.dsh_kit（由 KERNEL_BOOTSTRAP 注入）")


_j = _KIT.j  # 共享内核（原自带实现已删）
def _kernel():
    import sys
    return sys.modules.get("dsh_rt_kernel")


def _dir():
    K = _kernel()
    d = getattr(K, "out_dir", None) or os.path.join(os.path.expanduser("~"), "dsh_out")
    p = os.path.join(d, "presets")
    os.makedirs(p, exist_ok=True)
    return p


def _path(name):
    safe = "".join(c for c in str(name) if c.isalnum() or c in "._- ")
    if not safe:
        raise ValueError("非法配方名")
    return os.path.join(_dir(), safe + ".json")


def p_save(name, data, kind="generic", tags=None, note="", mapping=None, overwrite=True):
    p = _path(name)
    if os.path.isfile(p) and not overwrite:
        return _j({"ok": False, "error": "配方已存在（overwrite=false）", "name": str(name)})
    rec = {"name": str(name), "kind": str(kind), "tags": list(tags or []), "note": str(note),
           "data": data, "mapping": mapping or {}, "version": PRESET_VERSION,
           "created": time.strftime("%Y-%m-%d %H:%M:%S")}
    with open(p, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=1)
    return _j({"ok": True, "name": rec["name"], "kind": rec["kind"], "keys": len(data or {}), "path": p, "bytes": os.path.getsize(p)})


def _load(name):
    p = _path(name)
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def p_list(kind=None, tag=None):
    out = []
    for fn in sorted(os.listdir(_dir())):
        if not fn.endswith(".json"):
            continue
        if fn.startswith("presets_bundle"):  # 导出包不参与列出（曾污染 list）
            continue
        try:
            with open(os.path.join(_dir(), fn), encoding="utf-8") as f:
                r = json.load(f)
        except Exception:
            continue
        if kind and r.get("kind") != kind:
            continue
        if tag and tag not in (r.get("tags") or []):
            continue
        out.append({"name": r.get("name"), "kind": r.get("kind"), "tags": r.get("tags"),
                    "keys": len(r.get("data") or {}), "note": r.get("note"), "created": r.get("created")})
    return _j({"ok": True, "count": len(out), "presets": out, "dir": _dir()})


def p_get(name):
    r = _load(name)
    return _j({"ok": bool(r), "preset": r}) if r else _j({"ok": False, "error": "没有这个配方: %s" % name, "dir": _dir()})


def p_delete(name):
    p = _path(name)
    if os.path.isfile(p):
        os.remove(p)
        return _j({"ok": True, "deleted": str(name)})
    return _j({"ok": False, "error": "没有这个配方: %s" % name})


def _lookup(cur, part):
    """按名字取属性 / 集合成员。

    bpy_prop_collection（node_tree.nodes、node.inputs…）**不能**用 getattr 取成员 ——
    getattr(node_tree.nodes, "Principled BSDF") 恒为 None ⇒ 此前 "nodes.<名>.inputs.<名>"
    一律报"路径不存在"。这里先属性、再按名索引。
    """
    if isinstance(cur, dict):
        return cur.get(part)
    v = getattr(cur, part, None)
    if v is not None:
        return v
    try:
        return cur[part]
    except Exception:
        return None


def _set_path(root, path, value):
    parts = str(path).split(".")
    cur = root
    for part in parts[:-1]:
        cur = _lookup(cur, part)
        if cur is None:
            raise KeyError("路径不存在: %s" % path)
    last = parts[-1]
    if isinstance(cur, dict):
        if last not in cur:
            raise KeyError("键不存在: %s" % path)
        cur[last] = value
        return
    # 末尾落在按名索引的集合上（典型：node.inputs["Base Color"]）⇒ 取成员写它的 default_value
    if not hasattr(cur, last):
        member = None
        try:
            member = cur[last]
        except Exception:
            member = None
        if member is not None and hasattr(member, "default_value"):
            member.default_value = value
            return
        raise KeyError("属性不存在: %s" % path)
    old = getattr(cur, last)
    if hasattr(old, "to_tuple") or hasattr(old, "__len__"):
        try:
            setattr(cur, last, type(old)(value) if not isinstance(value, (int, float, str, bool)) else value)
            return
        except Exception:
            pass
    setattr(cur, last, value)


# ── MAT 目标：点路径 → 材质上的真实位置 ────────────────────────────────────
# 支持的写法（与文档/README 的简写一致）：
#   inputs.<Name>               → Principled BSDF 节点的 <Name> 输入（文档里的 {"inputs.Base Color":…}）
#   nodes.<节点名>.inputs.<名>   → 指定节点的输入
#   nodes.<节点名>.<属性>        → 指定节点的属性
#   <属性>                       → 材质自身属性（diffuse_color / roughness…）；没有则回落到
#                                 Principled 的同名输入（大小写不敏感，base_color → "Base Color"）
#   defaults.<属性>              → 同上（历史写法；此前指向不存在的 node_tree.defaults ⇒ 必报错）
_PRINCIPLED_TYPE = "BSDF_PRINCIPLED"


def _mat_principled(mat):
    """取材质里的 Principled BSDF 节点（没有则 None）。"""
    nt = getattr(mat, "node_tree", None)
    if nt is None:
        return None
    nodes = getattr(nt, "nodes", None)
    if nodes is None:
        return None
    try:
        for n in nodes:
            try:
                if getattr(n, "type", "") == _PRINCIPLED_TYPE:
                    return n
            except Exception:
                continue
    except Exception:
        pass
    return _lookup(nodes, "Principled BSDF")


def _norm_name(s):
    """归一化插槽名：大小写 + 空格/下划线/连字符都忽略。

    Principled 的插槽名是 "Base Color" 这种大写带空格形式，用户常写 "base_color"
    ⇒ 只做大小写比较不够（"base color" ≠ "base_color"），这里统一去掉分隔符再比。
    """
    return "".join(ch for ch in str(s).lower() if ch.isalnum())


def _mat_set_input(node, name, value, path):
    """写节点输入：先按原名，再按归一化名（大小写/空格/下划线都忽略）。"""
    inputs = getattr(node, "inputs", None)
    if inputs is None:
        raise KeyError("节点没有 inputs: %s" % path)
    sock = _lookup(inputs, name)
    if sock is None:
        want = _norm_name(name)
        try:
            for s in inputs:
                if _norm_name(getattr(s, "name", "")) == want:
                    sock = s
                    break
        except Exception:
            sock = None
    if sock is None:
        raise KeyError("输入不存在: %s" % path)
    if hasattr(sock, "default_value"):
        sock.default_value = value
        return
    raise KeyError("输入不可写: %s" % path)


def _mat_set(mat, path, value):
    """把一条点路径写到材质上；返回实际写入的路径说明。失败抛异常（由调用方收进 errors）。"""
    p = str(path)
    nt = getattr(mat, "node_tree", None)
    if nt is None:
        raise KeyError("材质没有节点树")
    parts = p.split(".")
    # ① nodes.<节点名>[....]
    if parts[0] == "nodes" and len(parts) >= 2:
        node = _lookup(getattr(nt, "nodes", None), parts[1])
        if node is None:
            raise KeyError("节点不存在: %s" % p)
        rest = ".".join(parts[2:])
        if not rest:
            raise KeyError("路径不完整: %s" % p)
        if rest.startswith("inputs."):
            _mat_set_input(node, rest[len("inputs."):], value, p)
        else:
            _set_path(node, rest, value)
        return p
    # ② inputs.<Name> —— 文档里的简写，落 Principled BSDF 的输入
    if parts[0] == "inputs":
        if len(parts) < 2:
            raise KeyError("路径不完整: %s" % p)
        node = _mat_principled(mat)
        if node is None:
            raise KeyError("材质里没有 Principled BSDF 节点")
        _mat_set_input(node, ".".join(parts[1:]), value, p)
        return p
    # ③ defaults.<属性> —— 历史写法，落材质自身属性
    if parts[0] == "defaults":
        if len(parts) < 2:
            raise KeyError("路径不完整: %s" % p)
        _set_path(mat, ".".join(parts[1:]), value)
        return "defaults." + ".".join(parts[1:])
    # ④ 其它：材质自身属性优先；没有就回落到 Principled 的同名输入（大小写不敏感）
    try:
        _set_path(mat, p, value)
        return p
    except Exception:
        node = _mat_principled(mat)
        if node is None:
            raise
        _mat_set_input(node, p, value, p)
        return "inputs." + p


def p_apply(name, targets=None, dry_run=False):
    r = _load(name)
    if not r:
        return _j({"ok": False, "error": "没有这个配方: %s" % name})
    data = dict(r.get("data") or {})
    for k, v in (r.get("mapping") or {}).items():
        if k in data:
            data[v] = data.pop(k)
    tgts = [str(t) for t in (targets or [])]
    report = {"applied": [], "skipped": [], "errors": []}
    for t in tgts:
        t = t.strip()
        if t.upper().startswith("MAT:"):
            mat = bpy.data.materials.get(t[4:].strip())
            if mat is None or not mat.use_nodes:
                report["skipped"].append({"target": t, "why": "材质不存在或未启用节点"})
                continue
            for path, val in data.items():
                try:
                    # v2.6.3（issue #47）：此前三种写法全错 —— "inputs.X" 落到不存在的
                    # node_tree.inputs、"nodes.<名>.inputs.X" 因 getattr 取不到集合成员而报
                    # "路径不存在"、"defaults.X" 落到不存在的 node_tree.defaults。
                    # 现在统一交给 _mat_set 按节点树规则解析。
                    applied_path = _mat_set(mat, path, val)
                    report["applied"].append({"target": t, "path": applied_path})
                except Exception as e:
                    report["errors"].append({"target": t, "path": path, "error": str(e)[:80]})
        elif t.upper().startswith("OBJ:"):
            ob = bpy.data.objects.get(t[4:].strip())
            if ob is None:
                report["skipped"].append({"target": t, "why": "对象不存在"})
                continue
            for path, val in data.items():
                try:
                    _set_path(ob, path, val)
                    report["applied"].append({"target": t, "path": path})
                except Exception as e:
                    report["errors"].append({"target": t, "path": path, "error": str(e)[:80]})
        elif t.upper().startswith("SCENE"):
            for path, val in data.items():
                try:
                    _set_path(bpy.context.scene, path, val)
                    report["applied"].append({"target": "SCENE", "path": path})
                except Exception as e:
                    report["errors"].append({"target": "SCENE", "path": path, "error": str(e)[:80]})
        else:
            report["skipped"].append({"target": t, "why": "无法识别的 target（用 MAT:名 / OBJ:名 / SCENE）"})
    if not tgts:
        bpy.context.view_layer.update()
    return _j({"ok": True, "preset": r.get("name"), "dry_run": True if not tgts else bool(dry_run),
               "keys": list(data), "targets": tgts, "report": report,
               "note": "未给 targets 时只预览；给了 targets 就实际写入（可用 dry_run=true 只校验路径）"})


def p_export(names=None, path=None):
    files = [f for f in os.listdir(_dir()) if f.endswith(".json")]
    picked = []
    for fn in files:
        with open(os.path.join(_dir(), fn), encoding="utf-8") as f:
            r = json.load(f)
        if names and r.get("name") not in names:
            continue
        picked.append(r)
    exp = os.path.join(os.path.dirname(_dir()), "presets_export")
    os.makedirs(exp, exist_ok=True)
    dst = path or os.path.join(exp, "presets_bundle_%s.json" % time.strftime("%Y%m%d_%H%M%S"))
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"bundle": picked, "count": len(picked), "version": PRESET_VERSION}, f, ensure_ascii=False, indent=1)
    return _j({"ok": True, "count": len(picked), "path": dst, "bytes": os.path.getsize(dst)})


def p_import(path, overwrite=False):
    with open(path, encoding="utf-8") as f:
        b = json.load(f)
    added, skipped = [], []
    for r in (b.get("bundle") or []):
        nm = r.get("name")
        if not nm:
            continue
        dst = _path(nm)
        if os.path.isfile(dst) and not overwrite:
            skipped.append(nm)
            continue
        r["version"] = PRESET_VERSION
        with open(dst, "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=1)
        added.append(nm)
    return _j({"ok": True, "added": added, "skipped": skipped, "dir": _dir()})


# ---------------------------------------------------------------- v0.8.10：玻璃 / 光学配方
# 外部反馈：EEVEE 默认不把玻璃渲透明 —— 要自己开 use_ssr_refraction / use_raytracing_refraction
# + 材质侧标志 + Principled 的 Transmission/Alpha，而且 **4.x/5.x 输入名不一样**（白渲一轮磨砂塑料才发现）。

_PRINCIPLED_ALIASES = {
    "transmission": ["Transmission Weight", "Transmission"],
    "ior": ["IOR"],
    "roughness": ["Roughness"],
    "alpha": ["Alpha"],
    "base_color": ["Base Color"],
    "specular": ["Specular IOR Level", "Specular"],
    "coat": ["Coat Weight", "Clearcoat"],
}


def _set_input(node, key, value):
    """按 4.x/5.x 别名表找 Principled 的输入名；成功返回真实输入名，失败返回 None。"""
    for name in _PRINCIPLED_ALIASES.get(key, []):
        if name in node.inputs:
            try:
                node.inputs[name].default_value = value
                return name
            except Exception:
                pass
    return None


def preset_glass(targets=None, ior=1.45, transmission=1.0, roughness=0.03, alpha=0.35,
                 base_color=(0.86, 0.93, 0.96, 1.0), use_alpha=False, scene_flags=True):
    """一条调用把「EEVEE 真透玻璃」配好：引擎开关 + 材质侧标志 + Principled 输入名映射（4.x/5.x 通吃）。

    targets：逗号分隔 MAT:名字 / OBJ:名字（OBJ 会取其所有材质槽）；省略则对所有材质应用。
    """
    rep = {"ok": True, "scene": {}, "materials": [], "warnings": []}
    sc = bpy.context.scene
    if scene_flags:
        ee = getattr(sc, "eevee", None)
        if ee is not None:
            for attr, val in (("use_raytracing", True), ("use_ssr_refraction", True), ("use_raytracing_refraction", True)):
                if hasattr(ee, attr):
                    try:
                        setattr(ee, attr, val)
                        rep["scene"][attr] = val
                    except Exception as e:
                        rep["warnings"].append("%s: %s" % (attr, str(e)[:60]))
                else:
                    rep["warnings"].append("本引擎没有 %s（版本差异）" % attr)
    # 选材质
    mats = []
    if targets:
        names = [t.strip() for t in str(targets).replace(";", ",").split(",") if t.strip()]
        for n in names:
            if n.upper().startswith("MAT:"):
                m = bpy.data.materials.get(n.split(":", 1)[1])
                if m:
                    mats.append(m)
                else:
                    rep["warnings"].append("材质不存在：%s" % n)
            elif n.upper().startswith("OBJ:"):
                ob = bpy.data.objects.get(n.split(":", 1)[1])
                if not ob:
                    rep["warnings"].append("对象不存在：%s" % n)
                    continue
                for slot in ob.material_slots:
                    if slot.material and slot.material not in mats:
                        mats.append(slot.material)
            else:
                rep["warnings"].append("target 形态不认（用 MAT:名 / OBJ:名）：%s" % n)
    else:
        mats = [m for m in bpy.data.materials if m.users > 0]
    for m in mats:
        item = {"name": m.name, "set": {}, "missing": []}
        try:
            if hasattr(m, "use_screen_refraction"):
                m.use_screen_refraction = True
                item["set"]["use_screen_refraction"] = True
            if hasattr(m, "use_raytrace_refraction"):
                m.use_raytrace_refraction = True
                item["set"]["use_raytrace_refraction"] = True
            # 5.x：surface_render_method='BLENDED'；4.x：blend_method='BLEND'
            for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
                if hasattr(m, attr):
                    try:
                        setattr(m, attr, val)
                        item["set"][attr] = val
                    except Exception:
                        pass
            if hasattr(m, "show_transparent_back"):
                m.show_transparent_back = False
            nt = getattr(m, "node_tree", None)
            node = None
            if nt is not None:
                for nd in nt.nodes:
                    if nd.type == "BSDF_PRINCIPLED":
                        node = nd
                        break
            if node is None:
                item["missing"].append("没有 Principled BSDF 节点")
            else:
                for key, val in (("transmission", float(transmission)), ("ior", float(ior)),
                                 ("roughness", float(roughness)),
                                 ("alpha", float(alpha) if use_alpha else 1.0),
                                 ("base_color", tuple(base_color))):
                    got = _set_input(node, key, val)
                    if got:
                        item["set"]["inputs." + got] = val
                    else:
                        item["missing"].append(key)
        except Exception as e:
            item["error"] = "%s: %s" % (type(e).__name__, str(e)[:100])
        if item["missing"]:
            rep["warnings"].append("%s 缺少：%s" % (m.name, ", ".join(item["missing"])))
        rep["materials"].append(item)
    rep["count"] = len(rep["materials"])
    rep["note"] = ("EEVEE 真透明三件套：引擎 use_raytracing+use_ssr_refraction+use_raytracing_refraction、"
                   "材质 use_screen_refraction/use_raytrace_refraction、Principled 的 Transmission/Alpha；"
                   "输入名 4.x(Transmission Weight)/3.x(Transmission) 已自动映射。不透明塑料就别开 use_alpha。")
    if not rep["materials"]:
        rep["ok"] = False
        rep["error"] = "没有可应用的材质（检查 targets 或场景里是否有材质）"
    return _j(rep)


def p_help():
    return _j({"version": PRESET_VERSION, "dir": _dir(),
               "ops": {"save": "save(name, data, kind, tags, note, mapping, overwrite=true)",
                       "list": "list(kind=None, tag=None)", "get": "get(name)", "delete": "delete(name)",
                       "apply": "apply(name, targets=[MAT:x/OBJ:y/SCENE], dry_run=false)",
                       "export": "export(names=None, path=None) → 单个 bundle 文件（可分发）",
                       "import": "import(path, overwrite=false)",
                       "glass": "glass(targets='MAT:x,OBJ:y', ior, transmission, roughness, alpha, use_alpha) "
                                "→ 一条调用配好 EEVEE 真透明玻璃（v0.8.10）"},
               "data_format": "点路径 dict：{\"inputs.Base Color\": [1,0,0,1]} 或 {\"nodes.Principled BSDF.inputs.Roughness\": 0.4} 或 {\"location\": [0,0,1]}",
               "why": "把风格/参数配方变成资产：可保存、可套用、可导出分享；与领域无关（材质/对象/场景/自定义都行）"})


def p_dispatch(op, args=None):
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except Exception:
            args = {}
    fn = {"save": p_save, "list": p_list, "get": p_get, "delete": p_delete, "apply": p_apply,
          "export": p_export, "import": p_import, "glass": preset_glass, "help": p_help}.get(str(op))
    if fn is None:
        return _j({"ok": False, "error": "unknown preset op", "op": op,
                   "ops": ["save", "list", "get", "delete", "apply", "export", "import", "glass", "help"]})
    try:
        return fn(**(args or {}))
    except TypeError as e:
        return _j({"ok": False, "error": "参数不匹配: %s" % e, "op": op, "given": sorted(args or {}), "sig": p_help()})


import sys as _sys
_K = _sys.modules.get("dsh_rt_kernel")
def _mat_selftest():
    """MAT 目标点路径自检（v2.6.3）：三种写法都要落到真实位置。

    覆盖：inputs.<插槽名>（Principled 输入）· nodes.<节点名>.inputs.<名>（指定节点输入）·
    <属性>（材质自身属性，没有则回落到 Principled 的同名输入）· defaults.<属性>（历史写法）。
    """
    ev = {}
    nm = "__dsh_ps_mat"
    pn = "__dsh_selftest_mat"

    def _d(x):
        return json.loads(x) if isinstance(x, str) else x

    try:
        mat = bpy.data.materials.get(nm) or bpy.data.materials.new(nm)
        mat.use_nodes = True
        node = None
        for n in mat.node_tree.nodes:
            if getattr(n, "type", "") == _PRINCIPLED_TYPE:
                node = n
                break
        if node is None:
            return {"mat_selftest": False}
        base = node.inputs["Base Color"].default_value[:]
        rough = node.inputs["Roughness"].default_value
        # ① inputs.<名> → Principled 输入；② nodes.<名>.inputs.<名> → 指定节点输入
        _d(p_save(pn, {"inputs.Base Color": [0.1, 0.2, 0.3, 1.0],
                       "nodes.Principled BSDF.inputs.Roughness": 0.42},
                  kind="material", note="mat-selftest"))
        ap = _d(p_apply(pn, targets=["MAT:" + nm]))
        rep = (ap or {}).get("report") or {}
        ev["mat_apply_no_error"] = isinstance(ap, dict) and not rep.get("errors")
        ev["mat_applied_count"] = len(rep.get("applied") or []) == 2
        bc = node.inputs["Base Color"].default_value
        ev["mat_inputs_base_color"] = abs(bc[0] - 0.1) < 1e-4 and abs(bc[2] - 0.3) < 1e-4
        ev["mat_nodes_input"] = abs(float(node.inputs["Roughness"].default_value) - 0.42) < 1e-4
        # ③ 归一化名（base_color → "Base Color"）④ defaults.<属性>（历史写法）
        _d(p_save(pn, {"base_color": [0.7, 0.0, 0.0, 1.0], "defaults.diffuse_color": [0.0, 0.5, 0.0, 1.0]},
                  kind="material", note="mat-selftest2"))
        ap2 = _d(p_apply(pn, targets=["MAT:" + nm]))
        rep2 = (ap2 or {}).get("report") or {}
        ev["mat_alias_no_error"] = isinstance(ap2, dict) and not rep2.get("errors")
        bc2 = node.inputs["Base Color"].default_value
        ev["mat_alias_base_color"] = abs(bc2[0] - 0.7) < 1e-4
        dc = mat.diffuse_color
        ev["mat_defaults_own_attr"] = abs(dc[1] - 0.5) < 1e-4
        _d(p_delete(pn))
        # 复原，避免污染场景
        node.inputs["Base Color"].default_value = base
        node.inputs["Roughness"].default_value = rough
        mat.diffuse_color = base
        bpy.data.materials.remove(mat)
        return ev
    except Exception as e:
        return {"mat_selftest": False, "mat_error": "%s: %s" % (type(e).__name__, str(e)[:160])}


def p_selftest():
    # 配方自检：存 -> 取 -> 套到真对象上 -> 值确实生效 -> 删
    import json

    def _d(x):
        return json.loads(x) if isinstance(x, str) else x

    import bpy
    import bmesh as _bm
    ev = {}
    nm = "__dsh_ps_cube"
    pn = "__dsh_selftest_preset"
    try:
        me = bpy.data.meshes.new(nm)
        ob = bpy.data.objects.new(nm, me)
        bpy.context.scene.collection.objects.link(ob)
        bm = _bm.new()
        _bm.ops.create_cube(bm, size=1.0)
        bm.to_mesh(me)
        bm.free()
        ob.location = (0.0, 0.0, 0.0)
        ev["save_ok"] = _d(p_save(pn, {"location": [1.0, 2.0, 3.0]}, kind="object", note="selftest")).get("ok") is not False
        ev["get_ok"] = isinstance(_d(p_get(pn)), dict)
        ap = _d(p_apply(pn, targets=["OBJ:" + nm]))
        ev["apply_ok"] = isinstance(ap, dict) and ap.get("ok") is not False
        try:
            bpy.context.view_layer.update()
        except Exception:
            pass
        loc = bpy.data.objects[nm].location
        ev["value_applied"] = abs(loc[0] - 1.0) < 1e-4 and abs(loc[2] - 3.0) < 1e-4
        _d(p_delete(pn))
        ev["deleted"] = True
        # v2.6.3（issue #47）：MAT 目标的点路径此前三种写法全错（inputs.X / nodes.<名>.inputs.X /
        # defaults.X 都落不到真实位置）⇒ 这里把三种写法一起验。
        ev.update(_mat_selftest())
        return _j({"ok": all(x is True for x in ev.values()), "evidence": ev, "loc": [round(float(q), 3) for q in loc]})
    except Exception as e:
        return _j({"ok": False, "evidence": ev, "error": "%s: %s" % (type(e).__name__, str(e)[:200])})
    finally:
        o = bpy.data.objects.get(nm)
        if o is not None:
            me2 = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if me2 is not None and me2.users == 0:
                bpy.data.meshes.remove(me2, do_unlink=True)



if _K is not None:
    _K.dsh_preset_api = _KIT.Api({"version": PRESET_VERSION, "dispatch": _KIT.wrap_dispatch(p_dispatch, {"selftest": p_selftest}), "save": p_save, "list": p_list,
                         "get": p_get, "delete": p_delete, "apply": p_apply, "export": p_export,
                         "import": p_import, "glass": preset_glass, "help": p_help,
        "selftest": p_selftest})

# ---- v0.9.1（93-B1/B2）：API 可调用化（换成 dict 子类实例，返回已解析对象）----
# 背景：K.dsh_x_api 原来是普通 dict → 进程内 api(args) 报 TypeError: 'dict' object is not callable；
# 且 dispatch 返回 JSON 字符串，调用方还得自己 json.loads。
# 现在：api("op", {…}) 或 api({…}) → dict；api["dispatch"](op, json_str) 仍返回 str（引擎契约不变）。
# 注意：dict 是静态类型，不能对已有实例做 __class__ 赋值（实测 TypeError），所以换成一个新实例。
_DshApi = _KIT.Api  # 共享内核（尾部注册行无需改）
import sys as _sys_api
_K_api = _sys_api.modules.get("dsh_rt_kernel")
if _K_api is not None and isinstance(getattr(_K_api, "dsh_presets_api", None), dict) \
        and not isinstance(getattr(_K_api, "dsh_presets_api", None), _DshApi):
    _K_api.dsh_presets_api = _DshApi(_K_api.dsh_presets_api)
