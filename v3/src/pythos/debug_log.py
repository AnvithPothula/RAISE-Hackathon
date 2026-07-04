from __future__ import annotations

import os
import sys
import time


DEBUG_ENABLED = os.environ.get("PYTHOS_DEBUG", "1") != "0"


def debug(message: str) -> None:
    if not DEBUG_ENABLED:
        return
    timestamp = time.strftime("%H:%M:%S")
    sys.stderr.write(f"[pythos-worker {timestamp}] {message}\n")
    sys.stderr.flush()
