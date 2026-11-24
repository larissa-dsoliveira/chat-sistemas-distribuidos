# Entrega Pessoa 03: balanceador, infraestrutura e falhas

A Pessoa 02 deixou um cluster de 3 nós, mas cada nó tinha sua própria porta
(4001, 4002, 4003) e o usuário precisava escolher em qual entrar. Esta etapa
coloca um balanceador na frente, deixa o cluster crescer sem editar arquivos e
mostra, com números, o que acontece quando um servidor cai.

## O que mudou

**Balanceador Nginx** (`infra/nginx.conf`). Um único endereço,
http://localhost:4000, distribui as conexões WebSocket entre os nós. Usa
`least_conn`, porque conexões de chat ficam abertas por muito tempo e alternar
requisição por requisição desequilibraria a carga. Não precisa de sessão fixa
("sticky"): presença, catálogo e mensagens já são compartilhados pelo cluster,
então tanto faz em qual nó o cliente cai.

**Cluster que escala** (`compose.lb.yml`). Os nós deixaram de ter nome fixo.
Cada réplica vira `chat@<seu IP>` e descobre as outras perguntando ao DNS do
Docker quem responde pelo nome `chat` (nova opção `CLUSTER_DNS` em
`Cluster.Discovery`). Com isso, `--scale chat=15` cria 15 nós que formam um só
cluster, e o Nginx passa a mandar tráfego para os novos sem reiniciar.

**Reconexão visível na interface** (`priv/static/js/chat.js`). O cliente Phoenix
já reconectava sozinho. Agora a tela avisa:
"Servidor chat@172.21.0.2 saiu. Reconectado em chat@172.21.0.4. Você continua em Geral."

**Teste de falha** (`scripts/falha.mjs` e `scripts/demo-falha.ps1` / `.sh`).
Coloca bots conversando pelo balanceador, derruba um nó no meio, religa e
imprime um resumo.

## Como rodar

```console
docker compose -f compose.lb.yml up --build -d
```

Abra http://localhost:4000. Para ver em qual nó cada requisição caiu:
`docker compose -f compose.lb.yml logs -f balanceador` (campo `no=`).

Para crescer ou encolher (sem rebuild):

```console
docker compose -f compose.lb.yml up -d --scale chat=15
```

Para parar: `docker compose -f compose.lb.yml down`.

## Demonstração de falha

Windows:

```console
.\scripts\demo-falha.ps1
.\scripts\demo-falha.ps1 -Modo kill -Bots 60
```

Linux: `sh scripts/demo-falha.sh` (ou `MODO=kill BOTS=60 sh scripts/demo-falha.sh`).

O script sobe tudo, conecta os bots, derruba o 2º nó aos 12 s, religa aos 30 s e
mostra uma linha por segundo com quantos bots estão conectados em cada nó.
`stop` é um desligamento educado (SIGTERM); `kill` é queda abrupta, como faltar
energia.

### Resultados medidos (notebook, Docker Desktop, 3 nós)

| Cenário | Bots | Bots no nó derrubado | Voltaram | Tempo médio / máximo para voltar | Perda para quem não caiu | Duplicadas |
|---|---|---|---|---|---|---|
| `docker stop` | 30 | 10 | 10 | 456 ms / 753 ms | 0 | 0 |
| `docker kill` | 60 | 20 | 20 | 1633 ms / 2365 ms | 0 | 0 |

No `stop`, o nó fecha as conexões ao sair e os clientes reconectam quase na
hora. No `kill` ninguém avisa: o Nginx só percebe quando a tentativa de conexão
estoura 1 s, e o DNS do Docker leva até 2 s para tirar o nó da lista. Por isso
a volta é mais lenta.

Durante a queda, os bots dos outros nós continuaram trocando mensagens sem
perder nenhuma. Quem estava no nó derrubado perde o que foi dito nos ~2 s em que
ficou fora, porque o servidor não guarda histórico. Essa é a escolha do CAP para
este chat: ele continua disponível (AP) e aceita perder essas mensagens, em vez
de travar todo mundo esperando o nó voltar.

## Roteiro para a apresentação (~2 min)

1. Com o cluster no ar, abra http://localhost:4000 em duas abas, entre com dois
   apelidos e mostre em "Servidor atual" que cada aba pode estar em um nó diferente.
2. Rode `.\scripts\demo-falha.ps1` em um terminal visível. Mostre as linhas
   `por nó:` passando de 3 nós para 2 no momento da queda e o contador voltando
   ao total em menos de 2 s.
3. Derrube o nó de uma das abas (`docker stop <nome>`; `docker ps` mostra os
   nomes) e mostre o aviso de reconexão na tela.
4. Feche com o resumo: zero perda para quem não caiu e a explicação do CAP.

## Limites

- O Nginx é um ponto único de falha. Num ambiente real teria duas instâncias com
  IP flutuante, ou um balanceador gerenciado da nuvem.
- O teste roda tudo num computador só. Ele mostra a recuperação, mas não mede
  capacidade de produção. Carga maior e métricas são da Pessoa 04 (o serviço
  `carga` em `compose.lb.yml` já aponta para o balanceador).
- Quando o nó volta, as conexões não são redistribuídas: ele recebe só as novas.
- `mix format --check-formatted` já falhava antes desta etapa em `runtime.exs`,
  `discovery.ex` e `distributed_store.ex`. Os 13 testes passam.

## Detalhes que deram trabalho

- **403 no WebSocket pelo balanceador.** O Phoenix usa `check_origin: :conn` e
  compara a origem do navegador (`localhost:4000`) com o `Host` da requisição.
  O Nginx mandava `Host: localhost`, sem porta. A solução foi repassar
  `$http_host`.
- **Bots que nunca voltavam no `kill`.** No Node.js, quando o handshake do
  WebSocket recebe 502, só dispara `error`, nunca `close`. O navegador dispara
  os dois. O script de falha agora trata `error` como desconexão.
