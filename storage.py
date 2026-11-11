"""Leitura e escrita segura do todo.txt.

- Cada operação relê o arquivo do disco, localiza a linha-alvo pelo texto que a interface
  viu (com a posição só como dica) e altera apenas essa linha. Outras linhas, quebras de
  linha (LF/CRLF), BOM, linhas em branco e bytes não-UTF-8 ficam intocados.
- Escrita atômica (arquivo temporário no mesmo diretório + fsync + rename), seguindo
  symlinks e preservando permissões.
- Antes do rename o arquivo é relido; se outro programa escreveu no meio do caminho, a
  operação é refeita sobre o conteúdo novo, em vez de sobrescrevê-lo.
- Um observador acompanha o arquivo e avisa quando ele muda (por qualquer programa).
"""
from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


class Conflict(Exception):
    """A linha que a interface queria alterar não existe mais no arquivo."""


class Busy(Exception):
    """O arquivo mudou durante todas as tentativas de escrita."""


# ---------------------------------------------------------------- documento em memória

@dataclass
class Line:
    text: str
    term: str  # "\n", "\r\n" ou "" (última linha sem quebra)


class Doc:
    def __init__(self, data: bytes | None):
        self.exists = data is not None
        data = data or b""
        text = data.decode("utf-8", "surrogateescape")
        self.bom = text.startswith("﻿")
        if self.bom:
            text = text[1:]
        self.lines: list[Line] = []
        for piece in re.split(r"(?<=\n)", text):
            if piece == "":
                continue
            if piece.endswith("\r\n"):
                self.lines.append(Line(piece[:-2], "\r\n"))
            elif piece.endswith("\n"):
                self.lines.append(Line(piece[:-1], "\n"))
            else:
                self.lines.append(Line(piece, ""))
        crlf = sum(1 for ln in self.lines if ln.term == "\r\n")
        lf = sum(1 for ln in self.lines if ln.term == "\n")
        self.eol = "\r\n" if crlf > lf else "\n"
        self.changed = False

    def to_bytes(self) -> bytes:
        text = ("﻿" if self.bom else "") + "".join(ln.text + ln.term for ln in self.lines)
        return text.encode("utf-8", "surrogateescape")

    def texts(self) -> list[str]:
        return [ln.text for ln in self.lines]

    # ---- localização tolerante: o texto manda, a posição é só dica
    def locate(self, text: str, hint: int | None) -> int:
        n = len(self.lines)
        if hint is not None and 0 <= hint < n and self.lines[hint].text == text:
            return hint
        hits = [i for i, ln in enumerate(self.lines) if ln.text == text]
        if not hits:
            raise Conflict(text)
        if hint is None:
            return hits[0]
        return min(hits, key=lambda i: abs(i - hint))

    # ---- primitivas (registram mudança para o desfazer)
    def replace(self, i: int, new: str) -> dict:
        old = self.lines[i].text
        self.lines[i].text = new
        self.changed = True
        return {"op": "replace", "i": i, "old": old, "new": new}

    def insert(self, i: int, text: str) -> dict:
        i = max(0, min(i, len(self.lines)))
        after = self.lines[i - 1].text if i > 0 else None
        if i == len(self.lines) and self.lines and self.lines[-1].term == "":
            # arquivo sem quebra no fim: a nova última linha herda a ausência
            self.lines[-1].term = self.eol
            self.lines.append(Line(text, ""))
        else:
            self.lines.insert(i, Line(text, self.eol))
        self.changed = True
        return {"op": "insert", "i": i, "new": text, "after": after}

    def delete(self, i: int) -> dict:
        ln = self.lines.pop(i)
        if ln.term == "" and self.lines:
            self.lines[-1].term = ""
        self.changed = True
        after = self.lines[i - 1].text if i > 0 and i - 1 < len(self.lines) else None
        return {"op": "delete", "i": i, "old": ln.text, "after": after}

    def append(self, text: str) -> dict:
        # não cola tarefa nova depois de linhas em branco no fim do arquivo
        i = len(self.lines)
        while i > 0 and self.lines[i - 1].text.strip() == "" and self.lines[i - 1].term != "":
            i -= 1
        return self.insert(i, text)

    # ---- reaplicação (desfazer)
    def apply(self, change: dict) -> dict:
        op = change["op"]
        if op == "replace":
            return self.replace(self.locate(change["old"], change["i"]), change["new"])
        if op == "delete":
            return self.delete(self.locate(change["old"], change["i"]))
        if op == "insert":
            i = change["i"]
            if change.get("after") is not None:
                try:
                    i = self.locate(change["after"], change["i"] - 1) + 1
                except Conflict:
                    pass
            elif i != 0:
                i = min(i, len(self.lines))
            return self.insert(i, change["new"])
        raise ValueError(op)


def invert(change: dict) -> dict:
    op = change["op"]
    if op == "replace":
        return {"op": "replace", "i": change["i"], "old": change["new"], "new": change["old"]}
    if op == "insert":
        return {"op": "delete", "i": change["i"], "old": change["new"]}
    if op == "delete":
        return {"op": "insert", "i": change["i"], "new": change["old"], "after": change.get("after")}
    raise ValueError(op)


# ---------------------------------------------------------------- arquivo

def _read(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def atomic_write(path: Path, data: bytes) -> None:
    """Grava `data` no destino real de `path` (segue symlink) via temporário + rename."""
    real = Path(os.path.realpath(path))
    real.parent.mkdir(parents=True, exist_ok=True)
    tmp = real.with_name(f".{real.name}.horme-{os.getpid()}-{threading.get_ident()}.tmp")
    try:
        mode = real.stat().st_mode & 0o7777
    except FileNotFoundError:
        mode = None
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, real)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    try:
        dfd = os.open(real.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def fingerprint(data: bytes | None) -> str:
    if data is None:
        return "missing"
    return hashlib.sha1(data).hexdigest()[:16]


class TodoFile:
    """Um arquivo todo.txt (ou done.txt) com escrita segura e cópias de segurança."""

    RETRIES = 8
    KEEP_BACKUPS = 60

    def __init__(self, path: Path, backup_dir: Path | None = None):
        self.path = Path(path)
        self.backup_dir = backup_dir
        self.lock = threading.RLock()

    def read(self) -> tuple[bytes | None, Doc]:
        data = _read(self.path)
        return data, Doc(data)

    def mutate(self, fn):
        """Aplica `fn(doc)` sobre o conteúdo atual do disco e grava se algo mudou.

        `fn` precisa ser repetível: se o arquivo mudar entre a leitura e o rename, ele é
        chamado de novo sobre o conteúdo novo. Retorna `(resultado_de_fn, doc)`.
        """
        with self.lock:
            for _ in range(self.RETRIES):
                before = _read(self.path)
                doc = Doc(before)
                result = fn(doc)
                if not doc.changed:
                    return result, doc
                data = doc.to_bytes()
                if _read(self.path) != before:
                    continue  # alguém escreveu enquanto calculávamos: refaz sobre o novo
                self._backup(before)
                atomic_write(self.path, data)
                return result, doc
            raise Busy(str(self.path))

    def _backup(self, data: bytes | None) -> None:
        if not self.backup_dir or not data:
            return
        try:
            self.backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            (self.backup_dir / f"{self.path.name}.{stamp}").write_bytes(data)
            olds = sorted(self.backup_dir.glob(f"{self.path.name}.*"))
            for old in olds[: max(0, len(olds) - self.KEEP_BACKUPS)]:
                old.unlink(missing_ok=True)
        except OSError:
            pass  # backup nunca impede a gravação


# ---------------------------------------------------------------- observador

class Watcher(threading.Thread):
    """Consulta o arquivo a cada `interval` segundos e chama `on_change(data)` quando o conteúdo muda.

    Usa stat (mtime, tamanho, inode) como filtro barato e o hash do conteúdo como verdade,
    então renomeações atômicas, editores e sincronizadores são detectados igualmente.
    """

    def __init__(self, path: Path, on_change, interval: float = 0.25):
        super().__init__(daemon=True, name="horme-watcher")
        self.path = Path(path)
        self.on_change = on_change
        self.interval = interval
        self._stop = threading.Event()
        self._sig = self._stat_sig()
        self._fp = fingerprint(_read(self.path))

    def _stat_sig(self):
        try:
            st = os.stat(self.path)
            return (st.st_mtime_ns, st.st_size, st.st_ino)
        except FileNotFoundError:
            return None
        except OSError:
            return "error"

    FULL_CHECK_EVERY = 8  # o mtime tem granularidade de milissegundos: relê tudo a cada ~2 s

    def run(self):
        tick = 0
        while not self._stop.wait(self.interval):
            tick += 1
            sig = self._stat_sig()
            if sig == self._sig and tick % self.FULL_CHECK_EVERY:
                continue
            self._sig = sig
            data = _read(self.path)
            fp = fingerprint(data)
            if fp != self._fp:
                self._fp = fp
                try:
                    self.on_change(data)
                except Exception:  # noqa: BLE001 — o observador não pode morrer
                    pass

    def stop(self):
        self._stop.set()


def wait_for(predicate, timeout=3.0, step=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(step)
    return predicate()
