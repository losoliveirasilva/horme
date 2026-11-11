"""Compara o Horme com o binário do Tuxedo, se ele estiver instalado.

Roda sempre em arquivos temporários (TODO_FILE/DONE_FILE/XDG_* apontam para um diretório
de teste), nunca no todo.txt de verdade.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import todotxt as tt  # noqa: E402

TUXEDO = shutil.which("tuxedo")


@unittest.skipUnless(TUXEDO, "tuxedo não instalado")
class TuxedoCompat(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="horme-tux-"))
        self.todo = self.dir / "todo.txt"
        self.env = {
            **os.environ,
            "TODO_FILE": str(self.todo), "TODO_DIR": str(self.dir), "DONE_FILE": str(self.dir / "done.txt"),
            "XDG_CONFIG_HOME": str(self.dir / "cfg"), "XDG_CACHE_HOME": str(self.dir / "cache"),
            "XDG_STATE_HOME": str(self.dir / "state"), "TUXEDO_NO_UPDATE_CHECK": "1",
        }

    def tux(self, *args):
        p = subprocess.run([TUXEDO, *args], env=self.env, cwd=self.dir, capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p.stdout

    def lines(self):
        return [ln for ln in self.todo.read_text().splitlines() if ln.strip()]

    CASES = [
        "(A) 2026-04-15 Pagar aluguel +casa due:2026-04-15 rec:+1m",
        "2026-04-01 Regar plantas @casa due:2026-04-03 rec:1w",
        "(F) 2026-07-17 Responder pesquisa semanal +trabalho @escritorio due:2026-11-13 rec:+1w t:0d",
        "Sem data rec:+2d",
        "2026-01-31 Fim do mês due:2026-01-31 rec:+1m",
        "2026-05-08 Dia útil due:2026-05-08 rec:+1b",
        "Duas datas due:2026-01-01 meio due:2026-02-01 rec:3d",
        "(B) 2026-01-01 Anual due:2024-02-29 rec:+1y key:val https://example.com/a",
    ]

    def test_spawned_line_is_identical(self):
        today = date.today()
        for raw in self.CASES:
            with self.subTest(raw=raw):
                self.todo.write_text(raw + "\n")
                self.tux("do", "1")
                got = self.lines()
                self.assertEqual(len(got), 2, got)
                self.assertEqual(got[1], tt.next_instance(raw, today))
                mine, theirs = tt.parse(tt.complete(raw, today)), tt.parse(got[0])
                self.assertTrue(theirs.done and mine.done)
                self.assertEqual(mine.done_date, theirs.done_date)

    def test_tuxedo_reads_horme_output(self):
        today = date.today()
        raw = "(A) 2026-04-15 Pagar +casa @banco due:2026-04-15 rec:+1m t:-3d"
        done = tt.complete(raw, today)
        nxt = tt.next_instance(raw, today)
        self.todo.write_text(done + "\n" + nxt + "\n")
        data = json.loads(self.tux("lsa", "--json"))
        items = data if isinstance(data, list) else (data.get("todo") or []) + (data.get("done") or [])
        by_raw = {i.get("raw") or i.get("text"): i for i in items}
        self.assertIn(done, by_raw, items)
        self.assertIn(nxt, by_raw, items)

    def test_tuxedo_keeps_day_tag_and_horme_heals_drift(self):
        raw = "(A) Relatório mensal +trabalho due:2027-01-31 t:-3d rec:+1m day:31"
        self.todo.write_text(raw + "\n")
        self.tux("do", "1")
        spawned = self.lines()[1]
        self.assertIn("due:2027-02-28", spawned)  # o Tuxedo ignora day:, mas mantém o metadado
        self.assertIn("day:31", spawned)
        healed = tt.next_instance(spawned, date(2027, 2, 28))
        self.assertIn("due:2027-03-31", healed)

    def test_duplicate_guard_matches(self):
        raw = "2026-04-01 Série due:2026-04-03 rec:+1w"
        live = tt.next_instance(raw, date.today())
        self.todo.write_text(raw + "\n" + live + "\n")
        self.tux("do", "1")
        self.assertEqual(len(self.lines()), 2)  # Tuxedo não gerou outra ocorrência


if __name__ == "__main__":
    unittest.main()
