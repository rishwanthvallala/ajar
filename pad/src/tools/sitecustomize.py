"""Imported by every python the pad starts, before the program: see SITE in shell.ts.

A thread cannot start in this runtime. The first `Thread.start()` traps inside
the WebAssembly engine ("table index is out of bounds"), and the program then
waits forever with nothing on screen: no error, no output, no end. Measured on
27 September with the python package exactly as the registry publishes it, so
it is the runtime and not anything the pad changed.

Refusing at `start()` turns that silence into a traceback that says why.
asyncio and subprocesses do not need threads, and both work.
"""

import threading


def _refuse(self, *args, **kwargs):
    raise RuntimeError(
        "threads cannot start in the pad: the WebAssembly runtime it runs on "
        "stops the program when one does. asyncio and subprocess both work."
    )


threading.Thread.start = _refuse
