"""Совместимость прежнего имени пакета Telelock."""
from pathlib import Path

__path__ = [str(Path(__file__).resolve().parent.parent / "telelock_bot")]
