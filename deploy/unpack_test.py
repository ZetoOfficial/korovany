import io
import pathlib
import subprocess
import tarfile
import tempfile
import unittest


class ReleaseArchiveTest(unittest.TestCase):
    def extract(self, entries):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            for name, kind in entries:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.linkname = "/tmp/escape"
                item.size = 1 if kind == tarfile.REGTYPE else 0
                archive.addfile(item, io.BytesIO(b"x") if item.size else None)
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run(
                ["python3", str(pathlib.Path(__file__).with_name("unpack.py")), folder],
                input=data.getvalue(), capture_output=True,
            )
            if result.returncode == 0:
                self.assertEqual((pathlib.Path(folder) / "bin/korovany").stat().st_mode & 0o777, 0o755)
            return result.returncode

    def test_valid_release(self):
        self.assertEqual(self.extract([(name, tarfile.REGTYPE) for name in
            ("bin/korovany", "dist/index.html", "dist/arena/index.html")]), 0)

    def test_rejects_unsafe_paths(self):
        for name in ("../outside", "/tmp/outside", "dist/../../outside", "etc/passwd"):
            with self.subTest(name=name):
                self.assertNotEqual(self.extract([(name, tarfile.REGTYPE)]), 0)

    def test_rejects_links_and_devices(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                self.assertNotEqual(self.extract([("dist/escape", kind)]), 0)

    def test_rejects_incomplete_release(self):
        self.assertNotEqual(self.extract([("dist/index.html", tarfile.REGTYPE)]), 0)
