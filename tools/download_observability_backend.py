#!/usr/bin/env python3
"""Pinned local API compatibility fixtures, not production deployment defaults."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

FIXTURES={
 'alertmanager':('prometheus/alertmanager','v0.28.1','alertmanager-0.28.1.linux-amd64.tar.gz','5ac7ab5e4b8ee5ce4d8fb0988f9cb275efcc3f181b4b408179fafee121693311','alertmanager-0.28.1.linux-amd64/alertmanager'),
 'loki':('grafana/loki','v3.5.0','loki-linux-amd64.zip','45131e8b799c46ad58a94fad6bf5e0d508ed56fb016d45a6eade7801b95377de','loki-linux-amd64'),
}
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('backend',choices=FIXTURES)
parser.add_argument('destination',type=Path)
args=parser.parse_args()
if platform.system()!='Linux' or platform.machine()!='x86_64':parser.error('Linux amd64 fixtures only')
repo,tag,name,expected,member=FIXTURES[args.backend]
target=args.destination.resolve();target.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='observation-download-',dir=target.parent) as directory:
    archive=Path(directory)/'archive';digest=hashlib.sha256()
    with urllib.request.urlopen(f'https://github.com/{repo}/releases/download/{tag}/{name}',timeout=60) as source,archive.open('wb') as output:
        while chunk:=source.read(1024*1024):digest.update(chunk);output.write(chunk)
    if digest.hexdigest()!=expected:raise RuntimeError('Fixture release checksum mismatch')
    binary=Path(directory)/'binary'
    if name.endswith('.zip'):
        with zipfile.ZipFile(archive) as release,release.open(member) as source,binary.open('wb') as output:shutil.copyfileobj(source,output)
    else:
        with tarfile.open(archive) as release:
            entry=release.getmember(member)
            if not entry.isfile():raise RuntimeError('Unexpected archive member')
            with release.extractfile(entry) as source,binary.open('wb') as output:shutil.copyfileobj(source,output)
    binary.chmod(0o755);os.replace(binary,target)
