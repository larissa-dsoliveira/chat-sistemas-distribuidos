# Chat Distribuído — Pessoas 01 e 02 / versão 0.2.0

Protótipo acadêmico de mensageria em tempo real sobre Elixir/Phoenix (BEAM OTP):
- **Cluster Distribuído**: Múltiplos nós conectados com replicação e descoberta automática.
- **Presença em Tempo Real (CRDTs)**: `Phoenix.Presence` sincronizando participantes online entre servidores sem bloqueios ou locks centrais.
- **Catálogo Replicado**: Salas públicas e privadas (com chave SHA-256) sincronizadas entre todos os nós com concorrência local em ETS.
- **Mensagens Distribuídas**: `Phoenix.PubSub` distribuído entre todos os nós da rede.

## Cluster atrás do balanceador (Pessoa 03)

Um endereço só, http://localhost:4000, com Nginx distribuindo as conexões entre
os nós. O cluster cresce com `--scale` e se recupera quando um nó cai:

```console
docker compose -f compose.lb.yml up --build -d
docker compose -f compose.lb.yml up -d --scale chat=15
.\scripts\demo-falha.ps1          # Windows; no Linux: sh scripts/demo-falha.sh
```

Detalhes, resultados medidos e roteiro da apresentação em `docs/ENTREGA_PESSOA_03.md`.

## Rodar o Cluster de 3 Nós (Pessoa 02)

Para subir o cluster completo com 3 servidores conectados:

```console
docker compose -f compose.cluster.yml up --build
```

Acesse em abas ou navegadores diferentes:
- **Nó 1**: [http://localhost:4001](http://localhost:4001)
- **Nó 2**: [http://localhost:4002](http://localhost:4002)
- **Nó 3**: [http://localhost:4003](http://localhost:4003)

Ao entrar na mesma sala em nós distintos, os usuários verão a lista de participantes sincronizada em tempo real via CRDT e as mensagens fluirão instantaneamente entre os servidores!

## Começar com um único servidor

Instale Docker com Compose no computador. Windows: Docker Desktop com containers
Linux, normalmente usando WSL 2. Linux: Docker Engine com Compose. A primeira
montagem precisa de internet. O Dockerfile inclui os certificados HTTPS usados
por Mix/Hex/Rebar; mantenha esse arquivo na atualização.

Extraia a pasta inteira e abra um terminal onde estão `compose.yml` e `Dockerfile`:

```console
docker compose up --build
```

No CachyOS, use `sudo docker compose up --build` se seu acesso ao Docker exige
sudo. No Windows, o mesmo comando funciona no PowerShell sem sudo.

Abra http://localhost:4000. Entre com um apelido. Use **Criar sala** para informar
nome e tipo. Salas públicas aparecem automaticamente na lista de outras abas.
Ao criar uma privada, compartilhe a chave exibida. O convidado usa **Entrar com
chave**. Chaves erradas são rejeitadas pelo servidor; a sala privada não aparece
no catálogo público. **Sair da sala** mantém a identificação e permite escolher
outra; **Sair** encerra a sessão desta aba.

Abra outras abas com apelidos diferentes para experimentar as conversas.
Somente a sala selecionada recebe mensagens nesta versão. Ao voltar a uma sala,
você vê as mensagens que essa aba recebeu enquanto participava dela.

Para parar: Ctrl+C no terminal. Para iniciar novamente sem alterar arquivos:

```console
docker compose up
```

Ao editar arquivos, execute novamente com `--build`. Os arquivos são copiados
para a imagem; não existe montagem da pasta de código em tempo real.

## Atualizar a primeira versão

Pare o servidor antigo com Ctrl+C. Substitua os arquivos do projeto pelo conteúdo
completo deste ZIP, preservando seu `.env` caso tenha configurações próprias.
Execute novamente `docker compose up --build` na mesma pasta. Nenhum banco ou
volume de dados precisa de migração: as salas são temporárias em memória.

## Portabilidade e configuração

Não há caminhos de usuário, IPs ou nomes da máquina original no código. O cliente
usa `/socket` no mesmo host e porta da página. JavaScript e CSS são servidos pelo
próprio projeto, sem CDN. `/app` é o diretório interno da imagem Docker.

O `.env` é opcional no Compose; copie `.env.example` se quiser configurar:

| Variável | Padrão | Uso |
|---|---|---|
| `CHAT_PORT` | 4000 | Porta publicada no computador |
| `CHAT_BIND` | 127.0.0.1 | Interface de publicação; `0.0.0.0` permite acesso pela rede |
| `NODE_LABEL` | Vazio | Vazio usa o nome do container; preenchido define um rótulo |

Para acesso por outro computador na mesma rede, configure `CHAT_BIND=0.0.0.0`,
permita a porta no firewall e abra o endereço atual do computador servidor.
Isso é acesso remoto ao mesmo servidor. A integração entre servidores é a etapa 02.

## Organização para a Pessoa 02

| Módulo/arquivo | Responsabilidade |
|---|---|
| `Chat` | Valida apelidos/texto e monta mensagens |
| `Rooms.Room` | Regras de sala, representação pública e validação da chave |
| `Rooms` | Fachada usada pelos Channels para criar/listar/autorizar salas |
| `Rooms.Store` | Contrato substituível do catálogo |
| `Rooms.LocalStore` | Implementação temporária local com ETS |
| `CatalogChannel` | Criar/listar salas e localizar privada pela chave |
| `RoomChannel` | Autorizar a entrada e transmitir mensagens no tópico da sala |
| `NodeInfo` | Mostrar nó BEAM real quando nomeado; rótulo enquanto local |
| `priv/static/js/transport.js` | Cliente do protocolo, socket e canais |
| `priv/static/js/chat.js` | Estado e ações da interface |
| `priv/static/js/messages.js` | Renderização de mensagens como texto |
| `docs/PROTOCOLO.md` | Eventos e campos que a integração preservará |
| `docs/ENTREGA_PESSOA_02.md` | Trabalho restante e roteiro para 15 instâncias |

O catálogo administra metadados. Mensagens não passam pelo GenServer do catálogo:
o Channel valida o texto e usa PubSub. Leituras de salas usam ETS concorrente;
a criação de salas é serializada apenas para manter seus índices coerentes.
Não há um processo central de sala encaminhando todas as mensagens do sistema.

## Bancada para 15 instâncias da aplicação

O arquivo `compose.15.yml` permite subir várias cópias sem conflito de portas:

```console
docker compose -p sd15 -f compose.15.yml up --build --scale chat=15 -d
docker compose -p sd15 -f compose.15.yml ps
docker compose -p sd15 -f compose.15.yml port --index 1 chat 4000
```

O último comando mostra a porta da primeira cópia. Use `--index 2`, por exemplo,
para consultar outra. Cada processo usa seu próprio catálogo em memória e seu
próprio nome de exibição. **Nesta entrega, essas 15 cópias são independentes.**
Elas são a bancada de integração; não representam ainda um único chat distribuído.

A Pessoa 02 deve conectar os nós e implementar o catálogo compartilhado antes
de esperar que uma sala criada em uma cópia funcione nas demais. O PubSub já
existe no núcleo, mas conectar VMs não replica os metadados de `LocalStore`.

O comando `--scale chat=15` é uma expansão manual. Para mudar o tamanho da
bancada, repita com outro número. Ela exige recursos físicos para todos os
processos. Aumentar capacidade conforme demanda também requer decisão por
métricas e encaminhamento de conexões para os novos nós, tarefas da integração.
A versão da Pessoa 01 não anuncia autoscaling ou capacidade em milhões.

Para encerrar a bancada:

```console
docker compose -p sd15 -f compose.15.yml down
```

No Linux, acrescente sudo quando necessário. Windows usa os mesmos arquivos.

## Carga curta com 15 clientes

Clientes e servidores são contagens diferentes. O comando abaixo simula 15
clientes WebSocket contra um servidor e envia 20 mensagens por cliente:

```console
docker compose -f compose.yml -f compose.carga.yml run --rm carga
```

Ele usa uma imagem Node.js separada; não precisa instalar Node no computador.
São 300 mensagens publicadas e 4.500 entregas esperadas para os 15 clientes da
sala Geral. O script confere identificadores para detectar duplicações e falha
se as entregas não chegarem. A taxa exibida é somente a observada nessa execução
curta, não um limite de capacidade. A Pessoa 04 pode ampliar o gerador.

No `.env`, `CARGA_CLIENTS` e `CARGA_MESSAGES` alteram as quantidades;
`CARGA_ROOM_ID` e `CARGA_ROOM_KEY` permitem direcionar o teste para outra sala.
O gerador usa exclusivamente o contrato documentado. Também pode ser executado
com Node.js 22+ via `node scripts/carga.mjs`; as opções vêm do ambiente do processo.

## Limites do protótipo

- Apelidos representam identificação simulada, sem contas ou autenticação comercial.
- Chave privada autoriza a entrada; quem conhece a chave pode entrar. Não há
  revogação de membros ou edição da chave nesta versão.
- Salas e chaves existem somente na memória daquele servidor; reiniciar apaga
  as salas criadas. A Geral é recriada. Após perder uma sala, escolha Geral ou
  crie outra. Chaves guardadas na aba não recriam o catálogo do servidor.
- Não há histórico no servidor. Cada aba mantém até 300 mensagens de cada uma
  das 20 salas mais recentes que recebeu; sair ou recarregar limpa esse estado.
- O catálogo local admite até 2.000 salas, incluindo Geral.
- O `ok` de envio confirma aceitação/publicação, não gravação nem recebimento
  por todos. Eventos durante uma desconexão podem ser perdidos.
- A ordem mostrada é a de chegada, sem garantia de ordem global entre nós.
- Presence, balanceador, armazenamento compartilhado e expansão automática
  continuam separados do trabalho desta entrega.

## Desenvolvimento nativo e verificações

Referência: Elixir 1.20.5 com Erlang/OTP 27. Com ambos instalados:

```console
mix local.hex --force
mix local.rebar --force
mix setup
mix phx.server
```

As variáveis nativas são `PORT`, `BIND_IP`, `NODE_LABEL` e, opcionalmente,
`SECRET_KEY_BASE` (pelo menos 64 bytes). `.env` não é lido automaticamente no
modo nativo. O instalador `phx_new` não é necessário para um projeto já pronto.

Verificações do código:

```console
mix test --warnings-as-errors
mix format --check-formatted
```

Com Docker, use `docker compose run --rm -e MIX_ENV=test chat mix test`.
A confirmação HTTP pode ser feita em http://localhost:4000/health.

## Referências oficiais

- Phoenix Channels: https://hexdocs.pm/phoenix/channels.html
- Autorização de entrada: https://hexdocs.pm/phoenix/Phoenix.Channel.html
- Docker Compose: https://docs.docker.com/reference/cli/docker/compose/up/
- Elixir: https://elixir-lang.org/install.html
- Docker: https://docs.docker.com/get-started/get-docker/
