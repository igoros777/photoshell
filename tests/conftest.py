"""Shared pytest fixtures for PhotoShell tests."""

import os
import sys
import tempfile

import pytest

# Add Flask app to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ui", "flask"))

from app import app as flask_app


@pytest.fixture
def client():
    """Flask test client."""
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


@pytest.fixture
def photo_dir(tmp_path):
    """Temporary directory with a few fake photo files."""
    for name in ["photo1.jpg", "photo2.jpg", "photo3.png"]:
        (tmp_path / name).write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
    return str(tmp_path)


@pytest.fixture
def empty_dir(tmp_path):
    """Temporary empty directory."""
    d = tmp_path / "empty"
    d.mkdir()
    return str(d)
