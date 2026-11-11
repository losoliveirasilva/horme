"""Parser e transformações de linhas todo.txt.

Segue a especificação oficial (https://github.com/todotxt/todo.txt) e as extensões
convencionais com a mesma semântica do Tuxedo (webstonehq/tuxedo), para que os dois
programas leiam e escrevam o mesmo arquivo sem divergir:

- `due:AAAA-MM-DD`  vencimento.
- `t:`              disponibilidade (threshold): data absoluta ou deslocamento relativo
                    `[+-]N[dbwm]`, ancorado no `due:` (ou na criação, sem `due:`).
- `rec:`            recorrência `[+]N[dbwmy]`. Sem `+`: a partir da conclusão.
                    Com `+`: a partir do vencimento anterior.
- `pri:X`           prioridade preservada em tarefa concluída (sugestão da própria spec).
- `day:N`           (extensão do Horme) com `rec:` mensal/anual, a próxima ocorrência cai no dia N,
                    ou no último dia do mês quando ele for menor. `day:31` = sempre o último dia.
                    Sem isso, 31/jan + 1m = 28/fev e o dia 31 se perde. O Tuxedo preserva o
                    metadado; se concluir por lá, a próxima conclusão no Horme volta ao dia certo.

Regra de ouro: toda edição é um recorte cirúrgico da linha original. O que o Horme não
entende fica exatamente como estava.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

# ---------------------------------------------------------------- datas

_ISO_STRICT = re.compile(r"\d{4}-\d{2}-\d{2}")
_ISO_LENIENT = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")  # chrono aceita 2026-8-1
_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+")
_PRI_TOKEN = re.compile(r"pri:([A-Z])")
_TAG_FORBIDDEN = re.compile(r"[\s+@:]")


def parse_date(s: str | None) -> date | None:
    """Data de calendário real em `AAAA-MM-DD` (aceita mês/dia com 1 dígito, como o chrono)."""
    if not s:
        return None
    m = _ISO_LENIENT.fullmatch(s)
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None


def iso(d: date) -> str:
    return d.isoformat()


def add_months(d: date, n: int) -> date:
    """Soma meses limitando ao fim do mês (31/jan + 1m = 28 ou 29/fev)."""
    m0 = d.month - 1 + n
    y, m = d.year + m0 // 12, m0 % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _is_weekend(d: date) -> bool:
    return d.weekday() >= 5


def add_business_days(d: date, n: int) -> date:
    """Anda `n` dias úteis (seg–sex, sem feriados). n < 0 anda para trás."""
    step = 1 if n >= 0 else -1
    remaining = abs(n)
    while remaining:
        d += timedelta(days=step)
        if not _is_weekend(d):
            remaining -= 1
    return d


UNITS = {"d": "day", "b": "business", "w": "week", "m": "month", "y": "year"}


def shift(d: date, n: int, unit: str) -> date | None:
    """Desloca `d` por `n` unidades (n pode ser negativo). None em overflow."""
    try:
        if unit == "d":
            return d + timedelta(days=n)
        if unit == "w":
            return d + timedelta(days=7 * n)
        if unit == "m":
            return add_months(d, n)
        if unit == "y":
            return add_months(d, 12 * n)
        if unit == "b":
            return add_business_days(d, n)
    except (OverflowError, ValueError):
        return None
    return None


# ---------------------------------------------------------------- recorrência e threshold

_REC = re.compile(r"(\+?)(\+?\d+)([dbwmy])")
_THRESHOLD_REL = re.compile(r"([+-]?)(\+?\d+)([dbwm])")
_U32 = 2**32


@dataclass(frozen=True)
class RecSpec:
    strict: bool  # `rec:+1w`: ancora no vencimento anterior
    n: int
    unit: str


def parse_rec(value: str | None) -> RecSpec | None:
    """Valor de `rec:` — mesma gramática do Tuxedo (`[+]N[dbwmy]`, N >= 1)."""
    if not value:
        return None
    m = _REC.fullmatch(value)
    if not m:
        return None
    n = int(m[2])
    if n == 0 or n >= _U32:
        return None
    return RecSpec(strict=bool(m[1]), n=n, unit=m[3])


def parse_day(value: str | None) -> int | None:
    """Valor de `day:` — dia do mês de 1 a 31."""
    if value and re.fullmatch(r"\d{1,2}", value) and 1 <= int(value) <= 31:
        return int(value)
    return None


def with_day(d: date, day: int) -> date:
    """Mesmo mês de `d`, no dia `day` (ou no último dia do mês, se ele for menor)."""
    return d.replace(day=min(day, calendar.monthrange(d.year, d.month)[1]))


def parse_threshold(value: str | None):
    """Valor de `t:`: ('abs', date) ou ('rel', n_com_sinal, unidade). None se inválido."""
    if not value:
        return None
    d = parse_date(value)
    if d:
        return ("abs", d)
    m = _THRESHOLD_REL.fullmatch(value)
    if not m:
        return None
    n = int(m[2])
    if n >= _U32:
        return None
    return ("rel", -n if m[1] == "-" else n, m[3])


def resolve_threshold(value: str | None, due: str | None, created: str | None) -> date | None:
    """Data absoluta do `t:`. Relativo ancora no `due:`; sem `due:`, na criação.

    Como no Tuxedo: se houver `due:` mas ele for inválido, não cai para a criação.
    """
    spec = parse_threshold(value)
    if spec is None:
        return None
    if spec[0] == "abs":
        return spec[1]
    anchor_s = due if due is not None else created
    anchor = parse_date(anchor_s)
    if anchor is None:
        return None
    return shift(anchor, spec[1], spec[2])


# ---------------------------------------------------------------- parser

@dataclass
class Token:
    kind: str  # text | project | context | kv | url
    text: str
    start: int  # posição na linha bruta
    end: int
    key: str | None = None
    value: str | None = None


@dataclass
class Task:
    raw: str
    done: bool = False
    done_date: str | None = None
    priority: str | None = None
    created: str | None = None
    # posições na linha bruta, para edições cirúrgicas
    content_start: int = 0  # primeiro caractere não-branco
    pri_start: int | None = None
    body_start: int = 0
    body_end: int = 0
    tokens: list[Token] = field(default_factory=list)

    @property
    def body(self) -> str:
        return self.raw[self.body_start:self.body_end]

    @property
    def projects(self) -> list[str]:
        return _unique(t.text[1:] for t in self.tokens if t.kind == "project")

    @property
    def contexts(self) -> list[str]:
        return _unique(t.text[1:] for t in self.tokens if t.kind == "context")

    @property
    def kv(self) -> list[tuple[str, str]]:
        return [(t.key, t.value) for t in self.tokens if t.kind == "kv"]

    def get(self, key: str) -> str | None:
        """Primeiro `key:value` da linha (duplicatas posteriores são ignoradas, como no Tuxedo)."""
        for t in self.tokens:
            if t.kind == "kv" and t.key == key:
                return t.value
        return None

    @property
    def due(self) -> str | None:
        return self.get("due")

    @property
    def threshold(self) -> str | None:
        return self.get("t")

    @property
    def rec(self) -> str | None:
        return self.get("rec")


def _unique(it):
    seen, out = set(), []
    for x in it:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _skip_ws(s: str, i: int, end: int) -> int:
    while i < end and s[i].isspace():
        i += 1
    return i


def _date_at(s: str, i: int, end: int) -> str | None:
    """`AAAA-MM-DD` válido em s[i:] seguido de espaço/tab ou fim de linha."""
    cand = s[i:i + 10]
    if len(cand) != 10 or not _ISO_STRICT.fullmatch(cand) or parse_date(cand) is None:
        return None
    if i + 10 == end or s[i + 10] in " \t":
        return cand
    return None


def _priority_at(s: str, i: int, end: int) -> str | None:
    if i + 3 < end and s[i] == "(" and "A" <= s[i + 1] <= "Z" and s[i + 2] == ")" and s[i + 3] in " \t":
        return s[i + 1]
    return None


def classify(word: str) -> tuple[str, str | None, str | None]:
    """Tipo de uma palavra do corpo: project, context, url, kv ou text."""
    if len(word) > 1 and word[0] == "+":
        return "project", None, None
    if len(word) > 1 and word[0] == "@":
        return "context", None, None
    if _URL.fullmatch(word):
        return "url", None, None
    k, sep, v = word.partition(":")
    if sep and v and _KEY.fullmatch(k):
        return "kv", k, v
    return "text", None, None


def parse(raw: str) -> Task | None:
    """Interpreta uma linha. Linha vazia ou só com brancos não é tarefa (None)."""
    end = len(raw.rstrip())
    pos = len(raw) - len(raw.lstrip())
    if pos >= end:
        return None
    t = Task(raw=raw, content_start=pos)

    if raw[pos] == "x" and pos + 1 < end and raw[pos + 1] in " \t":
        t.done = True
        pos = _skip_ws(raw, pos + 1, end)
        d = _date_at(raw, pos, end)
        if d:
            t.done_date = d
            pos = _skip_ws(raw, pos + 10, end)

    p = _priority_at(raw, pos, end)
    if p:
        t.priority = p
        t.pri_start = pos
        pos = _skip_ws(raw, pos + 4, end)

    d = _date_at(raw, pos, end)
    if d:
        t.created = d
        pos = _skip_ws(raw, pos + 10, end)

    t.body_start, t.body_end = pos, end
    for m in re.finditer(r"\S+", raw[pos:end]):
        kind, k, v = classify(m.group())
        t.tokens.append(Token(kind, m.group(), pos + m.start(), pos + m.end(), k, v))
    return t


def body_after_priority(raw: str) -> str:
    """Linha sem `x`, datas e prioridade (equivale ao `body_after_priority` do Tuxedo)."""
    t = parse(raw)
    return t.body if t else ""


# ---------------------------------------------------------------- edições cirúrgicas

class EditError(ValueError):
    pass


def valid_tag_name(name: str) -> bool:
    return bool(name) and not _TAG_FORBIDDEN.search(name)


def valid_value(value: str) -> bool:
    return bool(value) and not re.search(r"\s", value)


def _remove_span(raw: str, start: int, end: int, floor: int) -> str:
    """Remove raw[start:end] e um separador: o espaço anterior ou, no começo do trecho, o seguinte."""
    a = start
    while a > floor and raw[a - 1].isspace():
        a -= 1
    if a < start:
        return raw[:a] + raw[end:]
    b = end
    while b < len(raw) and raw[b].isspace():
        b += 1
    return raw[:start] + raw[b:]


def _remove_tokens(raw: str, pred) -> str:
    t = parse(raw)
    if t is None:
        return raw
    for tok in reversed([x for x in t.tokens if pred(x)]):
        cur = parse(raw)
        raw = _remove_span(raw, tok.start, tok.end, cur.body_start if cur else 0)
    return raw


def _append(raw: str, text: str) -> str:
    end = len(raw.rstrip())
    return raw[:end] + " " + text + raw[end:]


def set_priority(raw: str, pri: str | None) -> str:
    t = parse(raw)
    if t is None:
        raise EditError("linha vazia")
    if t.done:
        raise EditError("tarefa concluída não tem prioridade")
    if pri is not None and not (len(pri) == 1 and "A" <= pri <= "Z"):
        raise EditError("prioridade deve ser uma letra de A a Z")
    if t.pri_start is not None:
        if pri is None:
            after = _skip_ws(raw, t.pri_start + 4, len(raw))
            return raw[:t.pri_start] + raw[after:]
        return raw[:t.pri_start + 1] + pri + raw[t.pri_start + 2:]
    if pri is None:
        return raw
    return raw[:t.content_start] + f"({pri}) " + raw[t.content_start:]


def set_value(raw: str, key: str, value: str | None) -> str:
    """Troca o primeiro `key:` no lugar; sem valor, remove todas as ocorrências; se não existe, anexa."""
    if not _KEY.fullmatch(key):
        raise EditError(f"chave inválida: {key!r}")
    if value is None or value == "":
        return _remove_tokens(raw, lambda x: x.kind == "kv" and x.key == key)
    if not valid_value(value) or ":" in value:
        raise EditError(f"valor inválido para {key}: {value!r}")
    t = parse(raw)
    if t is None:
        raise EditError("linha vazia")
    for tok in t.tokens:
        if tok.kind == "kv" and tok.key == key:
            return raw[:tok.start] + f"{key}:{value}" + raw[tok.end:]
    return _append(raw, f"{key}:{value}")


def add_tag(raw: str, sigil: str, name: str) -> str:
    if sigil not in "+@" or not valid_tag_name(name):
        raise EditError(f"nome inválido: {name!r}")
    t = parse(raw)
    if t is None:
        raise EditError("linha vazia")
    if any(tok.text == sigil + name for tok in t.tokens):
        return raw
    return _append(raw, sigil + name)


def remove_tag(raw: str, sigil: str, name: str) -> str:
    return _remove_tokens(raw, lambda x: x.text == sigil + name and x.kind in ("project", "context"))


def complete(raw: str, today: date) -> str:
    """`x HOJE [criação] corpo`. A prioridade vira `pri:X` (spec), em vez de se perder.

    Diferente do Tuxedo, não inventa data de criação quando a tarefa não tem uma.
    """
    t = parse(raw)
    if t is None:
        raise EditError("linha vazia")
    if t.done:
        return raw
    rest = raw[t.content_start:]
    if t.priority:
        rest = raw[_skip_ws(raw, t.pri_start + 4, len(raw)):]
        if t.get("pri") is None:
            rest = _append(rest, f"pri:{t.priority}")
    return raw[:t.content_start] + f"x {iso(today)} " + rest


def uncomplete(raw: str) -> str:
    """Desfaz `complete`: tira `x` e a data de conclusão e devolve a prioridade guardada em `pri:`."""
    t = parse(raw)
    if t is None or not t.done:
        return raw
    i = _skip_ws(raw, t.content_start + 1, len(raw))
    if t.done_date:
        i = _skip_ws(raw, i + 10, len(raw))
    out = raw[:t.content_start] + raw[i:]
    pri_tok = next((x for x in t.tokens if x.kind == "kv" and x.key == "pri" and _PRI_TOKEN.fullmatch(x.text)), None)
    if pri_tok and not t.priority:
        out = _remove_tokens(out, lambda x: x.kind == "kv" and x.key == "pri" and x.text == pri_tok.text)
        out = set_priority(out, pri_tok.value)
    return out


def ensure_created(raw: str, today: date) -> str:
    """Acrescenta a data de criação (depois da prioridade) se a tarefa pendente não tiver uma."""
    t = parse(raw)
    if t is None or t.done or t.created:
        return raw
    at = _skip_ws(raw, t.pri_start + 4, len(raw)) if t.pri_start is not None else t.content_start
    return raw[:at] + iso(today) + " " + raw[at:]


def single_line(text: str) -> str:
    """Uma linha = uma tarefa: quebras de linha viram espaço."""
    return re.sub(r"[\r\n  \x0b\x0c\x85]+", " ", text).strip()


# ---------------------------------------------------------------- recorrência (igual ao Tuxedo)

def next_instance(raw: str, today: date) -> str | None:
    """Próxima ocorrência de uma tarefa recorrente, montada a partir da linha *antes* da conclusão.

    Reproduz `build_next_instance` do Tuxedo:
    - âncora: `rec:+N` usa o `due:` anterior (ou hoje, se não houver/for inválido); `rec:N` usa hoje;
    - novo `due:` substitui o primeiro, duplicatas somem; sem `due:`, ele é anexado;
    - mantém a prioridade, a criação passa a ser hoje e o resto da linha segue igual
      (`t:` relativo acompanha o novo vencimento sozinho).
    """
    t = parse(raw)
    if t is None:
        return None
    spec = parse_rec(t.rec)
    if spec is None:
        return None
    anchor = today
    if spec.strict:
        anchor = parse_date(t.due) or today
    nxt = shift(anchor, spec.n, spec.unit)
    if nxt is None:
        return None
    day = parse_day(t.get("day"))
    if day and spec.unit in "my":
        nxt = with_day(nxt, day)  # extensão do Horme; sem `day:` o resultado é idêntico ao do Tuxedo
    out, seen = [], False
    for tok in t.body.split():
        if tok.startswith("due:") and len(tok) > 4:
            if not seen:
                out.append(f"due:{iso(nxt)}")
                seen = True
            continue
        out.append(tok)
    if not seen:
        out.append(f"due:{iso(nxt)}")
    prefix = f"({t.priority}) " if t.priority else ""
    return f"{prefix}{iso(today)} " + " ".join(out)


def recurrence_identity(raw: str) -> str:
    """Identidade de uma série recorrente (corpo sem `due:`), usada para não gerar duas ocorrências vivas."""
    return " ".join(tok for tok in body_after_priority(raw).split() if not tok.startswith("due:"))


# ---------------------------------------------------------------- serialização para a interface

def to_json(t: Task, line: int) -> dict:
    due = t.due
    thr = t.threshold
    rec = t.rec
    spec = parse_rec(rec)
    thr_date = resolve_threshold(thr, due, t.created)
    return {
        "i": line,
        "raw": t.raw,
        "done": t.done,
        "doneDate": t.done_date,
        "pri": t.priority,
        "created": t.created,
        "tokens": [
            {"k": x.kind, "v": x.text, **({"key": x.key, "val": x.value} if x.kind == "kv" else {})}
            for x in t.tokens
        ],
        "projects": t.projects,
        "contexts": t.contexts,
        "due": due,
        "dueDate": iso(d) if (d := parse_date(due)) else None,
        "t": thr,
        "tDate": iso(thr_date) if thr_date else None,
        "rec": rec,
        "recSpec": {"strict": spec.strict, "n": spec.n, "unit": spec.unit} if spec else None,
        "day": t.get("day"),
        "recDay": parse_day(t.get("day")),
        "savedPri": t.get("pri") if t.done else None,
    }
