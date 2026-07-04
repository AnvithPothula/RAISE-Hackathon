import pytest

from pythos.context_memory import ContextMemory
from pythos.protocol import parse_command


def test_parse_command_requires_object() -> None:
    with pytest.raises(ValueError):
        parse_command("[]")


def test_parse_command_requires_type() -> None:
    with pytest.raises(ValueError):
        parse_command("{}")


def test_context_memory_trims_to_max_chars() -> None:
    memory = ContextMemory(max_chars=12)

    memory.add("hello")
    memory.add("world")
    memory.add("again")

    assert memory.text == "world again"
