# -*- coding: utf-8 -*-
"""Regression guard: no undefined names in the qc_render implementation.

Background (2026-11-05, live acceptance of the v3.0.5 port): the port changed
the receipt so that "engine" reports the engine the batch actually used and
"engine_scene_after" reports the restored scene engine.  The change touched
``_qv_finish_out``'s output dict but forgot to unpack ``eng_after`` from the
state dict, so the bare name raised

    NameError: name 'eng_after' is not defined

and the whole ``qc_render_views`` batch failed.  Nothing in the Python suite
caught it: the bug only shows up when that function actually runs inside
Blender.

This test uses :mod:`symtable` (stdlib) to prove the invariant statically.
The implementation is a package: ``qc_render_impl/__init__.py`` merges every
sibling module's namespace into one, and each module starts with
``from .common import *`` — so the names a function may read from module
scope are the **union** of the package's module-level names.  That union is
what this test compares against; :mod:`symtable` distinguishes locals from
globals precisely, so the check catches the class of bug without importing
``bpy``.
"""
import builtins
import symtable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
IMPL_DIR = ROOT / "runtime" / "py" / "render" / "qc_render_impl"
VIEWS_RENDER = IMPL_DIR / "views_render.py"


def _package_namespace():
    """Module-level names available inside the implementation package."""
    names = set()
    for path in sorted(IMPL_DIR.glob("*.py")):
        top = symtable.symtable(path.read_text(encoding="utf-8"), str(path), "exec")
        names.update(sym.get_name() for sym in top.get_symbols())
    return names


def _undefined_globals(source: str, filename: str, available: set):
    """Return [(function_name, symbol_name), ...] for names read but never bound."""
    top = symtable.symtable(source, filename, "exec")
    problems = []
    for child in top.get_children():
        if child.get_type() != "function":
            continue
        for sym in child.get_symbols():
            name = sym.get_name()
            if sym.is_global() and name not in available and not hasattr(builtins, name):
                problems.append((child.get_name(), name))
    return problems


def test_qc_render_impl_has_no_undefined_names():
    source = VIEWS_RENDER.read_text(encoding="utf-8")
    available = _package_namespace()
    problems = _undefined_globals(source, str(VIEWS_RENDER), available)
    assert not problems, "qc_render_impl 里用到了未定义的名字：%r" % (problems,)


def test_finish_out_unpacks_eng_after():
    """The batch engine must come from the state dict, not a bare name."""
    source = VIEWS_RENDER.read_text(encoding="utf-8")
    top = symtable.symtable(source, str(VIEWS_RENDER), "exec")
    finish_out = next(c for c in top.get_children() if c.get_name() == "_qv_finish_out")
    names = {sym.get_name(): sym for sym in finish_out.get_symbols()}
    assert "eng_after" in names, "_qv_finish_out 根本没提到 eng_after"
    # A local binding (assigned in the function) — not a global lookup.
    assert names["eng_after"].is_local(), "eng_after 必须从 st 里解包成局部名，不能是裸全局查找"
