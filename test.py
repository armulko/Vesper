#!/usr/bin/env python3
"""
Считает файлы, строки и символы в проекте.
Использование: python count_stats.py /путь/к/vesper
"""

import sys
import os

# Расширения, которые считаем "кодом" — остальное (картинки, бинарники) игнорим
CODE_EXT = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".scss",
    ".json", ".md", ".txt", ".yml", ".yaml", ".sh", ".sql", ".c", ".cpp", ".h"
}

# Папки, которые пропускаем — мусор, венвы, гит
SKIP_DIRS = {".git", "__pycache__", "node_modules", "venv", ".venv", "dist", "build"}


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."

    if not os.path.isdir(root):
        print(f"Нет такой папки: {root} (>_<)")
        sys.exit(1)

    total_files = 0
    total_lines = 0
    total_chars = 0
    by_ext = {}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in CODE_EXT:
                continue

            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception as e:
                print(f"Не смог прочитать {fpath}: {e}")
                continue

            lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
            chars = len(content)

            total_files += 1
            total_lines += lines
            total_chars += chars

            stat = by_ext.setdefault(ext, {"files": 0, "lines": 0, "chars": 0})
            stat["files"] += 1
            stat["lines"] += lines
            stat["chars"] += chars

    print(f"\nСтатистика по: {os.path.abspath(root)}\n")
    print(f"{'Расширение':<12}{'Файлов':>10}{'Строк':>12}{'Символов':>14}")
    print("-" * 48)
    for ext, s in sorted(by_ext.items(), key=lambda x: -x[1]['lines']):
        print(f"{ext:<12}{s['files']:>10}{s['lines']:>12}{s['chars']:>14}")
    print("-" * 48)
    print(f"{'ИТОГО':<12}{total_files:>10}{total_lines:>12}{total_chars:>14}\n")


if __name__ == "__main__":
    main()