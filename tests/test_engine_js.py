"""Bridge: run the Node tests for web/engine.js (skipped if node is not installed)."""
import shutil
import subprocess
import unittest
from pathlib import Path


def test_engine_js():
    node = shutil.which('node')
    if not node:
        raise unittest.SkipTest('node not installed')
    r = subprocess.run([node, str(Path(__file__).with_name('test_engine.js'))],
                       capture_output=True, text=True, timeout=120)
    print(r.stdout.rstrip())
    assert r.returncode == 0, r.stdout + r.stderr
