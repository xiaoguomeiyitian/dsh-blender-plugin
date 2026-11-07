"""Unit tests for the E2E Blender version contract (no Blender needed).

These pin the *rules* the E2E layer enforces:
  · version parsing ("5.2.2 LTS" / "5.1" / "Blender 5.2.2 LTS")
  · the supported range (floor from the add-on's own bl_info = 5.0.0, major 5)
  · "the report must describe the binary under test" (a lying report fails)
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT / "tests" / "e2e") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tests" / "e2e"))

import blender_version as bv  # noqa: E402


def test_parse_version_handles_the_real_report_shapes():
    assert bv.parse_version("5.2.2 LTS") == (5, 2, 2)
    assert bv.parse_version("5.1.0 LTS") == (5, 1, 0)
    assert bv.parse_version("5.2") == (5, 2, 0)
    assert bv.parse_version("Blender 5.1.0") == (5, 1, 0)


def test_parse_version_rejects_garbage():
    with pytest.raises(AssertionError):
        bv.parse_version("not-a-version")


def test_declared_floor_comes_from_the_addon_bl_info():
    floor = bv.addon_declared_floor()
    assert floor == (5, 0, 0)
    assert floor >= (5, 0, 0)


def test_supported_range_covers_5x_only():
    assert bv.is_supported((5, 0, 0)) is True
    assert bv.is_supported((5, 1, 0)) is True
    assert bv.is_supported((5, 2, 2)) is True
    assert bv.is_supported((5, 9, 9)) is True


def test_4x_is_out_of_support_after_the_2026_11_07_drop():
    """4.x 不再受支持（addon 下限已是 5.0.0）⇒ E2E 必须拒绝它。"""
    assert bv.is_supported((4, 2, 0)) is False
    assert bv.is_supported((4, 2, 9)) is False
    assert bv.is_supported((4, 5, 3)) is False


def test_unsupported_versions_are_rejected():
    assert bv.is_supported((5, 0, 0)) is True    # the floor itself is supported
    assert bv.is_supported((4, 9, 9)) is False   # 4.x line: support dropped
    assert bv.is_supported((3, 6, 0)) is False   # too old
    assert bv.is_supported((6, 0, 0)) is False   # not an officially supported major yet


def test_report_must_match_the_binary_under_test(tmp_path, monkeypatch):
    """A report that names another Blender must fail (no relaxation)."""
    fake = tmp_path / "blender"
    fake.write_text("#!/bin/sh\necho 'Blender 5.2.2 LTS'\n", encoding="utf-8")
    fake.chmod(0o755)

    monkeypatch.setattr(bv, "blender_version_of", lambda executable: (5, 2, 2))

    # honest report → passes and returns the parsed version
    assert bv.assert_blender_version("5.2.2 LTS", str(fake), where="unit") == (5, 2, 2)

    # report claims a different Blender → must fail
    with pytest.raises(AssertionError) as excinfo:
        bv.assert_blender_version("5.1.0 LTS", str(fake), where="unit")
    assert "does not describe this run" in str(excinfo.value)


def test_unsupported_binary_is_rejected_even_if_the_report_matches(tmp_path, monkeypatch):
    fake = tmp_path / "blender"
    fake.write_text("#!/bin/sh\necho 'Blender 6.0.0'\n", encoding="utf-8")
    fake.chmod(0o755)

    monkeypatch.setattr(bv, "blender_version_of", lambda executable: (6, 0, 0))
    with pytest.raises(AssertionError) as excinfo:
        bv.assert_blender_version("6.0.0", str(fake), where="unit")
    assert "outside the supported range" in str(excinfo.value)


def test_blender_version_of_reads_the_real_binary(tmp_path):
    fake = tmp_path / "blender"
    fake.write_text(
        "#!/bin/sh\nprintf 'Blender 5.2.2 LTS\\n\\tbuild date: 2025-04-15\\n'\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    assert bv.blender_version_of(str(fake)) == (5, 2, 2)
