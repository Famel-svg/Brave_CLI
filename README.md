# brave-cli-control

CLI Rust para inspecionar e controlar páginas do Brave local por Chrome DevTools Protocol (CDP) ou extensão Manifest V3. Inspeção sem screenshots: texto, controles visíveis e árvore de acessibilidade.

## Objetivo do projeto

Permitir que um agente de IA navegue **junto com você na sua sessão existente do Brave**: entender a página atual, seguir links ou navegar quando solicitado e ajudar em pesquisas como notícias recentes. O projeto não cria um usuário novo nem copia silenciosamente seu perfil.

A extensão pode compartilhar uma aba da sessão autenticada depois que você a conecta explicitamente. O modo CDP direto funciona somente com uma instância do Brave iniciada com depuração remota habilitada. Se usar diretório de dados separado, essa instância não herda os logins do seu perfil habitual.

A inspeção usa DOM visível, controles, geometria e árvore de acessibilidade. Não representa pixels de canvas, quadros de vídeo, conteúdo oculto ou fora da tela, interface do navegador nem outras janelas. Pesquisa de notícias, verificação de fontes e citações pertencem ao fluxo do agente; o bridge oferece estado do navegador, inspeção, navegação e abertura de abas.

## Extensão para compartilhar uma aba da sessão atual

A extensão Manifest V3 foi projetada para compartilhar uma aba do perfil Brave já autenticado. A configuração Native Messaging e a recuperação automática do token ainda não foram validadas ponta a ponta no Brave deste projeto; o histórico inclui `token mismatch` e host Native Messaging não encontrado. Trate esta rota como experimental até confirmar a conexão no seu perfil. Ela só anexa após o clique em **Attach to current tab**. A permissão `debugger` é ampla; conecte apenas a aba que quer compartilhar e desconecte ao terminar.

Compile a CLI:

```powershell
cargo install --path .
```

Carregue `extension/` sem compactação em `brave://extensions`, copie o ID mostrado e instale o Native Messaging host:

```powershell
brave-cli native-host-install --extension-id <id>
```

Configure o servidor MCP no Codex e reinicie o cliente:

```json
{
  "mcpServers": {
    "brave-browser": {
      "command": "C:\\Users\\<user>\\.cargo\\bin\\brave-cli.exe",
      "args": ["mcp", "--extension-id", "<extension-id>"]
    }
  }
}
```

O host local foi implementado para fornecer à extensão o token atual e evitar cópia manual. A ponte WebSocket fica vinculada a `127.0.0.1` e valida o ID da extensão. A validação de destino IP local/privado é aplicada pelo MCP direto, não pela rota da extensão. Remova o registro Native Messaging com `brave-cli native-host-uninstall`.

## MCP direto via CDP: sem extensão

Use se o Brave **já** estiver expondo um endpoint CDP local:

```powershell
brave-cli mcp --cdp-url http://127.0.0.1:9222
```

O MCP lista as abas HTTP(S) públicas; selecione explicitamente uma com `browser_select_tab` antes de inspecionar ou navegar. O modo direto não expõe ferramentas MCP para JavaScript arbitrário, cookies, storage, credenciais, cliques ou envio de formulários. CDP continua sendo uma interface de alto privilégio para processos locais que alcançam sua porta. A CLI aceita somente endpoints loopback e não inicia nem reinicia o Brave.

CDP não consegue anexar depois a um processo que iniciou sem depuração remota. O comando com `--user-data-dir` abre um perfil separado e persistente; ele não usa sua sessão autenticada habitual. A documentação do Chrome 136+ exige diretório de dados não padrão para essas flags do Chrome; não assuma que a mesma regra ou versão vale para toda versão do Brave. [Referência oficial do Chrome](https://developer.chrome.com/blog/remote-debugging-port).

Configuração MCP:

```json
{
  "mcpServers": {
    "brave-browser": {
      "command": "C:\\Users\\<user>\\.cargo\\bin\\brave-cli.exe",
      "args": ["mcp", "--cdp-url", "http://127.0.0.1:9222"]
    }
  }
}
```

## Problemas encontrados e estado atual

Durante a configuração no Windows, a extensão apresentou `ERR_CONNECTION_REFUSED` quando não havia processo escutando em `127.0.0.1:9229`. Depois que a ponte Rust iniciou, ela recebeu conexões, mas recusou a autenticação com `token mismatch`: o token salvo na extensão não correspondia ao token esperado pela ponte. O mecanismo de recuperação então falhou com `Specified native messaging host not found.`

O executável Native Messaging respondeu ao teste local do protocolo, e o manifesto e os registros do Windows apontavam para o manifesto esperado. Isso não provou que o Brave conseguia localizar e iniciar o host; a recuperação dentro do contexto da extensão permaneceu sem validação ponta a ponta. Nunca coloque valores de token em logs, README, commits ou mensagens de suporte.

Foi adicionado MCP direto por CDP para eliminar extensão, Native Messaging e token compartilhado desse caminho. No teste feito, o Brave abriu um perfil separado, o endpoint `127.0.0.1:9222` respondeu e o MCP completou inicialização e listagem de ferramentas. A lista de abas veio vazia porque a página inicial era `about:blank`, que o modo direto exclui. Isso valida o transporte e o handshake MCP no perfil de teste, mas não a conexão à sessão autenticada habitual.

A porta `9229` era da ponte WebSocket antiga, não do CDP. Sem endpoint CDP já ativo, o modo direto não conecta. Ativar CDP na sessão habitual pode exigir reiniciar o navegador e não é garantido pelas regras de segurança do Chromium; usar diretório separado cria outra sessão. O projeto não copia nem altera seu perfil automaticamente.

## Inspecionar sem screenshots

```powershell
brave-cli inspect
brave-cli inspect --format json --max-nodes 800
brave-cli inspect --format dom
```

A inspeção retorna título, URL, viewport, rolagem, elemento focado, texto visível, controles/mídia visíveis com retângulos e árvore de acessibilidade. Valores de controles de formulário não são incluídos. A saída tem limites e redige padrões sensíveis comuns no restante do texto. Não mostra pixels do canvas, quadros de vídeo, interface do navegador, outras janelas ou conteúdo fora da tela.

## Conectar e controlar uma instância de teste

Perfil isolado opcional para teste; não reutiliza a sessão habitual:

```powershell
brave.exe --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\brave-cli-control\profile" about:blank
brave-cli doctor
brave-cli tabs
brave-cli start
brave-cli --allow-domain example.com tab open https://example.com
brave-cli --allow-domain example.com navigate https://example.com
brave-cli --allow-domain example.com click 'button#submit' --confirm
brave-cli --allow-domain example.com fill '#name' 'Rafael' --confirm
```

A configuração vem de `--config config.toml`, depois da variável `BRAVE_CLI_CDP_URL`, e recebe as allowlists passadas na CLI e em `BRAVE_CLI_ALLOWED_DOMAINS`. Navegação e abertura de abas exigem domínio exato ou subdomínio permitido. `click` e `fill` exigem `--confirm` para operações arriscadas. Todo JavaScript executado no contexto da página exige confirmação e não é uma sandbox; não execute scripts não confiáveis. `--dry-run` não conecta nem altera estado.

Exemplo `config.toml`:

```toml
[brave_cli]
cdp_url = "http://127.0.0.1:9222"
allowed_domains = ["example.com"]
```

## Por que snapshots CDP

`DOMSnapshot.captureSnapshot` expõe DOM achatado, layout e estilos selecionados; `Accessibility.getFullAXTree` fornece papéis e nomes semânticos. Esta implementação combina árvore de acessibilidade, texto e métricas visíveis, sem OCR ou captura de tela. Visibilidade calculada pelo DOM pode diferir dos pixels renderizados; canvas, vídeo e interface nativa ficam fora do escopo.

## Build e testes

```powershell
cargo fmt --check
cargo test
cargo build --release
```

Os comandos de teste CDP ao vivo abaixo são instruções manuais, não evidência de teste automatizado. Valide-os em perfil Brave descartável. A conexão com a sessão pessoal depende da extensão ou de um endpoint CDP que já esteja ativo e precisa ser verificada no Brave-alvo.

## Funcionalidades da CLI

A CLI Rust também inclui `start`, `tabs`, `navigate`, `tab open`, `click`, `fill`, `evaluate` e workflows YAML. Captura de screenshot é um comando opcional (`page screenshot`) para navegador explicitamente habilitado para CDP; `inspect` retorna texto e árvore sem screenshots. `start` usa perfil isolado.

```powershell
brave-cli evaluate 'document.title'
brave-cli page screenshot page.png
brave-cli --allow-domain example.com run workflows/example.yaml --dry-run
```

## Migração

A CLI Rust está em `Cargo.toml` e `src-rust/`. A implementação Python em `src/brave_cli/` permanece para comparação até a paridade e a cobertura de testes justificarem sua remoção.
