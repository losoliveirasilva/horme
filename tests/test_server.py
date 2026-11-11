import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402

TODAY = date.today().isoformat()


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="horme-srv-"))
        self.todo = self.dir / "todo.txt"
        self.todo.write_text("(A) 2026-01-01 Pagar +casa due:2026-01-10 rec:+1m\n2026-01-02 Ler livro @casa\n")
        os.environ.pop("DONE_FILE", None)
        self.app = server.App(self.todo, "arg", backups=False)
        self.app.watcher.interval = 0.02
        self.srv = server.Server(("127.0.0.1", 0), self.app)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.app.watcher.stop()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        out = r.read()
        c.close()
        return r.status, (json.loads(out) if out and r.getheader("Content-Type", "").startswith("application/json") else out)

    def task(self, st, needle):
        return next(t for t in st["tasks"] if needle in t["raw"])

    def test_rejects_foreign_host_and_origin(self):
        self.assertEqual(self.req("GET", "/api/state", headers={"Host": "evil.example:80"})[0], 403)
        st, _ = self.req("POST", "/api/op", {"op": "add", "text": "x"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(st, 403)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/api/op", body=b'{"op":"add","text":"x"}', headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "text/plain"})
        r = c.getresponse()
        r.read()
        c.close()
        self.assertEqual(r.status, 415)
        self.assertNotIn("x\n", self.todo.read_text())

    def test_serves_page(self):
        st, body = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn(b"<title>Horme</title>", body)

    def test_complete_recurring_and_undo(self):
        _, st = self.req("GET", "/api/state")
        t = self.task(st, "Pagar")
        code, res = self.req("POST", "/api/op", {"op": "complete", "i": t["i"], "raw": t["raw"]})
        self.assertEqual(code, 200, res)
        lines = self.todo.read_text().splitlines()
        self.assertEqual(lines[0], f"x {TODAY} 2026-01-01 Pagar +casa due:2026-01-10 rec:+1m pri:A")
        self.assertEqual(lines[1], f"(A) {TODAY} Pagar +casa due:2026-02-10 rec:+1m")
        # outro programa acrescenta uma linha antes do desfazer
        with open(self.todo, "a") as f:
            f.write("tarefa do agente +ia\n")
        code, res = self.req("POST", "/api/op", {"op": "undo"})
        self.assertEqual(code, 200, res)
        self.assertEqual(self.todo.read_text(),
                         "(A) 2026-01-01 Pagar +casa due:2026-01-10 rec:+1m\n2026-01-02 Ler livro @casa\ntarefa do agente +ia\n")

    def test_conflict_when_line_changed_externally(self):
        _, st = self.req("GET", "/api/state")
        t = self.task(st, "Ler livro")
        self.todo.write_text("(A) 2026-01-01 Pagar +casa due:2026-01-10 rec:+1m\n2026-01-02 Ler livro @casa @agora\n")
        code, res = self.req("POST", "/api/op", {"op": "delete", "i": t["i"], "raw": t["raw"]})
        self.assertEqual(code, 409)
        self.assertIn("@agora", self.todo.read_text())
        self.assertTrue(any("@agora" in x["raw"] for x in res["state"]["tasks"]))

    def test_relocates_after_external_insert(self):
        _, st = self.req("GET", "/api/state")
        t = self.task(st, "Ler livro")
        self.todo.write_text("nova do agente\n" + self.todo.read_text())
        code, _ = self.req("POST", "/api/op", {"op": "priority", "i": t["i"], "raw": t["raw"], "value": "B"})
        self.assertEqual(code, 200)
        self.assertIn("(B) 2026-01-02 Ler livro @casa", self.todo.read_text().splitlines()[2])

    def test_add_set_tag_edit(self):
        code, res = self.req("POST", "/api/op", {"op": "add", "text": "(C) Nova tarefa\ncom quebra"})
        self.assertEqual(code, 200)
        self.assertEqual(res["raw"], f"(C) {TODAY} Nova tarefa com quebra")
        ref = {"i": res["i"], "raw": res["raw"]}
        code, res = self.req("POST", "/api/op", {"op": "set", **ref, "key": "due", "value": "2026-12-01"})
        ref = {"i": res["i"], "raw": res["raw"]}
        code, res = self.req("POST", "/api/op", {"op": "tag", **ref, "sigil": "+", "name": "proj"})
        ref = {"i": res["i"], "raw": res["raw"]}
        self.assertEqual(res["raw"], f"(C) {TODAY} Nova tarefa com quebra due:2026-12-01 +proj")
        code, res = self.req("POST", "/api/op", {"op": "set", **ref, "key": "due", "value": "a b"})
        self.assertEqual(code, 400)
        code, res = self.req("POST", "/api/op", {"op": "edit", **ref, "text": "   "})
        self.assertEqual(code, 400)

    def test_archive_moves_done_lines(self):
        self.todo.write_text("x 2026-01-05 feito\npendente\nx 2026-01-06 outro\n")
        code, res = self.req("POST", "/api/op", {"op": "archive"})
        self.assertEqual((code, res["archived"]), (200, 2))
        self.assertEqual(self.todo.read_text(), "pendente\n")
        self.assertEqual((self.dir / "done.txt").read_text(), "x 2026-01-05 feito\nx 2026-01-06 outro\n")

    def test_events_stream_announces_external_change(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/api/events", headers={"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        first = r.fp.readline()
        self.assertTrue(first.startswith(b"event: change"))
        r.fp.readline(); r.fp.readline()
        with open(self.todo, "a") as f:
            f.write("externa\n")
        self.assertTrue(r.fp.readline().startswith(b"event: change"))
        c.close()


class PathResolution(unittest.TestCase):
    def test_order_matches_tuxedo(self):
        cwd = Path(tempfile.mkdtemp())
        (cwd / "todo.txt").write_text("")
        r = server.resolve_todo_path
        self.assertEqual(r("/a/x.txt", {"TODO_FILE": "/b"}, cwd, {})[1], "arg")
        self.assertEqual(r(None, {"TODO_FILE": "/b/t.txt", "TODO_DIR": "/c"}, cwd, {}), (Path("/b/t.txt"), "TODO_FILE"))
        self.assertEqual(r(None, {"TODO_DIR": "/c"}, cwd, {"file": "/d"}), (Path("/c/todo.txt"), "TODO_DIR"))
        self.assertEqual(r(None, {}, cwd, {"file": "/d/t.txt"}), (Path("/d/t.txt"), "config"))
        self.assertEqual(r(None, {}, cwd, {})[1], "cwd")
        self.assertEqual(r(None, {"TODO_FILE": ""}, Path("/nonexistent"), {}), (None, None))
        self.assertEqual(server.resolve_done_path(Path("/x/todo.txt"), {}), Path("/x/done.txt"))
        self.assertEqual(server.resolve_done_path(Path("/x/todo.txt"), {"DONE_FILE": "/y/d.txt"}), Path("/y/d.txt"))


if __name__ == "__main__":
    unittest.main()
