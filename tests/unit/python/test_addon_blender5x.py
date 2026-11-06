"""Add-on behaviour when Blender reports a **5.x** version.

The repo officially supports Blender 4.2 LTS *and* 5.x, so the add-on's
version-dependent surfaces have to behave on both.  These checks run the real
add-on package against the fake-bpy stub impersonating Blender 5.2.2.

Note: the stub proves the add-on's *logic* on a 5.x-reported Blender; the
real-5.x proof is the E2E layer (tests/e2e), which runs a real Blender 5.x.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

import bpy_stub

BLENDER_5X = (5, 2, 2)

# The stub is a process-wide singleton: install it, then switch the version it
# impersonates for the duration of a test and switch it back afterwards (other
# tests expect the default 4.2.10).
bpy = bpy_stub.install()

compat = importlib.import_module("addon.dsh_blender_bridge.compat")
core = importlib.import_module("addon.dsh_blender_bridge.commands.core")
registration = importlib.import_module("addon.dsh_blender_bridge.registration")


@pytest.fixture()
def blender_5x():
    original = tuple(bpy.app.version)
    bpy_stub.set_version(BLENDER_5X)
    try:
        yield bpy
    finally:
        bpy_stub.set_version(original)


def test_stub_reports_the_requested_blender_version(blender_5x):
    assert tuple(blender_5x.app.version) == BLENDER_5X
    assert blender_5x.app.version_string == "5.2.2"


def test_compat_helpers_understand_5x(blender_5x):
    assert compat.bpy_version() == BLENDER_5X
    assert compat.is_bpy_at_least(5, 0, 0) is True
    assert compat.is_bpy_at_least(5, 2, 0) is True
    assert compat.is_bpy_at_least(5, 3, 0) is False
    assert compat.is_bpy_at_least(4, 2, 0) is True   # the declared floor still holds


def test_addon_info_reports_the_running_blender_version(blender_5x):
    info = core.CoreCommands().get_addon_info()
    assert info["blender_version"] == "5.2.2"
    assert info["protocol_version"] == 11
    assert info["addon_version"] == [1, 11]


def test_addon_registers_and_unregisters_on_5x(blender_5x):
    """register()/unregister() must not be version-gated in a way 5.x breaks."""
    registration.register()
    try:
        assert "dshbb_port" in dir(bpy.types.Scene)
    finally:
        registration.unregister()
