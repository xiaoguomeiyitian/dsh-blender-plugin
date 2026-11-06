"""Blender version contract for the E2E layer (shared by headless + GUI).

The repo supports Blender **4.2 LTS** and **5.x** (see README).  The E2E
layer therefore must not hard-code one version: it has to prove two things.

1. **Honesty** — the report states *the very Blender that actually ran*.
   The ground truth is the executable under test: ``<exe> --version``.
   A report that lies about its Blender (e.g. the harness picked a different
   binary than the one the test thinks it is testing) must fail.
2. **Support boundary** — that Blender is inside the range we officially
   support: at least the addon's own declared floor (``bl_info["blender"]``)
   and a major version we claim to support.

This is *not* a relaxed assertion: the old check hard-coded ``4.2.`` which
could only ever prove "the suite still runs on 4.2"; the new check pins the
reported version to the exact binary under test **and** to the declared
support range, so it fails on a wrong binary, on an unsupported Blender, and
on a report that misreports its version.
"""

from __future__ import annotations

import ast
import functools
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Major versions the repo officially supports (4.x LTS line + 5.x).
SUPPORTED_MAJORS = (4, 5)

_VERSION_RE = re.compile(r"(\d+)\.(\d+)(?:\.(\d+))?")


def addon_declared_floor() -> tuple[int, int, int]:
    """Read the addon's own ``bl_info["blender"]`` floor (single source of truth).

    Parsed statically with ``ast`` — the add-on package must not be imported
    here (it needs a real ``bpy``).
    """
    init = REPO_ROOT / "addon" / "dsh_blender_bridge" / "__init__.py"
    tree = ast.parse(init.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if "bl_info" not in targets:
            continue
        info = ast.literal_eval(node.value)
        floor = tuple(info["blender"])
        return (floor + (0, 0, 0))[:3]
    raise AssertionError("bl_info not found in " + str(init))


def parse_version(text: str) -> tuple[int, int, int]:
    """Parse ``"5.2.2 LTS"`` / ``"4.2"`` / ``"Blender 4.2.9 LTS"`` → version tuple."""
    match = _VERSION_RE.search(text or "")
    if not match:
        raise AssertionError("cannot parse Blender version from: " + repr(text))
    major, minor, patch = match.group(1), match.group(2), match.group(3)
    return (int(major), int(minor), int(patch or 0))


@functools.lru_cache(maxsize=8)
def blender_version_of(executable: str) -> tuple[int, int, int]:
    """Ground truth: the version of the Blender binary that will be run."""
    completed = subprocess.run(
        [executable, "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    output = (completed.stdout or "") + (completed.stderr or "")
    if not output.strip():
        raise AssertionError(
            "Blender --version produced no output for " + executable
            + " (exit " + str(completed.returncode) + ")"
        )
    return parse_version(output.splitlines()[0])


def is_supported(version: tuple[int, int, int]) -> bool:
    """True when *version* is inside the officially supported range."""
    return version[0] in SUPPORTED_MAJORS and version >= addon_declared_floor()


def assert_blender_version(reported: str, executable: str, *, where: str) -> tuple[int, int, int]:
    """Assert the reported version is the running Blender and is supported.

    Returns the parsed version so callers can assert further details.
    """
    actual = blender_version_of(executable)
    reported_version = parse_version(reported)
    assert reported_version == actual, (
        where + ": report says Blender " + str(reported_version)
        + " but the binary under test is " + str(actual)
        + " (" + executable + ") ⇒ the report does not describe this run"
    )
    assert is_supported(actual), (
        where + ": Blender " + ".".join(str(part) for part in actual)
        + " is outside the supported range (floor "
        + ".".join(str(part) for part in addon_declared_floor())
        + ", supported majors " + str(SUPPORTED_MAJORS) + ")"
    )
    return reported_version
