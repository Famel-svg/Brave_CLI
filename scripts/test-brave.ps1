pytest -m "not integration and not e2e" -q
ruff check .
mypy src
