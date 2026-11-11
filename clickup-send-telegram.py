#!/usr/bin/env python3
"""Compatibility wrapper for the ClickUp-to-Telegram task sender CLI."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"

if SRC.exists():
    sys.path.insert(0, str(SRC))

from clickup_tools.send_telegram import main


if __name__ == "__main__":
    main()
