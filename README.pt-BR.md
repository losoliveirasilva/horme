# Horme

[English](README.md) · **Português**

**Hormé** (Ὁρμή) é uma divindade menor da mitologia grega que personifica o impulso para agir: a
iniciativa, o esforço e a energia que põem algo em movimento. Não tem mitos próprios; é uma força
personificada, cuja contraparte é Aergia, a preguiça. Pausânias registra um altar dedicado a ela na
ágora de Atenas (*Descrição da Grécia*, I.17), e para os estoicos *hormē* é o impulso que leva do
julgamento à ação.

Daí o nome: uma tarefa anotada é uma intenção, e o Horme existe para transformá-la em ação.

Gerenciador de tarefas pessoal sobre `todo.txt`, aberto no navegador e servido só em `localhost`.
O arquivo é a única fonte de verdade: não há banco de dados, cache ou formato próprio.

```sh
./horme --open            # abre http://localhost:8788/
./horme ~/outro/todo.txt  # arquivo explícito
```

Requer só Python 3.10+ (biblioteca padrão). A interface é HTML/CSS/JS puro, sem build e sem CDN.

## Qual arquivo ele abre

Mesma ordem do Tuxedo (e do todo.txt-cli):

1. argumento `FILE`
2. `$TODO_FILE`
3. `$TODO_DIR/todo.txt`
4. configuração do Horme (`~/.config/horme/config.json`, gravada pela própria página)
5. `./todo.txt` na pasta onde o Horme foi aberto
6. senão, a página pergunta o caminho

O arquivo de arquivamento é `$DONE_FILE` ou o `done.txt` ao lado do `todo.txt`.

## Formato

Segue a [especificação oficial](https://github.com/todotxt/todo.txt) e as extensões convencionais com a
semântica do Tuxedo:

| Token | Significado |
| --- | --- |
| `(A)` | prioridade, no começo da linha |
| `x 2026-11-11` | concluída, com data de conclusão |
| `+projeto` `@contexto` | em qualquer lugar da linha |
| `due:2026-11-20` | vencimento |
| `t:2026-11-18` / `t:-3d` | disponibilidade: some da lista até a data; relativo ancora no `due:` (ou na criação) |
| `rec:1w` | repete 1 semana depois da **conclusão** |
| `rec:+1w` | repete 1 semana depois do **vencimento anterior** |
| `pri:A` | prioridade guardada numa tarefa concluída (sugestão da spec) |
| `day:31` | com `rec:` mensal/anual: sempre no dia 31, ou no último dia do mês (extensão do Horme) |
| `chave:valor` | qualquer outro metadado: preservado sem alteração |

Unidades de `rec:` e `t:`: `d` dias, `b` dias úteis, `w` semanas, `m` meses (fim de mês é ajustado:
31/jan + 1m = 28/fev), `y` anos (só em `rec:`).

### Recorrência

Ao concluir uma tarefa com `rec:`, o Horme gera a próxima linha **byte a byte igual ao Tuxedo**
(`tests/test_tuxedo_compat.py` compara com o binário instalado):

- `rec:+N` parte do `due:` anterior (ou de hoje, se não houver); `rec:N` parte de hoje;
- a nova linha mantém a prioridade, ganha a data de criação de hoje e o novo `due:`; o resto segue igual,
  então um `t:-3d` acompanha o vencimento;
- se já existe uma ocorrência aberta da mesma série, nenhuma outra é criada.

### Fim do mês: `day:N`

Somar meses perde o dia: 31/jan + 1m = 28/fev, e daí em diante 28/mar, 28/abr… (Tuxedo, sleek, topydo e
companhia fazem igual; a spec não define recorrência). Com `day:N`, a ocorrência mensal ou anual cai no dia N,
ou no último dia do mês quando ele for menor:

```
(A) Enviar relatório mensal due:2026-11-30 t:-3d rec:+1m day:31       → 31/dez, 31/jan, 28/fev, 31/mar…
Pagar condomínio due:2028-01-30 rec:+1m day:30                        → 29/fev, 30/mar, 30/abr…
```

O Tuxedo ignora `day:` mas o preserva; se a tarefa for concluída por lá, a data escorrega uma vez e a próxima
conclusão pelo Horme volta ao dia certo. No painel, a opção fica em Recorrência → Dia do mês.

### Outras diferenças deliberadas em relação ao Tuxedo

Ambas produzem linhas válidas pela spec, que o Tuxedo lê normalmente:

- **Prioridade ao concluir:** o Tuxedo descarta; o Horme move para `pri:A` (como a spec sugere) e
  devolve `(A)` ao reabrir.
- **Data de criação ao concluir:** o Tuxedo inventa a data de hoje quando a tarefa não tem uma; o Horme
  não inventa dados.

## Integridade do arquivo

- Toda operação relê o arquivo, localiza a linha pelo texto que a interface viu (a posição é só dica) e
  altera **apenas essa linha**. Linhas em branco, ordem, LF/CRLF, BOM, ausência de quebra no fim e bytes
  que não são UTF-8 ficam como estavam.
- Se a linha mudou fora do Horme, a operação é recusada (`409`) e a lista é atualizada, em vez de
  sobrescrever a mudança.
- Escrita atômica (temporário no mesmo diretório, `fsync`, `rename`), seguindo symlinks e mantendo as
  permissões. Imediatamente antes do `rename` o arquivo é relido; se outro programa escreveu nesse meio
  tempo, a operação é refeita sobre o conteúdo novo.
- Antes de cada gravação, a versão anterior vai para `~/.local/state/horme/backups/` (as 60 últimas).
  Desligue com `--no-backup`.
- Desfazer (`u`) funciona mesmo depois de mudanças externas em outras linhas; se a própria linha mudou,
  o Horme avisa em vez de desfazer.

## Agentes e outros programas

Qualquer programa pode editar o `todo.txt` diretamente (inclusive o `tuxedo` CLI). O Horme verifica o
arquivo a cada 250 ms e atualiza a página sozinho via Server-Sent Events, destacando as linhas novas ou
alteradas. Não é preciso importar nem recarregar nada.

## Interface

- **Visões:** Pendentes, Hoje (inclui vencidas), Próximos 7 dias, Programadas (`t:` no futuro), Concluídas
  (com arquivamento para o `done.txt` e leitura dele).
- **Filtros combináveis** na lateral: projetos, contextos, prioridade, recorrentes, mais a busca (`/`).
  Dentro de um grupo vale "ou"; entre grupos, "e".
- **Agrupar** por vencimento, prioridade, projeto ou contexto; **ordenar** por prioridade, vencimento,
  criação, descrição ou ordem do arquivo.
- **Linhas compactas** (uma linha, texto truncado) ou **detalhadas** (até 3 linhas e metadados extras),
  alternando com `v`. Clicar abre o painel lateral com o texto completo e todos os campos editáveis.
- Ao adicionar, `due:amanhã`, `due:sex`, `due:+3d`, `t:hoje` viram datas ISO (a prévia mostra exatamente o
  que será gravado). Com um único projeto/contexto filtrado, a tarefa nova já recebe a etiqueta.
- `?` mostra todos os atalhos.
- Tamanho: `--zoom` no topo de `web/app.css` (padrão `1.2`, equivalente ao zoom de 120% do navegador).

## Rodar sempre

`~/.config/systemd/user/horme.service`:

```ini
[Unit]
Description=Horme (todo.txt)

[Service]
ExecStart=/path/to/horme/horme
# Environment=TODO_FILE=%h/todo.txt
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now horme
```

No Hyprland, uma janela "de aplicativo" sem barras do navegador:

```
bind = SUPER, T, exec, chromium --app=http://localhost:8788/
```

## Desenvolvimento

```sh
python3 -m unittest discover -s tests -t .
```

| Arquivo | Papel |
| --- | --- |
| `todotxt.py` | parser, datas, recorrência, edições cirúrgicas de linha |
| `storage.py` | documento em memória, escrita atômica, observador do arquivo |
| `server.py` | HTTP, API, SSE, resolução de caminhos |
| `web/` | interface |
