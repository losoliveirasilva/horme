import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from storage import Conflict, Doc, TodoFile, Watcher, atomic_write, invert, wait_for  # noqa: E402


class DocRoundTrip(unittest.TestCase):
    def roundtrip(self, data: bytes):
        self.assertEqual(Doc(data).to_bytes(), data)

    def test_preserves_bytes(self):
        for data in [b"", b"a\n", b"a", b"a\r\nb\r\n", b"a\n\n\nb\n", b"\xef\xbb\xbfa\nb", b"a\xff\xfeb\n", b"a\nb\r\nc"]:
            self.roundtrip(data)

    def test_edit_one_line_keeps_others(self):
        d = Doc(b"\xef\xbb\xbfa\r\n\r\nb\r\nc")
        d.replace(d.locate("b", 2), "B")
        self.assertEqual(d.to_bytes(), b"\xef\xbb\xbfa\r\n\r\nB\r\nc")

    def test_append_respects_missing_final_newline(self):
        d = Doc(b"a\nb")
        d.append("c")
        self.assertEqual(d.to_bytes(), b"a\nb\nc")
        d = Doc(b"a\r\n")
        d.append("c")
        self.assertEqual(d.to_bytes(), b"a\r\nc\r\n")

    def test_append_before_trailing_blank_lines(self):
        d = Doc(b"a\n\n\n")
        d.append("c")
        self.assertEqual(d.to_bytes(), b"a\nc\n\n\n")

    def test_delete_last_line_without_newline(self):
        d = Doc(b"a\nb")
        d.delete(1)
        self.assertEqual(d.to_bytes(), b"a")

    def test_locate_relocates_after_external_insert(self):
        d = Doc(b"novo\na\nb\n")
        self.assertEqual(d.locate("b", 1), 2)
        with self.assertRaises(Conflict):
            d.locate("sumiu", 0)

    def test_locate_prefers_nearest_duplicate(self):
        d = Doc(b"x\ny\nx\n")
        self.assertEqual(d.locate("x", 2), 2)
        self.assertEqual(d.locate("x", 1), 0)

    def test_undo_survives_external_append(self):
        d = Doc(b"a\nb\n")
        changes = [d.replace(0, "x a"), d.insert(1, "spawn")]
        # outro programa acrescenta linhas no começo e no fim
        d2 = Doc(b"agente\n" + d.to_bytes() + b"agente2\n")
        for c in [invert(c) for c in reversed(changes)]:
            d2.apply(c)
        self.assertEqual(d2.to_bytes(), b"agente\na\nb\nagente2\n")

    def test_undo_delete_reinserts_after_anchor(self):
        d = Doc(b"a\nb\nc\n")
        ch = d.delete(1)
        d2 = Doc(b"novo\n" + d.to_bytes())
        d2.apply(invert(ch))
        self.assertEqual(d2.to_bytes(), b"novo\na\nb\nc\n")


class FileWrites(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="horme-test-"))
        self.path = self.dir / "todo.txt"

    def test_atomic_write_follows_symlink_and_keeps_mode(self):
        real = self.dir / "real.txt"
        real.write_bytes(b"a\n")
        os.chmod(real, 0o600)
        self.path.symlink_to(real)
        atomic_write(self.path, b"b\n")
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(real.read_bytes(), b"b\n")
        self.assertEqual(real.stat().st_mode & 0o777, 0o600)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["real.txt", "todo.txt"])

    def test_mutate_retries_when_file_changes_midway(self):
        self.path.write_bytes(b"a\nb\n")
        f = TodoFile(self.path)
        calls = []

        def fn(doc):
            calls.append(1)
            if len(calls) == 1:  # simula outro programa escrevendo entre a leitura e o rename
                self.path.write_bytes(b"agente\na\nb\n")
            doc.replace(doc.locate("b", 1), "B")

        f.mutate(fn)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.path.read_bytes(), b"agente\na\nB\n")

    def test_mutate_without_change_does_not_write(self):
        self.path.write_bytes(b"a\n")
        before = self.path.stat().st_mtime_ns
        TodoFile(self.path).mutate(lambda doc: None)
        self.assertEqual(self.path.stat().st_mtime_ns, before)

    def test_creates_missing_file(self):
        TodoFile(self.path).mutate(lambda doc: doc.append("primeira"))
        self.assertEqual(self.path.read_bytes(), b"primeira\n")

    def test_backups_rotate(self):
        self.path.write_bytes(b"v0\n")
        f = TodoFile(self.path, self.dir / "bk")
        f.KEEP_BACKUPS = 3
        for n in range(5):
            f.mutate(lambda doc, n=n: doc.replace(0, f"v{n + 1}"))
        kept = sorted((self.dir / "bk").iterdir())
        self.assertEqual(len(kept), 3)
        self.assertEqual(kept[-1].read_bytes(), b"v4\n")

    def test_watcher_sees_external_changes(self):
        self.path.write_bytes(b"a\n")
        seen = []
        w = Watcher(self.path, lambda data: seen.append(data), interval=0.02)
        w.start()
        try:
            atomic_write(self.path, b"a\nb\n")
            self.assertTrue(wait_for(lambda: seen and seen[-1] == b"a\nb\n"))
            with open(self.path, "ab") as fh:  # escrita no lugar (mesmo inode)
                fh.write(b"c\n")
            self.assertTrue(wait_for(lambda: seen[-1] == b"a\nb\nc\n"))
            self.path.unlink()
            self.assertTrue(wait_for(lambda: seen[-1] is None))
        finally:
            w.stop()

    def test_concurrent_mutations_do_not_lose_lines(self):
        self.path.write_bytes(b"")
        f = TodoFile(self.path)

        def worker(k):
            for n in range(20):
                f.mutate(lambda doc, k=k, n=n: doc.append(f"t{k}-{n}"))

        ts = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(self.path.read_text().splitlines()), 80)


if __name__ == "__main__":
    unittest.main()
