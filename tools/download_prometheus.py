#!/usr/bin/env python3
"""Fetch the pinned Linux amd64 Prometheus used by isolated contract tests."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = '3.15.0'
SHA256 = '2a542df32eac02ee17b9d844fb2aa1de00dafa5476579ba8a3ba862e9d572ea0'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('fixture currently supports Linux amd64 only')
    target = args.destination.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    name = f'prometheus-{VERSION}.linux-amd64'
    with tempfile.TemporaryDirectory(prefix='prometheus-download-', dir=target.parent) as directory:
        archive = Path(directory) / 'release.tar.gz'
        digest = hashlib.sha256()
        with urllib.request.urlopen(f'https://github.com/prometheus/prometheus/releases/download/v{VERSION}/{name}.tar.gz', timeout=60) as source, archive.open('wb') as output:
            while chunk := source.read(1024*1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != SHA256:
            raise RuntimeError('Prometheus release checksum mismatch')
        # Extract only the named regular binary, never archive paths or links.
        binary = Path(directory) / 'prometheus'
        with tarfile.open(archive) as release:
            member = release.getmember(name + '/prometheus')
            if not member.isfile(): raise RuntimeError('Unexpected binary member')
            with release.extractfile(member) as source, binary.open('wb') as output:
                shutil.copyfileobj(source, output)
        binary.chmod(0o755)
        os.replace(binary, target)

if __name__ == '__main__':
    main()
