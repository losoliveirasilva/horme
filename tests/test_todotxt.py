import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import todotxt as tt  # noqa: E402

D = date.fromisoformat


class SpecExamples(unittest.TestCase):
    """Exemplos do README oficial do formato."""

    def test_priority_rules(self):
        self.assertEqual(tt.parse("(A) Call Mom").priority, "A")
        for raw in ["Really gotta call Mom (A) @phone @someday", "(b) Get back to the boss", "(B)->Submit TPS report"]:
            self.assertIsNone(tt.parse(raw).priority, raw)

    def test_creation_date(self):
        self.assertEqual(tt.parse("2011-03-02 Document +TodoTxt task format").created, "2011-03-02")
        t = tt.parse("(A) 2011-03-02 Call Mom")
        self.assertEqual((t.priority, t.created), ("A", "2011-03-02"))
        self.assertIsNone(tt.parse("(A) Call Mom 2011-03-02").created)

    def test_projects_and_contexts(self):
        t = tt.parse("(A) Call Mom +Family +PeaceLoveAndHappiness @iphone @phone")
        self.assertEqual(t.projects, ["Family", "PeaceLoveAndHappiness"])
        self.assertEqual(t.contexts, ["iphone", "phone"])
        self.assertEqual(tt.parse("Email SoAndSo at soandso@example.com").contexts, [])
        self.assertEqual(tt.parse("Learn how to add 2+2").projects, [])

    def test_completion(self):
        t = tt.parse("x 2011-03-03 Call Mom")
        self.assertTrue(t.done)
        self.assertEqual(t.done_date, "2011-03-03")
        for raw in ["xylophone lesson", "X 2012-01-01 Make resolutions", "(A) x Find ticket prices"]:
            self.assertFalse(tt.parse(raw).done, raw)
        t = tt.parse("x 2011-03-02 2011-03-01 Review Tim's pull request +TodoTxtTouch @github")
        self.assertEqual((t.done_date, t.created, t.projects, t.contexts),
                         ("2011-03-02", "2011-03-01", ["TodoTxtTouch"], ["github"]))

    def test_key_value(self):
        t = tt.parse("Pay bills due:2010-01-02 custom:abc-123")
        self.assertEqual(t.due, "2010-01-02")
        self.assertEqual(t.kv, [("due", "2010-01-02"), ("custom", "abc-123")])

    def test_blank_lines_are_not_tasks(self):
        self.assertIsNone(tt.parse(""))
        self.assertIsNone(tt.parse("   \t"))


class ParserDetails(unittest.TestCase):
    def test_invalid_calendar_date_is_not_created(self):
        t = tt.parse("9999-99-99 not a date")
        self.assertIsNone(t.created)
        self.assertEqual(t.body, "9999-99-99 not a date")

    def test_date_must_be_followed_by_space(self):
        self.assertIsNone(tt.parse("2026-01-01x foo").created)
        self.assertEqual(tt.parse("2026-01-01").created, "2026-01-01")

    def test_non_ascii_after_digit(self):
        t = tt.parse("2Написать задачи на день due:2026-05-11 rec:+1d")
        self.assertIsNone(t.created)
        self.assertEqual((t.due, t.rec), ("2026-05-11", "+1d"))

    def test_url_is_not_metadata(self):
        t = tt.parse("Ler https://github.com/x/y/pull/3 src:bot")
        kinds = [(x.kind, x.text) for x in t.tokens]
        self.assertIn(("url", "https://github.com/x/y/pull/3"), kinds)
        self.assertEqual(t.kv, [("src", "bot")])

    def test_first_duplicate_wins(self):
        self.assertEqual(tt.parse("a due:2026-01-01 due:2027-01-01").due, "2026-01-01")

    def test_invalid_key_is_text(self):
        t = tt.parse("10:30 reunião -x:y")
        self.assertEqual(t.kv, [])

    def test_lone_sigils_are_text(self):
        t = tt.parse("type @ then + context")
        self.assertEqual((t.projects, t.contexts), ([], []))

    def test_three_dates_in_completed_line(self):
        t = tt.parse("x 2026-11-09 2026-11-09 2026-11-09 PR #42: algo")
        self.assertEqual((t.done_date, t.created), ("2026-11-09", "2026-11-09"))
        self.assertTrue(t.body.startswith("2026-11-09 PR"))

    def test_priority_on_done_task_is_parsed(self):
        t = tt.parse("x 2026-01-02 (B) 2026-01-01 tarefa")
        self.assertEqual((t.done, t.priority, t.created), (True, "B", "2026-01-01"))


class Dates(unittest.TestCase):
    def test_month_clamp(self):
        self.assertEqual(tt.add_months(D("2026-01-31"), 1), D("2026-02-28"))
        self.assertEqual(tt.add_months(D("2024-01-31"), 1), D("2024-02-29"))
        self.assertEqual(tt.add_months(D("2026-03-31"), -1), D("2026-02-28"))
        self.assertEqual(tt.add_months(D("2024-02-29"), 12), D("2025-02-28"))

    def test_business_days(self):
        self.assertEqual(tt.add_business_days(D("2026-05-08"), 1), D("2026-05-11"))  # sex → seg
        self.assertEqual(tt.add_business_days(D("2026-05-09"), 1), D("2026-05-11"))  # sáb → seg
        self.assertEqual(tt.add_business_days(D("2026-05-08"), 3), D("2026-05-13"))
        self.assertEqual(tt.add_business_days(D("2026-05-13"), -3), D("2026-05-08"))

    def test_overflow(self):
        self.assertIsNone(tt.shift(D("9999-06-01"), 1, "y"))


class Recurrence(unittest.TestCase):
    def test_parse_rec(self):
        self.assertEqual(tt.parse_rec("+1m"), tt.RecSpec(True, 1, "m"))
        self.assertEqual(tt.parse_rec("3b"), tt.RecSpec(False, 3, "b"))
        self.assertEqual(tt.parse_rec("+10b"), tt.RecSpec(True, 10, "b"))
        for bad in ["", "d", "1", "+", "+m", "0d", "-1d", "1z", "abc", "1.5d", "1 d", "1dx", " 1d", "1я", "1_0d"]:
            self.assertIsNone(tt.parse_rec(bad), bad)

    def test_strict_monthly_anchors_on_due(self):
        nxt = tt.next_instance("(A) 2026-04-15 Pay rent due:2026-04-15 rec:+1m", D("2026-04-20"))
        self.assertEqual(nxt, "(A) 2026-04-20 Pay rent due:2026-05-15 rec:+1m")

    def test_relative_anchors_on_completion(self):
        nxt = tt.next_instance("2026-04-01 Regar plantas due:2026-04-03 rec:1w", D("2026-04-10"))
        self.assertEqual(nxt, "2026-04-10 Regar plantas due:2026-04-17 rec:1w")

    def test_strict_without_due_uses_today(self):
        self.assertEqual(tt.next_instance("Algo rec:+2d", D("2026-04-10")), "2026-04-10 Algo rec:+2d due:2026-04-12")

    def test_relative_threshold_travels_with_due(self):
        nxt = tt.next_instance("(F) 2026-07-17 Responder +trabalho due:2026-11-13 rec:+1w t:0d", D("2026-11-13"))
        self.assertEqual(nxt, "(F) 2026-11-13 Responder +trabalho due:2026-11-20 rec:+1w t:0d")

    def test_duplicate_due_dropped(self):
        nxt = tt.next_instance("a due:2026-01-01 b due:2026-02-01 rec:+1d", D("2026-01-05"))
        self.assertEqual(nxt, "2026-01-05 a due:2026-01-02 b rec:+1d")

    def test_invalid_rec_spawns_nothing(self):
        self.assertIsNone(tt.next_instance("a due:2026-01-01 rec:-1d", D("2026-01-05")))

    def test_identity_ignores_due(self):
        a = tt.recurrence_identity("(A) 2026-01-01 Pagar +casa due:2026-01-10 rec:+1m")
        b = tt.recurrence_identity("2026-02-01 Pagar +casa due:2026-02-10 rec:+1m")
        self.assertEqual(a, b)


class DayOfMonth(unittest.TestCase):
    def series(self, raw, n):
        """Conclui `n` vezes no próprio vencimento e devolve os vencimentos gerados."""
        out = []
        for _ in range(n):
            t = tt.parse(raw)
            raw = tt.next_instance(raw, D(t.due))
            out.append(tt.parse(raw).due)
        return out

    def test_last_day_of_month_does_not_drift(self):
        raw = "(A) Relatório mensal +trabalho due:2026-11-30 t:-3d rec:+1m day:31"
        self.assertEqual(self.series(raw, 5), ["2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"])

    def test_without_day_matches_tuxedo_drift(self):
        self.assertEqual(self.series("a due:2027-01-31 rec:+1m", 3), ["2027-02-28", "2027-03-28", "2027-04-28"])

    def test_day_30_and_leap_year(self):
        self.assertEqual(self.series("a due:2028-01-30 rec:+1m day:30", 3), ["2028-02-29", "2028-03-30", "2028-04-30"])

    def test_heals_after_tuxedo_drift(self):
        nxt = tt.next_instance("a due:2027-02-28 rec:+1m day:31", D("2027-02-28"))
        self.assertIn("due:2027-03-31", nxt)
        self.assertIn("day:31", nxt)

    def test_relative_to_completion(self):
        nxt = tt.next_instance("a due:2026-11-30 rec:1m day:31", D("2026-11-05"))
        self.assertIn("due:2026-12-31", nxt)

    def test_yearly(self):
        nxt = tt.next_instance("a due:2028-02-29 rec:+1y day:29", D("2028-02-29"))
        self.assertIn("due:2029-02-28", nxt)

    def test_ignored_for_weekly_and_invalid(self):
        self.assertIn("due:2026-12-07", tt.next_instance("a due:2026-11-30 rec:+1w day:31", D("2026-11-30")))
        self.assertIn("due:2026-12-30", tt.next_instance("a due:2026-11-30 rec:+1m day:32", D("2026-11-30")))
        self.assertIsNone(tt.parse_day("0"))
        self.assertIsNone(tt.parse_day("1x"))


class Threshold(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(tt.parse_threshold("2026-08-01"), ("abs", D("2026-08-01")))
        self.assertEqual(tt.parse_threshold("-3d"), ("rel", -3, "d"))
        self.assertEqual(tt.parse_threshold("+1w"), ("rel", 1, "w"))
        self.assertEqual(tt.parse_threshold("7d"), ("rel", 7, "d"))
        self.assertEqual(tt.parse_threshold("0d"), ("rel", 0, "d"))
        for bad in ["", "abc", "1y", "1.5d", "d", "-", "+", "-d", "+m", "1z", " 1d", "1d ", "2026-99-01"]:
            self.assertIsNone(tt.parse_threshold(bad), bad)

    def test_resolve(self):
        self.assertEqual(tt.resolve_threshold("-3d", "2026-05-15", "2026-04-01"), D("2026-05-12"))
        self.assertEqual(tt.resolve_threshold("7d", None, "2026-04-01"), D("2026-04-08"))
        self.assertIsNone(tt.resolve_threshold("-3d", None, None))
        self.assertIsNone(tt.resolve_threshold("-3d", "not-a-date", "2026-04-01"))
        self.assertEqual(tt.resolve_threshold("-1m", "2026-03-31", None), D("2026-02-28"))
        self.assertEqual(tt.resolve_threshold("-3b", "2026-05-13", None), D("2026-05-08"))
        self.assertEqual(tt.resolve_threshold("2026-08-01", "2026-01-01", None), D("2026-08-01"))


class Edits(unittest.TestCase):
    def test_set_priority_in_place(self):
        self.assertEqual(tt.set_priority("(A) 2026-01-01 foo", "C"), "(C) 2026-01-01 foo")
        self.assertEqual(tt.set_priority("2026-01-01 foo", "B"), "(B) 2026-01-01 foo")
        self.assertEqual(tt.set_priority("(A) foo  bar", None), "foo  bar")
        with self.assertRaises(tt.EditError):
            tt.set_priority("x 2026-01-01 foo", "A")

    def test_set_value_keeps_position(self):
        self.assertEqual(tt.set_value("a due:2026-01-01 +p", "due", "2026-02-02"), "a due:2026-02-02 +p")
        self.assertEqual(tt.set_value("a +p", "due", "2026-02-02"), "a +p due:2026-02-02")
        self.assertEqual(tt.set_value("a due:1 b due:2 c", "due", None), "a b c")
        self.assertEqual(tt.set_value("due:2026-01-01 a", "due", None), "a")
        self.assertEqual(tt.set_value("a rec:1w", "rec", "+1w"), "a rec:+1w")
        with self.assertRaises(tt.EditError):
            tt.set_value("a", "due", "com espaço")

    def test_tags(self):
        self.assertEqual(tt.add_tag("a +x", "+", "y"), "a +x +y")
        self.assertEqual(tt.add_tag("a +x", "+", "x"), "a +x")
        self.assertEqual(tt.remove_tag("a +x b +x", "+", "x"), "a b")
        self.assertEqual(tt.remove_tag("a@b +x", "@", "b"), "a@b +x")
        with self.assertRaises(tt.EditError):
            tt.add_tag("a", "+", "com:dois")

    def test_unknown_metadata_untouched(self):
        raw = "(A) 2026-01-01 Tarefa  com  espaços +p @c key:val https://x.y/z?a=b  "
        new = tt.set_value(raw, "due", "2026-02-02")
        self.assertTrue(new.startswith("(A) 2026-01-01 Tarefa  com  espaços +p @c key:val https://x.y/z?a=b due:2026-02-02"))

    def test_complete_preserves_priority_as_pri(self):
        self.assertEqual(tt.complete("(A) 2026-01-01 foo +p", D("2026-02-01")), "x 2026-02-01 2026-01-01 foo +p pri:A")
        self.assertEqual(tt.complete("foo", D("2026-02-01")), "x 2026-02-01 foo")

    def test_uncomplete_restores_priority(self):
        self.assertEqual(tt.uncomplete("x 2026-02-01 2026-01-01 foo +p pri:A"), "(A) 2026-01-01 foo +p")
        self.assertEqual(tt.uncomplete("x 2026-05-05 2026-05-01 finish report"), "2026-05-01 finish report")
        self.assertEqual(tt.uncomplete("x foo"), "foo")

    def test_complete_roundtrip(self):
        for raw in ["(B) 2026-01-01 a +p due:2026-01-03", "2026-01-01 b", "c @x", "(Z) d"]:
            self.assertEqual(tt.uncomplete(tt.complete(raw, D("2026-02-01"))), raw)

    def test_ensure_created(self):
        self.assertEqual(tt.ensure_created("(A) foo", D("2026-01-01")), "(A) 2026-01-01 foo")
        self.assertEqual(tt.ensure_created("foo", D("2026-01-01")), "2026-01-01 foo")
        self.assertEqual(tt.ensure_created("2025-01-01 foo", D("2026-01-01")), "2025-01-01 foo")

    def test_single_line(self):
        self.assertEqual(tt.single_line("a\nb\r\nc "), "a b c")


class RealFileRoundTrip(unittest.TestCase):
    def test_every_line_parses(self):
        p = Path.home() / "todo.txt"
        if not p.exists():
            self.skipTest("sem ~/todo.txt")
        for line in p.read_text().splitlines():
            t = tt.parse(line)
            if t:
                self.assertEqual(t.raw, line)
                tt.to_json(t, 0)


if __name__ == "__main__":
    unittest.main()
