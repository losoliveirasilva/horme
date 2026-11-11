"""Servidor local do Horme: API JSON, eventos (SSE) e arquivos da interface.

Só escuta em 127.0.0.1. Rejeita requisições com Host/Origin estranhos (DNS rebinding e
sites abertos no navegador tentando mexer no todo.txt).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import todotxt as tt
from storage import Busy, Conflict, TodoFile, Watcher, fingerprint, invert

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
DEFAULT_PORT = 8788
UNDO_DEPTH = 50

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}


class OpError(Exception):
    pass


# ---------------------------------------------------------------- configuração e caminhos

def xdg(var: str, fallback: str) -> Path:
    v = os.environ.get(var)
    return Path(v) if v else Path.home() / fallback


CONFIG_FILE = xdg("XDG_CONFIG_HOME", ".config") / "horme" / "config.json"
STATE_DIR = xdg("XDG_STATE_HOME", ".local/state") / "horme"


def load_config(path: Path = CONFIG_FILE) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_config(cfg: dict, path: Path = CONFIG_FILE) -> None:
    from storage import atomic_write
    atomic_write(path, (json.dumps(cfg, ensure_ascii=False, indent=2) + "\n").encode())


def resolve_todo_path(arg: str | None, env: dict, cwd: Path, cfg: dict) -> tuple[Path | None, str | None]:
    """Mesma ordem do Tuxedo (argumento, $TODO_FILE, $TODO_DIR/todo.txt, ./todo.txt),
    com a configuração do Horme antes do ./todo.txt."""
    if arg:
        return Path(arg).expanduser(), "arg"
    if env.get("TODO_FILE"):
        return Path(env["TODO_FILE"]).expanduser(), "TODO_FILE"
    if env.get("TODO_DIR"):
        return Path(env["TODO_DIR"]).expanduser() / "todo.txt", "TODO_DIR"
    if cfg.get("file"):
        return Path(cfg["file"]).expanduser(), "config"
    if (cwd / "todo.txt").is_file():
        return (cwd / "todo.txt").absolute(), "cwd"
    return None, None


def resolve_done_path(todo: Path, env: dict) -> Path:
    if env.get("DONE_FILE"):
        return Path(env["DONE_FILE"]).expanduser()
    return todo.parent / "done.txt"


# ---------------------------------------------------------------- aplicação

class App:
    def __init__(self, todo: Path | None, source: str | None, backups: bool = True):
        self.cond = threading.Condition()
        self.seq = 0
        self.fp = None
        self.undo: list[tuple[str, list[dict]]] = []
        self.backups = backups
        self.watcher: Watcher | None = None
        self.todo: TodoFile | None = None
        self.done: TodoFile | None = None
        self.source = None
        if todo:
            self.open(todo, source)

    # ---- arquivo
    def open(self, path: Path, source: str | None) -> None:
        if self.watcher:
            self.watcher.stop()
        path = Path(path).absolute()
        bdir = STATE_DIR / "backups" if self.backups else None
        self.todo = TodoFile(path, bdir)
        self.done = TodoFile(resolve_done_path(path, os.environ), bdir)
        self.source = source
        self.undo.clear()
        self.watcher = Watcher(path, self.notify)
        self.watcher.start()
        self.notify(None)

    def notify(self, _data=None) -> None:
        with self.cond:
            self.seq += 1
            self.cond.notify_all()

    def configurable(self) -> bool:
        return self.source in (None, "config", "cwd")

    def configure(self, file: str) -> None:
        if not self.configurable():
            raise OpError("o caminho está definido por variável de ambiente ou argumento")
        p = Path(file.strip()).expanduser()
        if not file.strip() or not p.is_absolute():
            raise OpError("informe um caminho absoluto (pode começar com ~)")
        if p.is_dir():
            p = p / "todo.txt"
        if not p.parent.is_dir():
            raise OpError(f"a pasta {p.parent} não existe")
        cfg = load_config()
        cfg["file"] = str(p)
        save_config(cfg)
        self.open(p, "config")

    # ---- estado para a interface
    def state(self) -> dict:
        if not self.todo:
            return {"file": None, "today": date.today().isoformat(), "seq": self.seq,
                    "suggest": str(Path.home() / "todo.txt")}
        data, doc = self.todo.read()
        self.fp = fingerprint(data)
        tasks, unreadable = [], 0
        for i, ln in enumerate(doc.lines):
            t = tt.parse(ln.text)
            if t is None:
                continue
            j = tt.to_json(t, i)
            if _has_surrogates(ln.text):
                # bytes inválidos em UTF-8: mostrados, mas só editáveis num editor de texto
                j["raw"] = _printable(ln.text)
                j["readonly"] = True
                unreadable += 1
            tasks.append(j)
        path = self.todo.path
        real = Path(os.path.realpath(path))
        return {
            "seq": self.seq,
            "fp": self.fp,
            "today": date.today().isoformat(),
            "file": {
                "path": str(path),
                "real": str(real) if real != path else None,
                "source": self.source,
                "exists": data is not None,
                "writable": os.access(real if data is not None else real.parent, os.W_OK),
                "configurable": self.configurable(),
                "done": str(self.done.path),
                "eol": "CRLF" if doc.eol == "\r\n" else "LF",
            },
            "tasks": tasks,
            "unreadable": unreadable,
            "undo": self.undo[-1][0] if self.undo else None,
        }

    def archive_state(self) -> dict:
        data, doc = self.done.read()
        tasks = []
        for i, ln in enumerate(doc.lines):
            t = tt.parse(ln.text)
            if t is not None:
                j = tt.to_json(t, i)
                j["raw"] = _printable(ln.text)
                j["readonly"] = True
                tasks.append(j)
        return {"path": str(self.done.path), "exists": data is not None, "tasks": tasks}

    # ---- operações
    def op(self, body: dict) -> dict:
        if not self.todo:
            raise OpError("nenhum arquivo configurado")
        kind = body.get("op")
        if kind == "undo":
            return self._undo()
        if kind == "archive":
            return self._archive()
        today = date.today()
        handler = OPS.get(kind)
        if handler is None:
            raise OpError(f"operação desconhecida: {kind!r}")

        def fn(doc):
            changes: list[dict] = []
            info: dict = {}
            handler(doc, body, today, changes, info)
            return changes, info

        (changes, info), _ = self.todo.mutate(fn)
        if changes:
            self.undo.append((LABELS.get(kind, kind), changes))
            del self.undo[:-UNDO_DEPTH]
            self.notify()
        return info

    def _undo(self) -> dict:
        if not self.undo:
            raise OpError("nada para desfazer")
        label, changes = self.undo[-1]
        inverse = [invert(c) for c in reversed(changes)]

        def fn(doc):
            for c in inverse:
                doc.apply(c)

        try:
            self.todo.mutate(fn)
        except Conflict:
            self.undo.pop()
            raise OpError(f"não dá para desfazer “{label}”: a linha mudou fora do Horme") from None
        self.undo.pop()
        self.notify()
        return {"undone": label}

    def _archive(self) -> dict:
        """Move as concluídas para o done.txt (primeiro grava o done.txt, depois tira do todo.txt:
        uma falha no meio duplica linhas, nunca perde)."""
        _, doc = self.todo.read()
        done = [(i, ln.text) for i, ln in enumerate(doc.lines)
                if (t := tt.parse(ln.text)) and t.done and not _has_surrogates(ln.text)]
        if not done:
            return {"archived": 0}

        def add(ddoc):
            for _, text in done:
                ddoc.append(text)

        self.done.mutate(add)

        def remove(tdoc):
            for i, text in reversed(done):
                try:
                    tdoc.delete(tdoc.locate(text, i))
                except Conflict:
                    pass  # já saiu do todo.txt por outro caminho

        self.todo.mutate(remove)
        self.notify()
        return {"archived": len(done)}


def _has_surrogates(s: str) -> bool:
    return any("\udc80" <= c <= "\udcff" for c in s)


def _printable(s: str) -> str:
    return s.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


# ---------------------------------------------------------------- operações de linha

def _target(doc, body) -> int:
    raw = body.get("raw")
    if not isinstance(raw, str):
        raise OpError("faltou a linha original (raw)")
    hint = body.get("i")
    return doc.locate(raw, hint if isinstance(hint, int) else None)


def _replace(doc, i, new, changes):
    if new != doc.lines[i].text:
        changes.append(doc.replace(i, new))


def op_add(doc, body, today, changes, info):
    text = tt.single_line(str(body.get("text", "")))
    if not tt.parse(text):
        raise OpError("tarefa vazia")
    if body.get("created", True):
        text = tt.ensure_created(text, today)
    changes.append(doc.append(text))
    info["raw"] = text
    info["i"] = changes[-1]["i"]


def op_edit(doc, body, today, changes, info):
    i = _target(doc, body)
    text = tt.single_line(str(body.get("text", "")))
    if not tt.parse(text):
        raise OpError("a tarefa não pode ficar vazia (use excluir)")
    _replace(doc, i, text, changes)
    info["raw"], info["i"] = text, i


def op_complete(doc, body, today, changes, info):
    i = _target(doc, body)
    raw = doc.lines[i].text
    t = tt.parse(raw)
    if t.done:
        return
    _replace(doc, i, tt.complete(raw, today), changes)
    info["raw"], info["i"] = doc.lines[i].text, i
    nxt = tt.next_instance(raw, today)
    if nxt:
        ident = tt.recurrence_identity(nxt)
        live = any(j != i and (p := tt.parse(ln.text)) and not p.done and tt.recurrence_identity(ln.text) == ident
                   for j, ln in enumerate(doc.lines))
        if live:
            info["spawnSkipped"] = True
        else:
            changes.append(doc.insert(i + 1, nxt))
            info["spawned"] = nxt


def op_uncomplete(doc, body, today, changes, info):
    i = _target(doc, body)
    _replace(doc, i, tt.uncomplete(doc.lines[i].text), changes)
    info["raw"], info["i"] = doc.lines[i].text, i


def op_delete(doc, body, today, changes, info):
    changes.append(doc.delete(_target(doc, body)))


def op_priority(doc, body, today, changes, info):
    i = _target(doc, body)
    _replace(doc, i, tt.set_priority(doc.lines[i].text, body.get("value") or None), changes)
    info["raw"], info["i"] = doc.lines[i].text, i


def op_set(doc, body, today, changes, info):
    i = _target(doc, body)
    key = str(body.get("key", ""))
    val = body.get("value")
    raw = tt.set_value(doc.lines[i].text, key, str(val) if val else None)
    for extra in body.get("clear") or []:  # ex.: tirar `day:` junto com `rec:`
        raw = tt.set_value(raw, str(extra), None)
    _replace(doc, i, raw, changes)
    info["raw"], info["i"] = doc.lines[i].text, i


def op_tag(doc, body, today, changes, info):
    i = _target(doc, body)
    sigil, name = str(body.get("sigil", "")), str(body.get("name", "")).lstrip("+@")
    raw = doc.lines[i].text
    new = tt.remove_tag(raw, sigil, name) if body.get("remove") else tt.add_tag(raw, sigil, name)
    _replace(doc, i, new, changes)
    info["raw"], info["i"] = doc.lines[i].text, i


OPS = {
    "add": op_add, "edit": op_edit, "complete": op_complete, "uncomplete": op_uncomplete,
    "delete": op_delete, "priority": op_priority, "set": op_set, "tag": op_tag,
}
LABELS = {
    "add": "adicionar tarefa", "edit": "editar tarefa", "complete": "concluir tarefa",
    "uncomplete": "reabrir tarefa", "delete": "excluir tarefa", "priority": "mudar prioridade",
    "set": "mudar data/recorrência", "tag": "mudar projeto/contexto",
}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "Horme"
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):
        if self.server.verbose:  # type: ignore[attr-defined]
            super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _host_ok(self) -> bool:
        if self.headers.get("Host", "") not in self.server.allowed_hosts:  # type: ignore[attr-defined]
            self._json(HTTPStatus.FORBIDDEN, {"error": "host não permitido"})
            return False
        return True

    def do_GET(self):
        if not self._host_ok():
            return
        path = urlsplit(self.path).path
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                body = (WEB / name).read_bytes()
            except FileNotFoundError:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "não encontrado"})
            extra = {"Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                                                "connect-src 'self'; frame-ancestors 'none'"} if name == "index.html" else None
            return self._send(HTTPStatus.OK, body, ctype, extra)
        if path == "/api/state":
            return self._json(HTTPStatus.OK, self.app.state())
        if path == "/api/archive":
            if not self.app.todo:
                return self._json(HTTPStatus.OK, {"tasks": []})
            return self._json(HTTPStatus.OK, self.app.archive_state())
        if path == "/api/events":
            return self._events()
        self._json(HTTPStatus.NOT_FOUND, {"error": "não encontrado"})

    do_HEAD = do_GET

    def do_POST(self):
        if not self._host_ok():
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc not in self.server.allowed_hosts:  # type: ignore[attr-defined]
            return self._json(HTTPStatus.FORBIDDEN, {"error": "origem não permitida"})
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "use application/json"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 <= length <= 1_000_000:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "tamanho inválido"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "JSON inválido"})

        path = urlsplit(self.path).path
        try:
            if path == "/api/op":
                info = self.app.op(body)
            elif path == "/api/config":
                self.app.configure(str(body.get("file", "")))
                info = {}
            else:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "não encontrado"})
        except Conflict:
            return self._json(HTTPStatus.CONFLICT, {
                "error": "a tarefa mudou fora do Horme; a lista foi atualizada", "state": self.app.state()})
        except (OpError, tt.EditError) as e:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e), "state": self.app.state()})
        except Busy:
            return self._json(HTTPStatus.SERVICE_UNAVAILABLE, {
                "error": "o arquivo está mudando sem parar; tente de novo", "state": self.app.state()})
        except OSError as e:
            return self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"erro ao gravar: {e}"})
        self._json(HTTPStatus.OK, {"ok": True, **info, "state": self.app.state()})

    def _events(self):
        if self.command == "HEAD":
            return self._send(HTTPStatus.OK, b"", "text/event-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        app, last = self.app, None
        self.close_connection = True
        while not self.server.closing:  # type: ignore[attr-defined]
            with app.cond:
                app.cond.wait_for(lambda: app.seq != last or self.server.closing, timeout=15)  # type: ignore[attr-defined]
                seq = app.seq
            try:
                if seq != last:
                    last = seq
                    self.wfile.write(f"event: change\ndata: {json.dumps({'seq': seq})}\n\n".encode())
                else:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
            except OSError:
                return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, app: App, verbose=False):
        super().__init__(addr, Handler)
        self.app = app
        self.verbose = verbose
        self.closing = False
        host, port = self.server_address[:2]
        names = {"127.0.0.1", "localhost", "[::1]", host if ":" not in host else f"[{host}]"}
        self.allowed_hosts = {f"{n}:{port}" for n in names}

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # navegador fechou a aba ou o stream de eventos
        super().handle_error(request, client_address)

    def server_close(self):
        self.closing = True
        with self.app.cond:
            self.app.cond.notify_all()
        super().server_close()


def open_browser(url: str) -> None:
    opener = shutil.which("xdg-open")
    if opener:
        subprocess.Popen([opener, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        webbrowser.open(url)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="horme", description="Gerenciador de tarefas todo.txt no navegador (localhost).")
    ap.add_argument("file", nargs="?", help="arquivo todo.txt (padrão: $TODO_FILE, $TODO_DIR/todo.txt, configuração, ./todo.txt)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("HORME_PORT", DEFAULT_PORT)))
    ap.add_argument("--host", default="127.0.0.1", help="só loopback por padrão")
    ap.add_argument("--open", action="store_true", help="abre o navegador")
    ap.add_argument("--no-backup", action="store_true", help=f"não guardar cópias em {STATE_DIR / 'backups'}")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    path, source = resolve_todo_path(args.file, os.environ, Path.cwd(), load_config())
    app = App(path, source, backups=not args.no_backup)
    try:
        srv = Server((args.host, args.port), app, verbose=args.verbose)
    except OSError as e:
        print(f"horme: não consegui escutar em {args.host}:{args.port} ({e.strerror}). Use --port.", file=sys.stderr)
        return 1
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '::1') else args.host}:{args.port}/"
    print(f"Horme em {url}", flush=True)
    print(f"arquivo: {path} ({source})" if path else "arquivo: nenhum — escolha na página", flush=True)
    if args.open:
        threading.Timer(0.3, open_browser, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
