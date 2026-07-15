# Salvatore — Compras persistentes

Projeto pronto para **Cloudflare Pages + D1**, conectado a um repositório GitHub.

## O que fica salvo no banco

- Itens da Cozinha, Pizzaria, Bar, Vinhos e Salão
- Estoque mínimo de cada item
- Itens criados, editados e removidos no painel administrativo
- Quantidade atual preenchida por data, sem necessidade de login ou PIN
- Dados compartilhados entre celulares e computadores

O GitHub guarda o código. O D1 guarda os dados alterados no uso diário.


## Acesso

- `/`: público, sem login e sem PIN
- `/admin.html`: protegido pelo `ADMIN_TOKEN`

Qualquer pessoa que conheça o endereço principal poderá alterar as quantidades do dia.

## Endereços

- Aplicativo da equipe: `/`
- Painel administrativo: `/admin.html`

## Deploy pelo GitHub e Cloudflare

### 1. Criar o repositório

Crie um repositório no GitHub, por exemplo:

`salvatore-compras`

Envie todo o conteúdo desta pasta para a raiz do repositório.

Pelo terminal:

```bash
git init
git add .
git commit -m "Aplicativo de compras do Salvatore"
git branch -M main
git remote add origin URL_DO_REPOSITORIO
git push -u origin main
```

### 2. Criar o banco D1

No painel Cloudflare:

1. Acesse **Storage & Databases**
2. Abra **D1 SQL Database**
3. Crie um banco chamado `salvatore-compras`

Não é necessário executar SQL manualmente. O aplicativo cria as tabelas e inclui os itens iniciais no primeiro acesso.

### 3. Criar o projeto Pages

No painel Cloudflare:

1. Abra **Workers & Pages**
2. Escolha **Create application**
3. Selecione **Pages**
4. Conecte o repositório do GitHub
5. Configure:
   - Framework preset: `None`
   - Build command: deixe vazio
   - Build output directory: `public`
6. Faça o primeiro deploy

### 4. Conectar o D1

No projeto Pages:

1. Abra **Settings**
2. Entre em **Bindings**
3. Adicione um binding do tipo **D1 database**
4. Variable name: `DB`
5. Escolha o banco `salvatore-compras`
6. Salve

### 5. Criar os segredos

No projeto Pages, em **Settings > Variables and Secrets**, crie:

- `ADMIN_TOKEN`: senha forte usada em `/admin.html`

Depois, faça um novo deploy em **Deployments > Retry deployment**.

## Como usar

### Equipe

1. Abra o endereço principal
2. Preencha somente os itens conferidos
3. Toque em **Calcular e enviar no WhatsApp**

### Administração

1. Abra `/admin.html`
2. Informe o `ADMIN_TOKEN`
3. Crie, edite ou remova itens
4. A mudança aparece imediatamente para todos, sem novo deploy

## Segurança

- Não coloque o `ADMIN_TOKEN` no GitHub.
- Configure-o somente como secret no painel Cloudflare.
- O painel administrativo exige o token em todas as alterações.
- O aplicativo principal é público: qualquer pessoa com o link pode preencher e salvar quantidades.


## Aba Vinhos

Esta versão inclui o setor `vinhos`.

Após o deploy:

- a aba **Vinhos** aparece na página principal;
- o painel administrativo permite criar ou mover itens para **Vinhos**;
- o item inicial **Vinhos italianos** é movido automaticamente do Bar para Vinhos;
- o banco existente é migrado automaticamente no primeiro acesso;
- itens e estoques já existentes são preservados.


## Organização de estoque aplicada

Esta versão contém **122 itens padrão**, organizados em:

- Cozinha
- Pizzaria
- Bar
- Vinhos
- Salão

A página principal exibe cabeçalhos de categoria dentro de cada aba.

### Farinhas separadas

- `Farinha para massa fresca e lasanha` — Cozinha
- `Farinha italiana tipo 00 para pizza` — Pizzaria

### Vinhos individuais

Os 19 vinhos informados foram cadastrados individualmente e divididos em:

- Tintos na carta
- Tintos fora da carta
- Brancos
- Rosés

O estoque mínimo inicial dos vinhos foi definido como 2 garrafas, exceto o Brunello
di Montalcino, definido como 1 garrafa. Esses mínimos podem ser alterados no painel
administrativo.

### Migração

O primeiro acesso após o deploy:

- renomeia itens antigos sem perder o histórico diário;
- remove itens padrão obsoletos;
- insere os novos itens;
- preserva itens personalizados criados pelo administrador;
- não exige apagar ou recriar o banco D1.


## Subabas de categorias

Cada setor possui agora subabas dinâmicas.

Exemplo na Cozinha:

- Hortifruti
- Carnes e pescados
- Queijos e laticínios
- Massas, grãos e secos
- Molhos, temperos e bebidas culinárias
- Sobremesas
- Embalagens e operação

As subabas são geradas a partir do campo `category` dos itens cadastrados no D1.
Portanto:

- ao criar um item em uma categoria existente, ele aparece nessa subaba;
- ao criar um item com uma categoria nova, uma nova subaba aparece automaticamente;
- ao remover o último item de uma categoria, a subaba desaparece;
- não é necessário novo deploy para criar uma nova subcategoria pelo painel administrativo.

A pesquisa procura em todas as subcategorias do setor selecionado.


## Coluna de custo

Foi adicionada a coluna persistente `unit_cost` no D1.

- O custo é cadastrado ou alterado somente no painel `/admin.html`.
- A página principal exibe o custo como leitura.
- O cálculo usa: `quantidade a comprar × custo unitário`.
- O WhatsApp mostra o custo estimado de cada item e o total.
- Itens sem custo continuam funcionando, mas não entram na soma estimada.
- A migração cria a coluna automaticamente, sem apagar itens ou históricos.

## Celular e tablet

A interface agora é responsiva:

- celular: itens em cards de duas colunas;
- tablet: nome do item em uma linha e dados em quatro colunas abaixo;
- abas principais e subcategorias com rolagem horizontal;
- campos e botões maiores para toque;
- painel administrativo em cards no celular.


## Correção do custo unitário

Esta versão corrige a atualização do custo:

- aceita `12,50`, `12.50`, `R$ 12,50` e valores com separador de milhar;
- rejeita custo inválido em vez de apagar silenciosamente;
- retorna ao painel o valor realmente gravado no D1;
- mostra uma confirmação como `custo R$ 12,50`;
- força a recarga sem cache no painel e no aplicativo principal.


## Persistência de preços v3

Os preços são armazenados no D1 como centavos inteiros:

- R$ 12,50 → `1250`
- R$ 100,00 → `10000`

Isso elimina erros de ponto flutuante e de formatação com vírgula.

O painel agora bloqueia a confirmação quando:

- somente a pasta `public` foi atualizada;
- a função `/api/admin` ainda é de uma versão antiga;
- o valor retornado pelo D1 é diferente do valor digitado;
- a listagem não consegue recuperar o preço salvo.

É obrigatório substituir no GitHub as duas pastas:

- `public`
- `functions`


## Correção preço v4

A versão anterior gerava um falso erro quando:

1. o POST salvava o preço e o lia corretamente no D1;
2. uma nova requisição de listagem, feita imediatamente depois, ainda retornava o valor anterior.

Na versão v4:

- a resposta confirmada do D1 atualiza a tabela imediatamente;
- IDs são comparados numericamente;
- os preços são comparados em centavos inteiros;
- a listagem é sincronizada novamente com tentativas progressivas;
- uma leitura atrasada não é mais apresentada como falha de gravação.


## Persistência v5

Esta versão:

- usa `DB.withSession("first-primary")` em leituras e gravações;
- força a leitura mais atual do banco primário;
- mantém escrita e leitura administrativa na mesma sessão;
- cria um identificador persistente para o D1;
- mostra no painel o domínio atual e os primeiros caracteres do identificador;
- avisa explicitamente se leitura e gravação estiverem usando bancos diferentes.

Use o painel somente em:

`https://lista-compras-aiq.pages.dev/admin.html`

O binding `DB` de Production deve apontar para o mesmo banco usado pelo site público.


## Correção crítica de persistência — v6

Foi corrigida a causa real do desaparecimento dos preços.

A migração antiga do setor `vinhos` verificava se existia qualquer `CHECK` na
tabela `items`. Como a tabela também possui `CHECK` nas colunas `minimum_qty`
e `active`, a migração era executada novamente em cada chamada da API.

Durante essa recriação, as colunas de custo eram preenchidas com `NULL`.
Consequência:

1. o painel salvava o preço;
2. a resposta da mesma requisição confirmava o preço;
3. ao recarregar, `ensureDatabase()` recriava a tabela;
4. o preço desaparecia.

Na v6:

- a migração só reconhece o `CHECK` antigo aplicado diretamente ao setor;
- a tabela não é mais recriada em cada requisição;
- custos existentes são preservados durante uma migração legítima;
- `unit_cost_cents` continua sendo a fonte principal do preço.

Os preços que já foram apagados pela versão anterior precisam ser informados
novamente uma única vez após o deploy da v6.


## Gestão diária e CMV — versão v7

A nova página `/cmv.html` registra:

- estoque de abertura;
- compras de mercado;
- mercadorias recebidas de fornecedores;
- forma de pagamento;
- boletos pendentes e vencimento;
- faturamento líquido;
- estoque de fechamento;
- CMV em reais;
- CMV percentual.

### Fórmula

`CMV = estoque inicial + compras recebidas − estoque final`

As compras recebidas são separadas em:

- mercado;
- fornecedores.

### Boleto

Mercadoria recebida no boleto entra no CMV na data do recebimento.
O boleto permanece como pendente até ser marcado como pago.

O pagamento futuro não cria outra compra e não altera novamente o CMV.

### Inventário congelado

A abertura e o fechamento guardam:

- quantidade;
- custo unitário daquele momento;
- valor do item;
- responsável;
- data e horário.

Alterar o custo de um item no futuro não modifica fechamentos anteriores.

### Itens fora do CMV

O painel administrativo possui a opção `Incluir no CMV`.
Materiais do salão, limpeza e embalagens ficam fora por padrão.


## Salvamento explícito do estoque — v8

O botão fixo da página de estoque agora é `Salvar estoque do dia`.

- Digitar uma quantidade altera apenas o estado local.
- O botão mostra quantas alterações estão pendentes.
- Todas as alterações são enviadas juntas para o D1.
- Trocar de aba ou subcategoria não apaga valores ainda não salvos.
- Trocar de data com alterações pendentes pede confirmação.
- O botão de WhatsApp foi removido do rodapé.
- A API `/api/stock` aceita salvamento em lote.

A abertura e o fechamento continuam sendo realizados em `/cmv.html`,
depois que o estoque correspondente for salvo.


## Navegação principal — versão v9

As três páginas exibem as mesmas abas no topo:

- `Estoque` → `/`
- `CMV` → `/cmv`
- `Admin` → `/admin`

A página atual fica destacada. As páginas antigas `/cmv.html` e
`/admin.html` continuam disponíveis para compatibilidade.


## Cadastro hierárquico no Admin — versão v10

O cadastro e a listagem seguem obrigatoriamente:

1. Setor
2. Categoria do setor
3. Produto

No cadastro, o campo Categoria mostra somente categorias pertencentes ao setor
selecionado. Também existe a opção `Criar nova categoria`.

Na listagem, o usuário seleciona primeiro o setor e depois uma categoria
daquele setor. A tabela exibe somente os produtos da categoria atual.


## Filtro de CMV por período — versão v11

A página `/cmv` agora possui dois controles distintos:

- `Data operacional`: usada para lançar compras, faturamento, abertura e
  fechamento de um dia específico.
- `Relatório por período`: usa data inicial e data final.

O relatório mostra:

- CMV acumulado;
- faturamento considerado;
- CMV percentual;
- compras de mercado;
- recebimentos de fornecedores;
- boletos pendentes;
- quantidade de dias completos;
- detalhamento diário.

O percentual acumulado usa somente dias que possuem estoque de abertura e
estoque de fechamento. Dias incompletos aparecem como `Pendente` e são
informados ao usuário.

O período máximo por consulta é de 366 dias.


## Abas separadas — versão v12

A navegação principal agora possui quatro abas, nesta ordem:

1. Abertura-Fechamento — `/cmv`
2. Estoque — `/`
3. Relatório CMV — `/relatorio-cmv`
4. Admin — `/admin`

### Abertura-Fechamento

Contém apenas a operação de uma data:

- abertura do estoque;
- fechamento do estoque;
- compras de mercado;
- mercadorias recebidas de fornecedores;
- faturamento do dia;
- CMV diário.

### Relatório CMV

Página separada para consulta por data inicial e data final:

- CMV acumulado;
- faturamento considerado;
- CMV percentual;
- compras;
- fornecedores;
- boletos pendentes;
- detalhamento por dia.


## Fechamento como abertura — versão v13

A rotina diária foi simplificada:

1. No primeiro dia, é feita uma abertura manual.
2. No fim do dia, é feita a contagem física completa e salvo o fechamento.
3. No dia seguinte, o sistema cria automaticamente a abertura usando o
   último fechamento anterior.
4. Uma nova abertura manual fica disponível apenas para exceções.

A cópia mantém exatamente:

- itens;
- quantidades;
- custos unitários congelados;
- valores;
- total do estoque;
- quantidade de itens sem custo.

A abertura registra a data do fechamento usado como origem.

Quando não existe fechamento anterior, o sistema informa que é necessária
uma contagem manual de abertura.


## Somente fechamento diário — versão v14

A abertura foi removida da operação.

A rotina agora é:

1. Registrar compras de mercado e mercadorias recebidas.
2. Registrar o faturamento líquido.
3. No fim do dia, contar todo o estoque.
4. Salvar o fechamento.

O CMV diário é calculado por:

`fechamento do dia anterior + compras do dia - fechamento do dia atual`

O primeiro fechamento cria somente a base. O primeiro CMV diário aparece
quando também existir o fechamento do dia seguinte.

Para evitar um cálculo incorreto, o sistema exige o fechamento da data
imediatamente anterior. Se faltar um fechamento, o dia fica pendente no
relatório.


## Correção de atualização visual — versão v14.1

A página de fechamento exibe a identificação visível:

`SOMENTE FECHAMENTO`

Também foi configurado `Cache-Control: no-store` para impedir que o
navegador continue exibindo páginas HTML de versões anteriores.

Depois do deploy, a página `/cmv` não deve conter:

- Abertura do dia;
- Substituir pelo último fechamento anterior;
- Abertura manual.

Ela deve conter apenas:

- Fechamento anterior;
- Compras do dia;
- Fechamento atual;
- CMV;
- Faturamento;
- Contar estoque final;
- Salvar fechamento do dia.


## Correção de build — versão v14.2

Foi removido o trecho órfão de `functions/api/daily.js` que causava:

`Expected "finally" but found "if"`

A versão mantém o fluxo `SOMENTE FECHAMENTO`.


## Admin sem filtros — versão v15

Os filtros de setor e categoria foram removidos da listagem.

Todos os produtos aparecem juntos, ordenados por:

1. setor;
2. categoria;
3. ordem;
4. nome.

O cadastro continua seguindo `Setor → Categoria → Produto`.


## Valor total do estoque — versão v16

A página de estoque agora mostra dois valores no rodapé:

1. `Valor total do estoque do dia`
2. `Custo estimado da reposição`

O valor do estoque é calculado por item:

`quantidade atual × custo unitário`

O total considera todos os setores, e não apenas a aba atualmente aberta.

Itens com quantidade maior que zero e sem custo cadastrado não entram no
valor financeiro e são informados ao lado do total.


## Download CSV no Admin — versão v17

O botão `Baixar CSV` exporta todos os produtos com as colunas:

- Item
- Setor
- Categoria
- Unidade
- Estoque mínimo
- Custo unitário

O arquivo usa separador `;`, codificação UTF-8 com BOM e formato numérico
compatível com Excel em português.


## Interface mobile — versão v18

As quatro áreas foram ajustadas para celulares:

- navegação principal em grade 2 × 2;
- cabeçalho compacto e não fixo;
- campos com 16 px para evitar zoom automático no iPhone;
- botões com área mínima de toque de 48 px;
- respeito às áreas seguras do aparelho;
- tabelas transformadas em cards;
- formulários em uma coluna;
- resumos financeiros em duas colunas;
- abas de setor e categoria com rolagem horizontal;
- campo de estoque atual maior e destacado;
- rodapé de estoque adequado aos dois totais;
- botão `Topo` no Admin para listas longas;
- botão de CSV em largura total no celular.

O comportamento desktop e tablet foi preservado.

## PWA v19

Instalável como `Salvatore Gestão`, com ícone, tela cheia, service worker,
página offline e atalhos para Estoque, Fechamento, Relatório CMV e Admin.
