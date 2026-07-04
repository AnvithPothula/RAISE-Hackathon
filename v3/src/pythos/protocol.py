from __future__ import annotations

import json
import sys
import threading
from dataclasses import asdict, dataclass
from typing import Any, TextIO


@dataclass(frozen=True)
class WorkerEvent:
    type: str
    payload: dict[str, Any]


class JsonlWriter:
    def __init__(self, stream: TextIO = sys.stdout) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, event_type: str, **payload: Any) -> None:
        event = WorkerEvent(type=event_type, payload=payload)
        line = json.dumps(asdict(event), ensure_ascii=True)
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()


def parse_command(line: str) -> dict[str, Any]:
    data = json.loads(line)
    if not isinstance(data, dict):
        raise ValueError("Worker command must be a JSON object")
    if "type" not in data:
        raise ValueError("Worker command is missing 'type'")
    return data
