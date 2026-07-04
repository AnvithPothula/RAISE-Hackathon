from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field


@dataclass
class ContextMemory:
    max_chars: int = 300
    _items: deque[str] = field(default_factory=deque)

    def add(self, text: str) -> None:
        clean = " ".join(text.strip().split())
        if not clean:
            return
        self._items.append(clean)
        while len(self.text) > self.max_chars and self._items:
            self._items.popleft()

    @property
    def text(self) -> str:
        return " ".join(self._items)

    def clear(self) -> None:
        self._items.clear()
