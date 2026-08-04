#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"
./mlx stop
print
read "?按 Enter 關閉視窗…"
