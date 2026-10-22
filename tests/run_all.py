"""Run all offline test modules. Exit non-zero on any failure.

    python tests/run_all.py                 # everything
    python tests/run_all.py slicer          # modules whose name contains 'slicer'
    python tests/run_all.py slicer as_of    # ...and tests whose name contains 'as_of'
"""
import importlib
import os
import sys
import traceback
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODULES = ['test_slicer', 'test_engine_js', 'test_server']

mod_filter = sys.argv[1] if len(sys.argv) > 1 else ''
test_filter = sys.argv[2] if len(sys.argv) > 2 else ''

failed = ran = skipped = 0
for modname in MODULES:
    if mod_filter not in modname:
        continue
    mod = importlib.import_module(modname)
    for name in sorted(dir(mod)):
        if name.startswith('test_') and test_filter in name and callable(getattr(mod, name)):
            ran += 1
            try:
                getattr(mod, name)()
                print(f'PASS {modname}.{name}')
            except unittest.SkipTest as e:
                skipped += 1
                print(f'SKIP {modname}.{name}: {e}')
            except Exception as e:
                failed += 1
                print(f'FAIL {modname}.{name}: {e!r}')
                traceback.print_exc()

print('=' * 50)
print(f'{ran} run, {skipped} skipped, ' + ('ALL PASSED' if not failed else f'{failed} FAILURE(S)'))
sys.exit(1 if failed or not ran else 0)
