import os

import pytest


@pytest.fixture(autouse=True)
def _restore_environ():
    # Importing tradingagents calls load_dotenv() on the repo .env, which would leak into later tests.
    saved = os.environ.copy()
    yield
    os.environ.clear()
    os.environ.update(saved)
