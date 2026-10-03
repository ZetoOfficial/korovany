#!/usr/bin/env python3
"""Extract a bounded release archive, never following links or escaping staging."""
import pathlib
import shutil
import sys
import tarfile

target = pathlib.Path(sys.argv[1])
total = 0
count = 0
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
    for item in archive:
        path = pathlib.PurePosixPath(item.name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("invalid release path")
        if path.parts[0] not in ("bin", "dist"):
            raise ValueError("release contains unexpected files")
        if not (item.isdir() or item.isfile()):
            raise ValueError("links and special files are forbidden")
        total += item.size
        count += 1
        if total > 128 * 1024 * 1024 or count > 2048:
            raise ValueError("release exceeds limits")
        output = target.joinpath(*path.parts)
        if item.isdir():
            output.mkdir(parents=True, exist_ok=True)
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(item) as source, output.open("xb") as dest:
                shutil.copyfileobj(source, dest)
            output.chmod(0o755 if str(path) == "bin/korovany" else 0o644)
for name in ("bin/korovany", "dist/index.html", "dist/arena/index.html"):
    if not (target / name).is_file():
        raise ValueError("release is missing " + name)
