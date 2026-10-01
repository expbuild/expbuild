#!/usr/bin/env python3
"""Download the exact Bazel client used by the contract tests; never resolve 'latest'."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import tempfile
import urllib.request

VERSION = "8.8.1"
# Published asset digests from the official 8.8.1 GitHub release.
DIGESTS = {"amd64": "5b5bab2095065817d3416ca9a0678bd39c10c9ede432dbe8187bfe74de285160"}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    architecture = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if platform.system() != "Linux" or architecture not in DIGESTS:
        parser.error("this downloader supports Linux amd64")
    expected = DIGESTS[architecture]
    target = args.destination.resolve()
    if target.is_file():
        with target.open("rb") as existing:
            matches = hashlib.file_digest(existing, "sha256").hexdigest() == expected
        if matches:
            target.chmod(0o755)
            return
    target.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/bazelbuild/bazel/releases/download/{VERSION}/bazel-{VERSION}-linux-x86_64"
    temporary = None
    try:
        with urllib.request.urlopen(url, timeout=60) as source, tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            digest = hashlib.sha256()
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError("Bazel release checksum mismatch")
        temporary.chmod(0o755)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
