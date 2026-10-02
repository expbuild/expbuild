"""Small shared controls for disposable benchmark processes and evidence."""
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess

HERE = Path(__file__).resolve().parent
WORKLOADS = json.loads((HERE / 'workloads.json').read_text())


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def file_manifest(directory):
    return {str(p.relative_to(directory)): sha256(p)
            for p in sorted(Path(directory).rglob('*')) if p.is_file()}


def timed_command(command, resource_path, system=None):
    system = system or platform.system()
    if system not in ('Darwin', 'Linux'):
        raise ValueError('Resource measurement requires BSD time on macOS or GNU time on Linux')
    return ['/usr/bin/time', '-l' if system == 'Darwin' else '-v', '-o', str(resource_path), *command]


def stop(process):
    """Only signal a process group created with start_new_session=True here."""
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=10)
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)


def run_command(command, cwd, log_path, environment, timeout=600):
    with log_path.open('w') as log:
        process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                   env=environment, start_new_session=True)
        try:
            return process.wait(timeout=timeout)
        finally:
            stop(process)
