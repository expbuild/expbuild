#!/usr/bin/env python3
"""Download the exact engine used by the contract tests; never resolve 'latest'."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import tempfile
import urllib.request

VERSION = "2.6.2"
# Published asset digests from the official v2.6.2 GitHub release.
DIGESTS = {
    "amd64": "62e236bf8396e69396928e0d0c32062fbd5575f20fe55dc10a82eb791297e1a0",
    "arm64": "b2cabd5bf674e8d0649de2c95dddfea8d875db1a06ed9d431674c9293df273ed",
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    architecture = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if platform.system() != "Linux" or architecture not in DIGESTS:
        parser.error("this downloader supports Linux amd64/arm64")
    expected = DIGESTS[architecture]
    target = args.destination.resolve()
    if target.is_file():
        with target.open("rb") as existing:
            matches = hashlib.file_digest(existing, "sha256").hexdigest() == expected
        if matches:
            target.chmod(0o755)
            return
    target.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/buchgr/bazel-remote/releases/download/v{VERSION}/bazel-remote-{VERSION}-linux-{architecture}"
    temporary = None
    try:
        with urllib.request.urlopen(url, timeout=60) as source, tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            digest = hashlib.sha256()
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError("engine release checksum mismatch")
        temporary.chmod(0o755)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
